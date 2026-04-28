import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  systemPreferences,
} from 'electron';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EngineClient, resolveEnginePath } from './engine-client.js';
import { BUILTIN_PROVIDERS, CUSTOM_PROVIDERS, resolveProviderEndpoint } from './providers/config.js';
import {
  defaultMcpServers,
} from './chatwise/protocol.js';
import { killElectronExecChildren, registerElectronExecIpc, registerElectronFetchIpc } from './chatwise/transport.js';
import {
  getGitBranches,
  getGitDefaultBranch,
  getGitDiffFileContent,
  getGitDiffFiles,
  getGitDiffStat,
  runProcess,
  switchGitBranch,
  workDirFrom,
} from './chatwise/git.js';

type ApiType = 'anthropic-messages' | 'openai-completions';
type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default';

interface DesktopSettings {
  providerId: string;
  apiType: ApiType;
  model: string;
  apiKey: string;
  baseURL: string;
  cwd: string;
  permissionMode: PermissionMode;
  maxTurns: number;
  allowedTools: string[];
  appendSystemPrompt: string;
}

interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  createdAt: number;
  meta?: Record<string, unknown>;
}

interface SendRequest {
  chatId: string;
  prompt: string;
  settings?: Partial<DesktopSettings>;
}

interface McpServerRecord {
  id: string;
  displayId: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  autoRun: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  apiKey: string;
  type: string;
  config: Record<string, unknown>;
  icon: string;
  createdAt: number;
  updatedAt: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientDir = join(__dirname, 'client');

let mainWindow: BrowserWindow | null = null;
const activeRuns = new Map<string, AbortController>();
let sqliteDatabase: any | null = null;

// ---- Engine (opencc CLI as subprocess) ----
let engine: EngineClient | null = null;

async function getEngine(): Promise<EngineClient> {
  if (!engine) {
    engine = new EngineClient(resolveEnginePath());
    engine.start();
    await engine.waitReady();
  }
  return engine;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'client',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts);
}

function defaultSettings(): DesktopSettings {
  return {
    providerId: 'openai',
    apiType: 'openai-completions',
    model: process.env.CODEANY_MODEL || 'gpt-4o',
    apiKey: process.env.CODEANY_API_KEY || '',
    baseURL: process.env.CODEANY_BASE_URL || 'https://api.openai.com/v1',
    cwd: process.cwd() || homedir(),
    permissionMode: 'bypassPermissions',
    maxTurns: 10,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
    appendSystemPrompt:
      'You are AutoAgent, a desktop coding agent. Prefer concise answers, preserve user files, and ask before destructive or external actions.',
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function loadSettings(): Promise<DesktopSettings> {
  const settings = await readJson<DesktopSettings>(userDataPath('settings.json'), defaultSettings());
  return normalizeSettings(settings);
}

function normalizeSettings(input: Partial<DesktopSettings>): DesktopSettings {
  const base = { ...defaultSettings(), ...input };
  const endpoint = resolveProviderEndpoint(base.providerId, {
    apiKey: base.apiKey,
    [`${base.providerId}_api_key`]: base.apiKey,
    [`${base.providerId}_api_url`]: base.baseURL,
  });

  if (!base.baseURL && endpoint.url) base.baseURL = endpoint.url;
  base.apiType = base.providerId === 'anthropic' ? 'anthropic-messages' : base.apiType || inferApiType(base.model);
  base.maxTurns = Math.max(1, Math.min(50, Number(base.maxTurns) || 10));
  base.allowedTools = Array.isArray(base.allowedTools) ? base.allowedTools : defaultSettings().allowedTools;
  return base;
}

function inferApiType(model: string): ApiType {
  return model.toLowerCase().includes('claude') ? 'anthropic-messages' : 'openai-completions';
}

async function providerCatalog() {
  const stored = await listProvidersFromDatabase().catch(() => []);
  const custom = [...CUSTOM_PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    models: provider.models,
    allowCustomModels: provider.allowCustomModels,
  }))];
  for (const provider of stored) {
    const index = custom.findIndex((entry) => entry.id === provider.id);
    const entry = {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      models: provider.models,
      allowCustomModels: true,
    };
    if (index >= 0) custom[index] = { ...custom[index], ...entry };
    else custom.push(entry);
  }
  return {
    builtin: BUILTIN_PROVIDERS,
    custom,
  };
}

async function listChats(): Promise<ChatRecord[]> {
  const dir = userDataPath('sessions');
  if (!existsSync(dir)) return [];
  const chats: ChatRecord[] = [];
  const files = await readdir(dir);
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    chats.push(await readJson<ChatRecord>(join(dir, file), emptyChat(file.replace(/\.json$/, ''))));
  }
  return chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

function emptyChat(id: string = crypto.randomUUID()): ChatRecord {
  const now = Date.now();
  return {
    id,
    title: 'New session',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

async function loadChat(id: string): Promise<ChatRecord> {
  return readJson<ChatRecord>(userDataPath('sessions', `${id}.json`), emptyChat(id));
}

async function saveChat(chat: ChatRecord): Promise<ChatRecord> {
  chat.updatedAt = Date.now();
  await writeJson(userDataPath('sessions', `${chat.id}.json`), chat);
  return chat;
}

async function appendMessage(chatId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatRecord> {
  const chat = await loadChat(chatId);
  chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...message });
  if (chat.title === 'New session' && message.role === 'user') {
    chat.title = message.text.trim().slice(0, 60) || chat.title;
  }
  return saveChat(chat);
}

function extractEngineText(event: any): string {
  if (!event?.event) return '';
  const ev = event.event;
  // Assistant message with content blocks
  if (ev.type === 'assistant' && ev.message?.content) {
    return ev.message.content
      .map((block: any) => {
        if (block.type === 'text') return block.text || '';
        if (block.type === 'tool_use') return `[tool:${block.name}] ${JSON.stringify(block.input)}`;
        if (block.type === 'thinking') return block.thinking || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  // Text delta from streaming
  if (ev.type === 'text_delta') return ev.text || '';
  return '';
}


function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(channel, payload);
}

async function resolveClientFile(pathname: string, fallback = 'index'): Promise<string | null> {
  const requested = join(clientDir, decodeURIComponent(pathname));
  const rel = relative(clientDir, requested);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;

  async function probe(path: string): Promise<string | null> {
    try {
      if (!path.endsWith('/') && !extname(path)) {
        const htmlPath = `${path}.html`;
        if (existsSync(htmlPath)) return htmlPath;
      }
      const info = await stat(path);
      if (info.isFile()) return path;
      if (info.isDirectory()) return probe(join(path, `${fallback}.html`));
    } catch {
      return null;
    }
    return null;
  }

  return probe(requested);
}

function registerClientProtocol(): void {
  protocol.handle('client', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'app-files') {
      const path = url.searchParams.get('path');
      if (!path) return new Response('missing path', { status: 404 });
      return net.fetch(pathToFileURL(userDataPath('files', path)).toString());
    }
    if (url.hostname === 'file') {
      const path = url.searchParams.get('path');
      if (!path) return new Response('missing path', { status: 404 });
      return net.fetch(pathToFileURL(path).toString());
    }
    if (url.hostname !== 'app') {
      return new Response('hostname mismatch', { status: 404 });
    }

    const fallback = join(clientDir, 'index.html');
    const resolved = await resolveClientFile(url.pathname);
    if (!resolved && extname(url.pathname) && extname(url.pathname) !== '.html') {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved || fallback).toString());
  });
}

async function getSqliteDatabase(): Promise<any> {
  if (sqliteDatabase) return sqliteDatabase;
  const sqlite = await Function('return import("node:sqlite")')();
  const DatabaseSync = sqlite.DatabaseSync;
  sqliteDatabase = new DatabaseSync(userDataPath('chatwise.db'));
  sqliteDatabase.exec('PRAGMA journal_mode = WAL');
  sqliteDatabase.exec('PRAGMA foreign_keys = ON');
  await migrateChatwiseDatabase(sqliteDatabase);
  return sqliteDatabase;
}

async function migrateChatwiseDatabase(database: any): Promise<void> {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat (
      id TEXT PRIMARY KEY NOT NULL,
      createdAt INTEGER NOT NULL,
      title TEXT NOT NULL,
      model TEXT,
      lastReplyAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT);
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY NOT NULL,
      chatId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      content TEXT NOT NULL,
      role TEXT NOT NULL,
      model TEXT,
      files TEXT
    );
    CREATE INDEX IF NOT EXISTS message_chatId_idx ON message (chatId);
    CREATE TABLE IF NOT EXISTS assistant (
      id TEXT PRIMARY KEY NOT NULL,
      createdAt INTEGER NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT,
      model TEXT,
      temperature REAL,
      systemInstruction TEXT,
      replyLanguage TEXT,
      truncateMessages TEXT
    );
    CREATE TABLE IF NOT EXISTS prompt (
      id TEXT PRIMARY KEY NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER,
      displayId TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      variables TEXT,
      model TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS prompt_displayId_unique ON prompt (displayId);
    CREATE TABLE IF NOT EXISTS provider (
      id TEXT PRIMARY KEY NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER,
      name TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      models TEXT,
      apiKey TEXT,
      type TEXT DEFAULT 'openai',
      config TEXT,
      icon TEXT
    );
    CREATE TABLE IF NOT EXISTS tool (
      id TEXT PRIMARY KEY NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER,
      displayId TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER,
      autoRun INTEGER,
      excludedTools TEXT,
      oauthClient TEXT,
      oauthTokens TEXT,
      lastFetchedTools TEXT,
      displayName TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tool_displayId_unique ON tool (displayId);
  `);

  const columns: Record<string, string[]> = {
    chat: [
      'webSearch INTEGER',
      'systemInstruction TEXT',
      'temperature REAL',
      'favoritedAt INTEGER',
      'replyLanguage TEXT',
      'truncateMessages TEXT',
      'assistantId TEXT',
      'renderMath INTEGER',
      'artifacts INTEGER',
      'reasoningEffort TEXT',
      'maxOutputTokens INTEGER',
      'updatedAt INTEGER',
      'toolEnabled INTEGER',
      'toolIds TEXT',
      'mcpEnabled INTEGER',
      'mcpServerIds TEXT',
      'imageGenEnabled INTEGER',
      'imageGenOptions TEXT',
      'webSearchOptions TEXT',
      'meta TEXT',
      'agentModeEnabled INTEGER',
      'agentOptions TEXT',
    ],
    message: [
      'webSearchResult TEXT',
      'citations TEXT',
      'timeToFirstToken INTEGER',
      'timeToFinish INTEGER',
      'reasoningContent TEXT',
      'reasoningTime INTEGER',
      'webSearchModel TEXT',
      'updatedAt INTEGER',
      'meta TEXT',
      'generatedFiles TEXT',
    ],
    assistant: [
      'renderMath INTEGER',
      'displayId TEXT',
      'webSearch INTEGER',
      'artifacts INTEGER',
      'reasoningEffort TEXT',
      'maxOutputTokens INTEGER',
      'updatedAt INTEGER',
      'showInSidebar INTEGER',
      'toolEnabled INTEGER',
      'toolIds TEXT',
      'mcpEnabled INTEGER',
      'mcpServerIds TEXT',
      'imageGenEnabled INTEGER',
      'imageGenOptions TEXT',
      'webSearchOptions TEXT',
      'agentModeEnabled INTEGER',
      'agentOptions TEXT',
    ],
    provider: ['type TEXT DEFAULT "openai"', 'config TEXT', 'icon TEXT'],
    prompt: ['model TEXT'],
    tool: ['excludedTools TEXT', 'oauthClient TEXT', 'oauthTokens TEXT', 'lastFetchedTools TEXT', 'displayName TEXT'],
  };

  for (const [table, defs] of Object.entries(columns)) {
    for (const def of defs) {
      try {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
      } catch {
        // SQLite has no portable ADD COLUMN IF NOT EXISTS across all Electron builds.
      }
    }
  }
  try {
    database.exec('CREATE INDEX IF NOT EXISTS chat_assistantId_idx ON chat (assistantId)');
    database.exec('CREATE INDEX IF NOT EXISTS message_generatedFiles_idx ON message (generatedFiles)');
  } catch {}
}

async function runReadQuery(method: 'get' | 'all', sql: string, params: unknown[] = []): Promise<unknown> {
  const database = await getSqliteDatabase();
  const statement = database.prepare(sql);
  if (method === 'get') return statement.get(...params);
  return statement.all(...params);
}

async function runWriteQuery(sql: string, params: unknown[] = []): Promise<{ rowsAffected: number; lastInsertRowid: unknown }> {
  const database = await getSqliteDatabase();
  const result = database.prepare(sql).run(...params);
  return {
    rowsAffected: Number(result.changes || 0),
    lastInsertRowid: result.lastInsertRowid,
  };
}

function safeJsonObject(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  const type = typeof config.type === 'string' ? config.type : 'stdio';
  if (type === 'http' || type === 'sse') {
    return {
      type,
      url: typeof config.url === 'string' ? config.url.trim() : '',
      headers: safeJsonObject(config.headers, {}),
    };
  }

  const command = typeof config.command === 'string' ? config.command.trim() : '';
  const args =
    Array.isArray(config.args) ? config.args.map(String) : typeof config.args === 'string' ? config.args.split(/\s+/).filter(Boolean) : [];
  const env = typeof config.env === 'string' ? parseEnvLines(config.env) : safeJsonObject(config.env, {});
  return { type: 'stdio', command, args, env };
}

function parseEnvLines(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function parseMcpRow(row: any): McpServerRecord {
  return {
    id: String(row.id),
    displayId: String(row.displayId),
    displayName: String(row.displayName || row.displayId),
    config: safeJsonObject(row.config, {}),
    enabled: !!row.enabled,
    autoRun: !!row.autoRun,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || row.createdAt || 0),
  };
}

async function listMcpServersFromDatabase(): Promise<McpServerRecord[]> {
  const database = await getSqliteDatabase();
  return database
    .prepare('SELECT id, createdAt, updatedAt, displayId, config, enabled, autoRun, displayName FROM tool ORDER BY createdAt ASC')
    .all()
    .map(parseMcpRow);
}

async function loadEnabledMcpServerConfigs(): Promise<Record<string, unknown>> {
  const servers = await listMcpServersFromDatabase();
  const enabled: Record<string, unknown> = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    const config = normalizeMcpConfig(server.config);
    if ((config.type === 'http' || config.type === 'sse') && !config.url) continue;
    if (config.type === 'stdio' && !config.command) continue;
    enabled[server.displayId] = config;
  }
  return enabled;
}

async function saveMcpServer(input: Partial<McpServerRecord>): Promise<McpServerRecord> {
  const database = await getSqliteDatabase();
  const now = Date.now();
  const displayId = String(input.displayId || input.id || '').trim();
  if (!displayId) throw new Error('MCP displayId is required');
  const id = String(input.id || `mcp-${displayId}`);
  const config = normalizeMcpConfig(input.config || {});
  const displayName = String(input.displayName || displayId);
  const enabled = input.enabled ? 1 : 0;
  const autoRun = input.autoRun ? 1 : 0;

  database
    .prepare(
      `INSERT INTO tool (id, createdAt, updatedAt, displayId, config, enabled, autoRun, displayName)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(displayId) DO UPDATE SET
         updatedAt=excluded.updatedAt,
         config=excluded.config,
         enabled=excluded.enabled,
         autoRun=excluded.autoRun,
         displayName=excluded.displayName`,
    )
    .run(id, now, now, displayId, JSON.stringify(config), enabled, autoRun, displayName);

  const row = database
    .prepare('SELECT id, createdAt, updatedAt, displayId, config, enabled, autoRun, displayName FROM tool WHERE displayId = ?')
    .get(displayId);
  return parseMcpRow(row);
}

async function toggleMcpServer(input: { id?: string; displayId?: string; enabled: boolean }): Promise<McpServerRecord> {
  const database = await getSqliteDatabase();
  const now = Date.now();
  const key = input.id || input.displayId;
  if (!key) throw new Error('MCP server id is required');
  database
    .prepare('UPDATE tool SET enabled = ?, updatedAt = ? WHERE id = ? OR displayId = ?')
    .run(input.enabled ? 1 : 0, now, key, key);
  const row = database
    .prepare('SELECT id, createdAt, updatedAt, displayId, config, enabled, autoRun, displayName FROM tool WHERE id = ? OR displayId = ?')
    .get(key, key);
  if (!row) throw new Error(`MCP server not found: ${key}`);
  return parseMcpRow(row);
}

function parseProviderModels(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((model) => {
          if (typeof model === 'string') return model;
          if (model && typeof model === 'object') return String((model as { id?: unknown; modelId?: unknown }).id || (model as any).modelId || '');
          return '';
        })
        .filter(Boolean);
    }
  } catch {}
  return value
    .split(/\r?\n|,/)
    .map((model) => model.trim())
    .filter(Boolean);
}

function parseProviderRow(row: any): ProviderRecord {
  return {
    id: String(row.id),
    name: String(row.name || row.id),
    baseUrl: String(row.baseUrl || ''),
    models: parseProviderModels(row.models),
    apiKey: String(row.apiKey || ''),
    type: String(row.type || 'openai'),
    config: safeJsonObject(row.config, {}),
    icon: String(row.icon || ''),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || row.createdAt || 0),
  };
}

async function listProvidersFromDatabase(): Promise<ProviderRecord[]> {
  const database = await getSqliteDatabase();
  return database
    .prepare('SELECT id, createdAt, updatedAt, name, baseUrl, models, apiKey, type, config, icon FROM provider ORDER BY createdAt ASC')
    .all()
    .map(parseProviderRow);
}

async function getProviderFromDatabase(providerId: string): Promise<ProviderRecord | null> {
  const database = await getSqliteDatabase();
  const row = database
    .prepare('SELECT id, createdAt, updatedAt, name, baseUrl, models, apiKey, type, config, icon FROM provider WHERE id = ? OR type = ?')
    .get(providerId, providerId);
  return row ? parseProviderRow(row) : null;
}

async function saveProvider(input: Partial<ProviderRecord>): Promise<ProviderRecord> {
  const database = await getSqliteDatabase();
  const now = Date.now();
  const id = String(input.id || '').trim();
  if (!id) throw new Error('Provider id is required');
  const name = String(input.name || id).trim();
  const type = String(input.type || (id.startsWith('cus_') ? id.slice(4) : id)).trim();
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/chat\/completions$/, '');
  const models = parseProviderModels(input.models).sort();
  database
    .prepare(
      `INSERT INTO provider (id, createdAt, updatedAt, name, baseUrl, models, apiKey, type, config, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         updatedAt=excluded.updatedAt,
         name=excluded.name,
         baseUrl=excluded.baseUrl,
         models=excluded.models,
         apiKey=excluded.apiKey,
         type=excluded.type,
         config=excluded.config,
         icon=excluded.icon`,
    )
    .run(
      id,
      now,
      now,
      name,
      baseUrl,
      JSON.stringify(models),
      String(input.apiKey || ''),
      type,
      JSON.stringify(input.config || {}),
      String(input.icon || 'terminal'),
    );
  const saved = await getProviderFromDatabase(id);
  if (!saved) throw new Error(`Provider not found after save: ${id}`);
  return saved;
}

async function discoverMcpTools(input?: { id?: string; displayId?: string; enabledOnly?: boolean }) {
  const servers = await listMcpServersFromDatabase();
  const selected = servers.filter((server) => {
    if (input?.id || input?.displayId) return server.id === input.id || server.displayId === input.displayId;
    return input?.enabledOnly === false || server.enabled;
  });
  const results = [];
  for (const server of selected) {
    const startedAt = Date.now();
    const config = normalizeMcpConfig(server.config);
    let connection: Awaited<ReturnType<typeof connectMCPServer>> | null = null;
    try {
      connection = await connectMCPServer(server.displayId, config as any);
      results.push({
        id: server.id,
        displayId: server.displayId,
        status: connection.status,
        durationMs: Date.now() - startedAt,
        tools: connection.tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || null,
        })),
      });
    } catch (error) {
      results.push({
        id: server.id,
        displayId: server.displayId,
        status: 'error',
        durationMs: Date.now() - startedAt,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
  return results;
}

async function collectFiles(root: string, limit = 500, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  let entries: any[];
  try {
    entries = (await readdir(join(root, prefix), { withFileTypes: true } as any)) as any[];
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (output.length >= limit) break;
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(root, limit - output.length, relPath)));
    } else {
      output.push(relPath);
    }
  }
  return output;
}

async function runAgent(request: SendRequest): Promise<{ runId: string }> {
  const baseSettings = await loadSettings();
  const settings = normalizeSettings({ ...baseSettings, ...request.settings });
  await writeJson(userDataPath('settings.json'), settings);

  const runId = crypto.randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, abortController);
  await appendMessage(request.chatId, { role: 'user', text: request.prompt });

  void (async () => {
    let assistantText = '';
    try {
      const eng = await getEngine();
      sendToWindow('agent:event', { runId, chatId: request.chatId, kind: 'start' });

      const messages = [
        { role: 'user', content: request.prompt },
      ];

      for await (const ev of eng.query({
        model: settings.model,
        maxTurns: settings.maxTurns,
        cwd: settings.cwd,
        appendSystemPrompt: settings.appendSystemPrompt,
        messages,
      })) {
        const text = extractEngineText(ev);
        if (ev.type === 'assistant' && text) assistantText = text;
        if (abortController.signal.aborted) break;
        sendToWindow('agent:event', { runId, chatId: request.chatId, kind: ev.type, text, event: ev });
      }

      if (assistantText.trim()) {
        await appendMessage(request.chatId, { role: 'assistant', text: assistantText });
      }
      sendToWindow('agent:event', { runId, chatId: request.chatId, kind: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendMessage(request.chatId, { role: 'system', text: message, meta: { level: 'error' } });
      sendToWindow('agent:event', { runId, chatId: request.chatId, kind: 'error', text: message });
    } finally {
      activeRuns.delete(runId);
    }
  })();

  return { runId };
}

function createWavBuffer(samples: number[], sampleRate = 44100): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, 44 + index * 2);
  }
  return buffer;
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 870,
    minWidth: 960,
    minHeight: 640,
    title: 'AutoAgent',
    icon: join(__dirname, '../assets/icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL('client://app/');
}

ipcMain.handle('app:bootstrap', async () => ({
  settings: await loadSettings(),
  providers: await providerCatalog(),
  chats: await listChats(),
  mcpServers: await listMcpServersFromDatabase(),
  managedProviders: await listProvidersFromDatabase(),
  chatwise: {
    defaultMcpServers,
  },
}));

ipcMain.handle('settings:save', async (_event, settings: Partial<DesktopSettings>) => {
  const normalized = normalizeSettings(settings);
  await writeJson(userDataPath('settings.json'), normalized);
  return normalized;
});

ipcMain.handle('provider:resolve', async (_event, providerId: string, current: Partial<DesktopSettings> = {}) => {
  const stored = await getProviderFromDatabase(providerId);
  if (stored) {
    return {
      providerId: stored.id,
      apiType: stored.type === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      baseURL: stored.baseUrl,
      apiKey: stored.apiKey || current.apiKey,
      models: stored.models,
    };
  }
  const endpoint = resolveProviderEndpoint(providerId, {
    apiKey: current.apiKey,
    [`${providerId}_api_url`]: current.baseURL,
  });
  return {
    providerId,
    apiType: providerId === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    baseURL: endpoint.url,
  };
});

ipcMain.handle('dialog:select-cwd', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select workspace',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('chat:create', async () => saveChat(emptyChat()));
ipcMain.handle('chat:load', async (_event, id: string) => loadChat(id));
ipcMain.handle('chat:list', async () => listChats());
ipcMain.handle('agent:send', async (_event, request: SendRequest) => runAgent(request));
ipcMain.handle('agent:stop', async (_event, runId: string) => {
  activeRuns.get(runId)?.abort();
  return { stopped: true };
});
ipcMain.handle('shell:open-external', async (_event, url: string) => shell.openExternal(url));

ipcMain.handle('mcp:list', async () => listMcpServersFromDatabase());
ipcMain.handle('mcp:save', async (_event, input: Partial<McpServerRecord>) => saveMcpServer(input));
ipcMain.handle('mcp:toggle', async (_event, input: { id?: string; displayId?: string; enabled: boolean }) =>
  toggleMcpServer(input),
);
ipcMain.handle('mcp:discover', async (_event, input?: { id?: string; displayId?: string; enabledOnly?: boolean }) =>
  discoverMcpTools(input),
);
ipcMain.handle('mcp:delete', async (_event, input: { id?: string; displayId?: string }) => {
  const database = await getSqliteDatabase();
  const key = input.id || input.displayId;
  if (!key) throw new Error('MCP server id is required');
  const result = database.prepare('DELETE FROM tool WHERE id = ? OR displayId = ?').run(key, key);
  return { deleted: Number(result.changes || 0) };
});
ipcMain.handle('provider:list', async () => listProvidersFromDatabase());
ipcMain.handle('provider:save', async (_event, input: Partial<ProviderRecord>) => saveProvider(input));
ipcMain.handle('provider:delete', async (_event, input: { id: string }) => {
  const database = await getSqliteDatabase();
  const result = database.prepare('DELETE FROM provider WHERE id = ?').run(input.id);
  return { deleted: Number(result.changes || 0) };
});
ipcMain.handle('workspace:git-status', async (_event, input?: { cwd?: string; workDir?: string; base?: string }) => {
  const root = workDirFrom(input) || (await loadSettings()).cwd;
  const [statResult, branchesResult, filesResult] = await Promise.allSettled([
    getGitDiffStat({ ...input, workDir: root }),
    getGitBranches({ workDir: root }),
    getGitDiffFiles({ ...input, workDir: root }),
  ]);
  return {
    workDir: root,
    stat: statResult.status === 'fulfilled' ? statResult.value : null,
    branches: branchesResult.status === 'fulfilled' ? branchesResult.value : [],
    files: filesResult.status === 'fulfilled' ? filesResult.value : [],
    errors: [statResult, branchesResult, filesResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason))),
  };
});

ipcMain.handle('getAccentColor', () => systemPreferences.getAccentColor());
ipcMain.handle('getLocalSettings', async () => ({
  ...(await loadSettings()),
  ...(await readJson<Record<string, unknown>>(userDataPath('local-settings.json'), {})),
}));
ipcMain.on('setWindowBackground', (event, color: string) => {
  BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(color);
});
ipcMain.on('windowReady', () => undefined);

ipcMain.handle('showSettingsWindow', async (_event, input?: { url?: string }) => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.webContents.send('navigate', input?.url || '/settings');
  }
});
ipcMain.handle('showCurrentWindow', async (event, input?: { focus?: boolean }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.show();
  if (input?.focus) window?.focus();
});
ipcMain.handle('focusCurrentWindow', async (event) => BrowserWindow.fromWebContents(event.sender)?.focus());
ipcMain.handle('getDir', async (_event, input: { type: string }) => {
  if (input.type === 'app-data') return app.getPath('userData');
  if (input.type === 'home') return homedir();
  if (input.type === 'temp') return app.getPath('temp');
  if (input.type === 'logs') return app.getPath('logs');
  return '';
});
ipcMain.handle('getShellEnv', async () => process.env);
ipcMain.handle('appCacheGet', async (_event, input: { key: string }) => {
  const path = userDataPath('cache', `${input.key}.json`);
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
});
ipcMain.handle('appCacheSet', async (_event, input: { key: string; value: string }) => {
  const path = userDataPath('cache', `${input.key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.value, 'utf8');
});
ipcMain.handle('osInfo', async () => ({ platform: process.platform, arch: process.arch, version: process.version }));
ipcMain.handle('dbGet', async (_event, input: { sql: string; params?: unknown[] }) =>
  runReadQuery('get', input.sql, input.params),
);
ipcMain.handle('dbAll', async (_event, input: { sql: string; params?: unknown[] }) =>
  runReadQuery('all', input.sql, input.params),
);
ipcMain.handle('dbExecute', async (_event, input: { sql: string; params?: unknown[] }) =>
  runWriteQuery(input.sql, input.params),
);
ipcMain.handle('invalidateQueryClient', async (_event, input?: unknown) => {
  sendToWindow('invalidateQueryClient', input || {});
});
ipcMain.handle('discoverSkill', async (_event, input?: { cwd?: string; workDir?: string; workDirectory?: string; query?: string }) => {
  const root = workDirFrom(input) || (await loadSettings()).cwd;
  const files = await collectFiles(root, 250);
  return files
    .filter((file) => /(^|\/)(skills?|\.codex|\.agents)\//i.test(file) || /SKILL\.md$/i.test(file))
    .map((file) => ({ id: file, name: file.split('/').pop()?.replace(/\.md$/i, '') || file, path: join(root, file) }));
});
ipcMain.handle('glob', async (_event, input?: { cwd?: string; workDir?: string; workDirectory?: string; pattern?: string; limit?: number }) => {
  const root = workDirFrom(input) || (await loadSettings()).cwd;
  const needle = (input?.pattern || '').replace(/\*/g, '').toLowerCase();
  const files = await collectFiles(root, input?.limit || 500);
  return needle ? files.filter((file) => file.toLowerCase().includes(needle)) : files;
});
ipcMain.handle('globTool', async (_event, input?: { cwd?: string; workDir?: string; workDirectory?: string; pattern?: string; limit?: number }) => {
  const root = workDirFrom(input) || (await loadSettings()).cwd;
  const files = await collectFiles(root, input?.limit || 500);
  return { files: input?.pattern ? files.filter((file) => file.includes(input.pattern!.replace(/\*/g, ''))) : files };
});
ipcMain.handle('grep', async (_event, input?: { cwd?: string; workDir?: string; workDirectory?: string; query?: string; pattern?: string; include?: string; limit?: number }) => {
  const root = workDirFrom(input) || (await loadSettings()).cwd;
  const query = input?.query || input?.pattern || '';
  if (!query) return [];
  const result = await runProcess('rg', ['--line-number', '--no-heading', '--color', 'never', query, input?.include || '.'], root);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, input?.limit || 200)
    .map((line) => {
      const [path, lineNumber, ...rest] = line.split(':');
      return { path, line: Number(lineNumber), text: rest.join(':') };
    });
});
ipcMain.handle('getGitDefaultBranch', async (_event, input?: { cwd?: string; workDir?: string }) =>
  getGitDefaultBranch(input),
);
ipcMain.handle('getGitBranches', async (_event, input?: { cwd?: string; workDir?: string }) => getGitBranches(input));
ipcMain.handle('getGitDiffStat', async (_event, input?: { cwd?: string; workDir?: string; base?: string }) =>
  getGitDiffStat(input),
);
ipcMain.handle('getGitDiffFiles', async (_event, input?: { cwd?: string; workDir?: string; base?: string }) =>
  getGitDiffFiles(input),
);
ipcMain.handle(
  'getGitDiffFileContent',
  async (_event, input: { cwd?: string; workDir?: string; filePath: string; headPath?: string; currentPath?: string }) =>
    getGitDiffFileContent(input),
);
ipcMain.handle('switchGitBranch', async (_event, input: { cwd?: string; workDir?: string; branch: string }) =>
  switchGitBranch(input),
);
ipcMain.handle('initGitRepository', async (_event, input?: { cwd?: string; workDir?: string }) => {
  const result = await runProcess('git', ['init'], workDirFrom(input));
  return { ok: result.code === 0, ...result };
});
ipcMain.handle('openPathWithProgram', async (_event, input: { path: string; program?: string }) => {
  if (!input.program || input.program === 'default') return shell.openPath(input.path);
  const result = await runProcess(input.program, [input.path]);
  return result.code === 0 ? '' : result.stderr || result.stdout;
});
ipcMain.handle('sendNotification', async (_event, input?: { title?: string; body?: string }) => {
  if (!input?.title && !input?.body) return false;
  new Notification({ title: input.title || 'AutoAgent', body: input.body || '' }).show();
  return true;
});
ipcMain.handle('setLoggerEnabled', async () => undefined);
ipcMain.handle('setTrackingEnabled', async () => undefined);
ipcMain.handle('changeLanguage', async () => undefined);
ipcMain.handle('applyTheme', async () => undefined);
ipcMain.handle('initFonts', async () => undefined);
ipcMain.handle('isBinDownloaded', async () => true);
ipcMain.handle('downloadBin', async () => ({ ok: true }));
ipcMain.handle('ensureBinVersion', async () => ({ ok: true }));
ipcMain.handle('bunInstallInTempFolder', async () => ({ ok: true }));
ipcMain.handle('startOauthServer', async () => ({ ok: true }));
ipcMain.handle('stopOauthServer', async () => ({ ok: true }));
ipcMain.handle('readTextFile', async (_event, input: { path: string }) => readFile(input.path, 'utf8'));
ipcMain.handle('readFileAsBase64', async (_event, input: { path: string }) => readFile(input.path, 'base64'));
ipcMain.handle('readFileBinary', async (_event, input: { path: string }) => Uint8Array.from(await readFile(input.path)));
ipcMain.handle('readFile', async (_event, input: { path: string }) => Uint8Array.from(await readFile(input.path)));
ipcMain.handle('readDir', async (_event, input: { path: string }) => readdir(input.path));
ipcMain.handle('saveRecordingAsWav', async (_event, input: { filename: string; buffer: number[]; sampleRate?: number }) => {
  const path = userDataPath('recordings', input.filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, createWavBuffer(input.buffer || [], input.sampleRate || 44100));
  return path;
});
ipcMain.handle('resolveInAppDataDir', async (_event, input?: { args?: string[] }) =>
  input?.args?.length ? userDataPath(...input.args) : app.getPath('userData'),
);
ipcMain.handle('resolveInAppFiles', async (_event, input: { path?: string; id?: string } | string) => {
  const relativePath = typeof input === 'string' ? input : input.path || input.id || '';
  return userDataPath('files', relativePath);
});
ipcMain.handle('pathExists', async (_event, input: { path: string }) => existsSync(input.path));
ipcMain.handle('ensureDir', async (_event, input: { path: string }) => mkdir(input.path, { recursive: true }));
ipcMain.handle('writeTextFile', async (_event, input: { path: string; content: string }) => {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, input.content, 'utf8');
});
ipcMain.handle('writeFile', async (_event, input: { path: string; content: ArrayBuffer | Uint8Array | number[] | string }) => {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, Buffer.from(input.content as any));
});
ipcMain.handle('removePath', async (_event, input: { path: string }) => rm(input.path, { recursive: true, force: true }));
ipcMain.handle('pathStats', async (_event, input: { path: string }) => {
  const info = await stat(input.path);
  return { isDir: info.isDirectory(), size: info.size };
});
ipcMain.handle('createDir', async (_event, input: { path: string }) => mkdir(input.path, { recursive: true }));
ipcMain.handle('copyFile', async (_event, input: { src: string; dest: string }) => {
  await mkdir(dirname(input.dest), { recursive: true });
  await copyFile(input.src, input.dest);
});
ipcMain.handle('zipFolder', async (_event, input: { folder: string; outputPath: string }) => {
  const result = await runProcess('zip', ['-qry', input.outputPath, '.'], input.folder);
  if (result.code !== 0) throw new Error(result.stderr || 'zip failed');
  return input.outputPath;
});
ipcMain.handle('unzipFile', async (_event, input: { zipPath: string; outputDir: string }) => {
  await mkdir(input.outputDir, { recursive: true });
  const result = await runProcess('unzip', ['-qq', input.zipPath, '-d', input.outputDir]);
  if (result.code !== 0) throw new Error(result.stderr || 'unzip failed');
  return input.outputDir;
});
ipcMain.handle('openPath', async (_event, input: { path: string }) => shell.openPath(input.path));
ipcMain.handle('openExternalUrl', async (_event, input: { url: string }) => shell.openExternal(input.url));
ipcMain.handle('showInFolder', async (_event, input: { path: string }) => shell.showItemInFolder(input.path));
ipcMain.handle('copyImageToClipboard', async (_event, input: { data: ArrayBuffer | Uint8Array | number[] }) => {
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(input.data as any)));
});
ipcMain.handle('copyTextToClipboard', async (_event, input: { data: string }) => clipboard.writeText(input.data));
ipcMain.handle('getClipboardText', async () => clipboard.readText());
ipcMain.handle('showOpenDialog', async (event, input: { title?: string; dirOnly?: boolean; multiple?: boolean; defaultPath?: string }) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const properties: Array<'openFile' | 'openDirectory' | 'createDirectory' | 'multiSelections'> = input.dirOnly
    ? ['openDirectory', 'createDirectory']
    : ['openFile'];
  if (input.multiple) properties.push('multiSelections');
  const result = await dialog.showOpenDialog(window!, {
    title: input.title,
    properties,
    defaultPath: input.defaultPath,
  });
  return result.filePaths;
});
ipcMain.handle('showSaveDialog', async (event, input: { title?: string; defaultPath?: string; filters?: Electron.FileFilter[] }) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const result = await dialog.showSaveDialog(window!, input);
  return result.canceled ? null : result.filePath;
});
ipcMain.handle('showMessageDialog', async (event, input: { title: string; message?: string; type?: Electron.MessageBoxOptions['type'] }) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  await dialog.showMessageBox(window!, { message: input.title, detail: input.message, type: input.type });
});
ipcMain.handle('showConfirmDialog', async (event, input: { title: string; message?: string; type?: Electron.MessageBoxOptions['type'] }) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const result = await dialog.showMessageBox(window!, {
    message: input.title,
    detail: input.message,
    type: input.type,
    buttons: ['Cancel', 'Yes'],
    defaultId: 1,
  });
  return result.response === 1;
});
ipcMain.handle('showContextMenu', async (event, input: { items: any[]; x?: number; y?: number }) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!window) return;
  const toTemplate = (items: any[]): Electron.MenuItemConstructorOptions[] =>
    items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      return {
        id: item.id,
        label: item.text || item.label || '',
        enabled: item.enabled !== false,
        checked: !!item.checked,
        type: item.checked === undefined ? 'normal' : 'checkbox',
        submenu: Array.isArray(item.items) ? toTemplate(item.items) : undefined,
        click: () => event.sender.send('$context-menu-click', { id: item.id }),
      };
    });
  Menu.buildFromTemplate(toTemplate(input.items || [])).popup({ window, x: input.x, y: input.y });
});
ipcMain.handle('saveTheme', async (_event, input: { theme: 'system' | 'light' | 'dark' }) => {
  nativeTheme.themeSource = input.theme;
  await writeJson(userDataPath('local-settings.json'), { ...(await readJson(userDataPath('local-settings.json'), {})), theme: input.theme });
});
ipcMain.handle('saveLocalSettings', async (_event, input: { settings: Record<string, unknown> }) => {
  const existing = await readJson<Record<string, unknown>>(userDataPath('local-settings.json'), {});
  await writeJson(userDataPath('local-settings.json'), { ...existing, ...input.settings });
});
ipcMain.handle('getFonts', async () => []);
ipcMain.handle('setAlwaysOnTop', async (event, input: { value: boolean }) =>
  BrowserWindow.fromWebContents(event.sender)?.setAlwaysOnTop(input.value),
);
ipcMain.handle('getWindowProp', async (event, input: { type: 'is-minimized' | 'is-maximized' }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return input.type === 'is-minimized' ? window?.isMinimized() || false : window?.isMaximized() || false;
});
ipcMain.handle('setWindowProp', async (event, input: { type: 'minimize' | 'maximize' | 'unmaximize' }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (input.type === 'minimize') window?.minimize();
  if (input.type === 'maximize') window?.maximize();
  if (input.type === 'unmaximize') window?.unmaximize();
});
ipcMain.handle('closeWindow', async (event) => BrowserWindow.fromWebContents(event.sender)?.close());

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerElectronFetchIpc(ipcMain);
  registerElectronExecIpc(ipcMain);
  // Start opencc engine subprocess (pre-warm)
  getEngine().catch((err) => console.error('[engine] failed to start:', err));
  registerClientProtocol();
  await getSqliteDatabase();
  await createWindow();
  nativeTheme.themeSource = (await readJson<{ theme?: 'system' | 'light' | 'dark' }>(userDataPath('local-settings.json'), {})).theme || 'system';
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  for (const run of activeRuns.values()) run.abort();
  killElectronExecChildren();
  engine?.stop().catch(() => undefined);
});
