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
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EngineClient, resolveEnginePath } from './engine-client.js';
import { BUILTIN_PROVIDERS, CUSTOM_PROVIDERS, resolveProviderEndpoint } from './providers/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

type ApiType = 'anthropic-messages' | 'codex-completions';
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
  claudeSessionId?: string;
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

// ---- Startup performance tracing ----
const t0 = performance.now();
let tPrev = t0;
function perfMark(label: string): void {
  const now = performance.now();
  console.error(`[perf] +${(now - t0).toFixed(0)}ms (Δ${(now - tPrev).toFixed(0)}ms) ${label}`);
  tPrev = now;
}

const PRODUCT_NAME = 'AutoAgent';
const LINUX_DESKTOP_NAME = 'autoagent';
const WINDOWS_APP_ID = 'com.autoagent.desktop';

// Startup optimizations
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('in-process-gpu');
}
// Windows: disable GPU to avoid ERR_FAILED (-2) caused by GPU cache access
// denied errors (拒绝访问。0x5) in locked-down environments. Also redirect
// the disk cache to %TEMP% to bypass AppData permission restrictions.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disk-cache-dir', join(tmpdir(), 'autoagent-cache'));
  // Override userData to a temp directory so Chromium can create its cache
  // subdirectories without hitting AppData permission issues.
  app.setPath('userData', join(tmpdir(), 'autoagent-userdata'));
}

// Keep Windows/macOS runtime identity aligned with the packaged shortcut/exe
// name, while Linux still uses the desktop file name for WM_CLASS matching.
app.setName(process.platform === 'linux' ? LINUX_DESKTOP_NAME : PRODUCT_NAME);
// Set Wayland desktop name — required for compositor to match .desktop file
if (process.platform === 'linux') {
  (app as typeof app & { setDesktopName?: (name: string) => void }).setDesktopName?.(LINUX_DESKTOP_NAME);
}
// Set AppUserModelId — required for Windows taskbar icon matching
if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_ID);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const clientDir = join(__dirname, 'client');
perfMark('module init done');

let mainWindow: BrowserWindow | null = null;
const activeRuns = new Map<string, AbortController>();
let sqliteDatabase: any | null = null;

// ---- Engine (cli.js -p stream-json headless loop) ----
// `-p` is a mature single-run headless loop. Each desktop turn gets a fresh
// process, while Claude Code's transcript persistence is reused via --resume.
async function getEngine(settings?: DesktopSettings): Promise<EngineClient> {
  if (settings) await syncEngineConfig(settings);
  const next = new EngineClient(resolveEnginePath());
  next.start();
  await next.waitReady();
  return next;
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

function resolveDefaultWorkspaceCwd(): string {
  if (!app.isPackaged) return process.cwd() || homedir();
  return homedir();
}

function resolveRuntimeAssetPath(name: string): string {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, name) : '',
    join(__dirname, name),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] || name;
}

function windowsShortcutCandidates(): string[] {
  const appData = process.env.APPDATA || '';
  const userProfile = process.env.USERPROFILE || homedir();
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  return [
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
    join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
    join(userProfile, 'Desktop', `${PRODUCT_NAME}.lnk`),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${PRODUCT_NAME}.lnk`),
  ];
}

function forceWriteWindowsShortcut(
  shortcutPath: string,
  executablePath: string,
  iconPath: string,
  workingDirectory: string,
  description: string,
): void {
  const escapedPath = shortcutPath.replace(/\\/g, '\\\\');
  const escapedExe = executablePath.replace(/\\/g, '\\\\');
  const escapedIcon = iconPath.replace(/\\/g, '\\\\');
  const escapedCwd = workingDirectory.replace(/\\/g, '\\\\');
  const escapedDesc = description.replace(/"/g, '""');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    [
      '$shell = New-Object -ComObject WScript.Shell',
      `$lnk = $shell.CreateShortcut("${escapedPath}")`,
      `$lnk.TargetPath = "${escapedExe}"`,
      '$lnk.Arguments = ""',
      `$lnk.IconLocation = "${escapedIcon},0"`,
      `$lnk.WorkingDirectory = "${escapedCwd}"`,
      `$lnk.Description = "${escapedDesc}"`,
      '$lnk.Save()',
    ].join('; '),
  ], { windowsHide: true });
}

function repairWindowsShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;

  const iconPath = resolveRuntimeAssetPath('icon.ico');
  const executablePath = process.execPath;
  const workingDirectory = dirname(executablePath);
  const description = `${PRODUCT_NAME} Desktop - AI Agent for coding automation`;

  for (const shortcutPath of windowsShortcutCandidates()) {
    const isPinnedTaskbarShortcut = shortcutPath.includes(join('User Pinned', 'TaskBar'));
    if (isPinnedTaskbarShortcut && !existsSync(shortcutPath)) continue;
    try {
      const operation = existsSync(shortcutPath) ? 'update' : 'create';
      const updated = shell.writeShortcutLink(shortcutPath, operation, {
        target: executablePath,
        cwd: workingDirectory,
        icon: iconPath,
        iconIndex: 0,
        appUserModelId: WINDOWS_APP_ID,
        description,
      });
      if (!updated) throw new Error('shell.writeShortcutLink returned false');
      forceWriteWindowsShortcut(shortcutPath, executablePath, iconPath, workingDirectory, description);
    } catch (error) {
      console.error('[shortcut] shell.writeShortcutLink failed, falling back to WSH:', shortcutPath, error);
      forceWriteWindowsShortcut(shortcutPath, executablePath, iconPath, workingDirectory, description);
    }
  }
}

function defaultSettings(): DesktopSettings {
  return {
    providerId: 'deepseek',
    apiType: 'anthropic-messages',
    model: process.env.CODEANY_MODEL || 'deepseek-v4-pro[1m]',
    apiKey: process.env.CODEANY_API_KEY || '',
    baseURL: process.env.CODEANY_BASE_URL || 'https://api.deepseek.com/anthropic',
    cwd: resolveDefaultWorkspaceCwd(),
    permissionMode: 'bypassPermissions',
    maxTurns: 1024,
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
  if (!base.cwd || !existsSync(base.cwd)) base.cwd = resolveDefaultWorkspaceCwd();
  base.maxTurns = Math.max(1, Number(base.maxTurns) || 1024);
  base.allowedTools = Array.isArray(base.allowedTools) ? base.allowedTools : defaultSettings().allowedTools;
  return base;
}

function inferApiType(model: string): ApiType {
  return 'anthropic-messages';
}

function providerCatalog() {
  // Static provider catalog — no DB registry needed.
  // Agent tab's Provider dropdown reads builtin + custom directly.
  return {
    builtin: BUILTIN_PROVIDERS.map(p => ({ id: p.id, name: p.name })),
    custom: CUSTOM_PROVIDERS.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      models: p.models,
      allowCustomModels: p.allowCustomModels,
    })),
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

async function deleteChat(id: string): Promise<void> {
  await rm(userDataPath('sessions', `${id}.json`), { force: true });
}

async function appendMessage(chatId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): Promise<ChatRecord> {
  const chat = await loadChat(chatId);
  chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), ...message });
  if (chat.title === 'New session' && message.role === 'user') {
    chat.title = message.text.trim().slice(0, 60) || chat.title;
  }
  return saveChat(chat);
}

async function updateClaudeSessionId(chatId: string, claudeSessionId: string): Promise<void> {
  const chat = await loadChat(chatId);
  chat.claudeSessionId = claudeSessionId;
  await saveChat(chat);
}

function extractEngineText(event: any): string {
  if (!event) return '';
  // Direct text from text_delta stream events
  if (event.type === 'text_delta') {
    if (event.event?.delta) return event.event.delta;
    if (event.text) return event.text;
  }
  if (event.type === 'result') {
    if (typeof event.event?.result === 'string') return event.event.result;
    if (typeof event.result === 'string') return event.result;
  }
  // Direct text from a completed item
  if (event.type === 'assistant' || event.type === 'tool_result') {
    if (event.event?.item?.text) return event.event.item.text;
    if (event.event?.item?.content) {
      const c = event.event.item.content;
      if (typeof c === 'string') return c;
    }
  }
  // Legacy format fallback
  if (event?.event) {
    const ev = event.event;
    if (ev.type === 'assistant' && ev.message?.content) {
      return ev.message.content
        .map((block: any) => {
          if (block.type === 'text') return block.text || '';
          if (block.type === 'thinking') return block.thinking || '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (ev.type === 'result' && typeof ev.result === 'string') return ev.result;
    if (ev.type === 'text_delta') return ev.text || ev.delta || '';
  }
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
      type TEXT DEFAULT 'codex',
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
    provider: ['type TEXT DEFAULT "codex"', 'config TEXT', 'icon TEXT'],
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

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.length > 0) output[key] = entry;
  }
  return output;
}

function processEnvRecord(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function requestInitFromConfig(config: Record<string, unknown>): RequestInit {
  const headers = stringRecord(config.headers);
  return Object.keys(headers).length > 0 ? { headers } : {};
}

async function connectMCPServer(displayId: string, config: Record<string, unknown>) {
  const client = new Client({ name: `autoagent-${displayId}`, version: '0.1.0' }, { capabilities: {} });
  let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

  if (config.type === 'http') {
    if (typeof config.url !== 'string' || !config.url.trim()) throw new Error('MCP HTTP server URL is required');
    transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: requestInitFromConfig(config) });
  } else if (config.type === 'sse') {
    if (typeof config.url !== 'string' || !config.url.trim()) throw new Error('MCP SSE server URL is required');
    const requestInit = requestInitFromConfig(config);
    transport = new SSEClientTransport(new URL(config.url), {
      requestInit,
      eventSourceInit: Object.keys(stringRecord(config.headers)).length > 0 ? { fetch: (url, init) => fetch(url, { ...init, ...requestInit }) } : undefined,
    });
  } else {
    if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('MCP stdio command is required');
    transport = new StdioClientTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: { ...processEnvRecord(), ...stringRecord(config.env) },
      stderr: 'pipe',
    });
  }

  await client.connect(transport);
  const toolsResult = await client.listTools();
  return {
    status: 'connected',
    tools: toolsResult.tools || [],
    close: async () => {
      await Promise.allSettled([(client as any).close?.(), transport.close()]);
    },
  };
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
  const chatBeforeTurn = await loadChat(request.chatId);

  const runId = crypto.randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, abortController);
  await appendMessage(request.chatId, { role: 'user', text: request.prompt });

  void (async () => {
    let assistantText = '';
    try {
      const eng = await getEngine(settings);
      sendToWindow('agent:event', { runId, chatId: request.chatId, kind: 'start' });

      // The engine persists a thread across queries — context accumulates
      // across turns within the server process (system prompt, tools, message
      // history, file cache). We only send the latest prompt; the server's
      // QueryEngine appends it to its mutableMessages.
      for await (const ev of eng.query({
        model: settings.model,
        maxTurns: settings.maxTurns,
        cwd: settings.cwd,
        appendSystemPrompt: settings.appendSystemPrompt,
        resumeSessionId: chatBeforeTurn.claudeSessionId,
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        providerId: settings.providerId,
        apiType: settings.apiType,
        allowedTools: settings.allowedTools,
        messages: [{ role: 'user', content: request.prompt }],
        signal: abortController.signal,
      })) {
        // Error events carry their message in ev.error, not in the event body
        const text = ev.type === 'error' ? (ev.error || 'Unknown error') : extractEngineText(ev);
        if (ev.type === 'text_delta' && text) assistantText += text;
        if (ev.type === 'assistant' && text) assistantText = text;
        if (ev.type === 'result' && text && !assistantText.trim()) assistantText = text;
        if (ev.type === 'result' && typeof ev.event?.session_id === 'string') {
          await updateClaudeSessionId(request.chatId, ev.event.session_id);
        }
        if (abortController.signal.aborted) break;

        // Map server event types to renderer-friendly kinds
        const kind =
          ev.type === 'text_delta' ? 'partial_message' :
          ev.type === 'assistant' ? 'assistant' :
          ev.type === 'tool_start' || ev.type === 'tool_result' ? 'tool_result' :
          ev.type === 'result' ? 'done' :
          ev.type === 'interrupted' ? 'done' :
          ev.type === 'error' ? 'error' :
          ev.type;
        sendToWindow('agent:event', { runId, chatId: request.chatId, kind, text, event: ev });
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
  const iconPath = resolveRuntimeAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const runtimeWindowIconPath = resolveRuntimeAssetPath('icon.png');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 870,
    minWidth: 1000,
    minHeight: 640,
    title: PRODUCT_NAME,
    icon: iconPath,
    // Linux: match window to autoagent.desktop for correct dock/taskbar icon
    // Windows: icon.ico used for taskbar (paired with setAppUserModelId)
    // macOS: icon.png works natively
    ...(process.platform === 'linux' ? { desktopFileName: LINUX_DESKTOP_NAME } : {}),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 18 } } : {}),
    // Hide until fully rendered — avoids flash, feels faster
    show: false,
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  perfMark('BrowserWindow created');
  if (process.platform === 'win32') {
    mainWindow.setIcon(nativeImage.createFromPath(runtimeWindowIconPath));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Show window once fully rendered (GPU paint done)
  mainWindow.once('ready-to-show', () => {
    console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms ready-to-show`);
    mainWindow!.show();
  });

  // Fine-grained load timing
  mainWindow.webContents.on('did-start-loading', () => {
    console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms did-start-loading`);
  });
  mainWindow.webContents.on('dom-ready', () => {
    console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms dom-ready`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms did-finish-load`);
  });

  // loadFile is the standard Electron approach for local HTML.
  // GPU is disabled on Windows (see module-level commandLine switches) to
  // work around ERR_FAILED (-2) caused by GPU disk cache permission errors.
  const loadStart = performance.now();
  await mainWindow.loadFile(join(clientDir, 'index.html'));
  console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms (Δ${(performance.now() - loadStart).toFixed(0)}ms) loadURL done`);
}

// Sync provider settings to ~/.autoagent.json so the CLI engine can read them
async function syncEngineConfig(settings: DesktopSettings): Promise<void> {
  const t = performance.now();
  const configPath = join(homedir(), '.autoagent', '.claude.json');
  try {
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(configPath, 'utf8');
      existing = JSON.parse(raw);
    } catch {}
    const apiKey = settings.apiKey || (typeof existing.primaryApiKey === 'string' ? existing.primaryApiKey : '');
    const normalizedKey = apiKey ? apiKey.slice(-20) : '';
    const existingApproved: string[] = (existing.customApiKeyResponses as any)?.approved || [];
    const merged = {
      ...existing,
      primaryApiKey: apiKey,
      customApiKeyResponses: {
        ...((existing.customApiKeyResponses as any) || {}),
        approved: normalizedKey && !existingApproved.includes(normalizedKey)
          ? [...existingApproved, normalizedKey]
          : existingApproved,
      },
      env: {
        ...((existing.env as Record<string, string>) || {}),
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: settings.baseURL || '',
      },
    };
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    console.error(`[perf] syncEngineConfig done in ${(performance.now() - t).toFixed(0)}ms`);
  } catch (err) {
    console.error('[config] failed to sync engine config:', err);
  }
}

ipcMain.handle('app:bootstrap', async () => {
  const t = performance.now();
  const [settings, chats, mcpServers] = await Promise.all([
    loadSettings(),
    listChats(),
    listMcpServersFromDatabase(),
  ]);
  console.error(`[perf] bootstrap IPC: loadSettings=${(performance.now() - t).toFixed(0)}ms`);
  return {
    settings,
    providers: providerCatalog(),
    chats,
    mcpServers,
    chatwise: { defaultMcpServers },
  };
});

ipcMain.handle('settings:save', async (_event, settings: Partial<DesktopSettings>) => {
  const normalized = normalizeSettings(settings);
  await writeJson(userDataPath('settings.json'), normalized);
  await syncEngineConfig(normalized);
  return normalized;
});

ipcMain.handle('provider:resolve', async (_event, providerId: string, current: Partial<DesktopSettings> = {}) => {
  // Use built-in/custom provider config directly — no DB registry needed.
  // Agent tab's Provider dropdown reads from BUILTIN_PROVIDERS + CUSTOM_PROVIDERS.
  const endpoint = resolveProviderEndpoint(providerId, {
    apiKey: current.apiKey,
    [`${providerId}_api_url`]: current.baseURL,
  });
  const apiType = providerId === 'codex' ? 'codex-completions' : 'anthropic-messages';
  // Collect models from CUSTOM_PROVIDERS if available
  const custom = CUSTOM_PROVIDERS.find(p => p.id === providerId || p.type === providerId);
  return {
    providerId,
    apiType,
    baseURL: endpoint.url || current.baseURL || '',
    models: custom?.models || [],
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
ipcMain.handle('chat:delete', async (_event, id: string) => {
  await deleteChat(id);
  return { deleted: true };
});
ipcMain.handle('chat:branch', async (_event, id: string) => {
  const parent = await loadChat(id);
  const branch = emptyChat();
  branch.title = `${parent.title} (branch)`;
  branch.messages = parent.messages.map((m: ChatMessage) => ({
    id: crypto.randomUUID(),
    role: m.role,
    text: m.text,
    createdAt: Date.now(),
  }));
  return saveChat(branch);
});
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
// ---- Skill scanner ----
interface SkillEntry {
  name: string;
  description: string;
  path: string;
  source: 'system' | 'project';
  enabled: boolean;
}

const enabledSkills = new Set<string>();

// Persist enabled skills to disk
async function loadEnabledSkills(): Promise<void> {
  try {
    const data = await readFile(userDataPath('skills.json'), 'utf8');
    for (const name of JSON.parse(data)) enabledSkills.add(name);
  } catch {}
}
async function saveEnabledSkills(): Promise<void> {
  await writeJson(userDataPath('skills.json'), [...enabledSkills]);
}

async function scanSkills(cwd: string): Promise<{ skills: SkillEntry[]; dirs: Array<{ path: string; source: 'system' | 'project'; exists: boolean }> }> {
  const home = homedir();
  const systemDirs = [
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
  ];
  const projectDir = join(cwd, '.claude', 'skills');

  const dirs = [
    ...systemDirs.map((path) => ({ path, source: 'system' as const, exists: existsSync(path) })),
    { path: projectDir, source: 'project' as const, exists: existsSync(projectDir) },
  ];

  const skills: SkillEntry[] = [];

  async function collectFromDir(baseDir: string, source: 'system' | 'project'): Promise<void> {
    if (!existsSync(baseDir)) return;
    let entries: any[];
    try {
      entries = await readdir(baseDir, { withFileTypes: true } as any);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(baseDir, entry.name);
      if (entry.isDirectory()) {
        // Directory with SKILL.md inside
        const skillMd = join(fullPath, 'SKILL.md');
        const altMd = join(fullPath, 'skill.md');
        const mdPath = existsSync(skillMd) ? skillMd : existsSync(altMd) ? altMd : null;
        if (mdPath) {
          try {
            const content = await readFile(mdPath, 'utf-8');
            const name = entry.name;
            const desc = extractSkillDescription(content);
            skills.push({
              name,
              description: desc || 'Skill: ' + name,
              path: fullPath,
              source,
              enabled: enabledSkills.has(name),
            });
          } catch {}
        }
      } else if (entry.isFile() && (entry.name === 'SKILL.md' || entry.name.endsWith('.md'))) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          const name = entry.name === 'SKILL.md'
            ? baseDir.split('/').pop() || 'root-skill'
            : entry.name.replace(/\.md$/i, '');
          const desc = extractSkillDescription(content);
          skills.push({
            name,
            description: desc || 'Skill: ' + name,
            path: fullPath,
            source,
            enabled: enabledSkills.has(name),
          });
        } catch {}
      }
    }
  }

  for (const dir of dirs) {
    if (dir.exists) await collectFromDir(dir.path, dir.source);
  }

  // Deduplicate by name (project skills override system skills)
  const seen = new Set<string>();
  const deduped: SkillEntry[] = [];
  for (const skill of [...skills].reverse()) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    deduped.unshift(skill);
  }

  return { skills: deduped, dirs };
}

function extractSkillDescription(content: string): string {
  // Extract description from YAML frontmatter or first heading
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) return descMatch[1].trim();
  }
  // Fallback: first non-empty line after frontmatter
  const afterFM = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
  const firstLine = afterFM.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  return firstLine ? firstLine.trim().slice(0, 120) : '';
}

ipcMain.handle('skill:list', async (_event, cwd?: string) => {
  return scanSkills(cwd || (await loadSettings()).cwd || process.cwd());
});

ipcMain.handle('skill:toggle', async (_event, name: string, enabled: boolean) => {
  if (enabled) {
    enabledSkills.add(name);
  } else {
    enabledSkills.delete(name);
  }
  await saveEnabledSkills();
  return { ok: true };
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

// Single-instance lock: clicking the dock icon focuses the existing window
// instead of launching a second instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  perfMark('app.ready fired');
  repairWindowsShortcuts();
  Menu.setApplicationMenu(null);
  registerElectronFetchIpc(ipcMain);
  registerElectronExecIpc(ipcMain);
  perfMark('ipc registered');
  // Restore persisted skill toggles
  loadEnabledSkills().catch(() => {});
  // Sync engine config from stored settings — defer to avoid IO contention
  setTimeout(() => loadSettings().then(syncEngineConfig).catch((err) => console.error('[config] sync failed:', err)), 500);
  // Validate engine path after startup; each agent turn spawns its own -p process.
  getEngine().catch((err) => console.error('[engine] failed to start:', err));
  registerClientProtocol();
  perfMark('protocol registered');
  // Fire-and-forget: theme load is not on the critical path
  readJson<{ theme?: 'system' | 'light' | 'dark' }>(userDataPath('local-settings.json'), {})
    .then((cfg) => { nativeTheme.themeSource = cfg.theme || 'system'; })
    .catch(() => {});
  // Create window immediately — DB init is lazy, kicks in on first IPC call
  await createWindow();
  perfMark('window created');
  // Defer heavy SQLite init to avoid blocking the UI
  getSqliteDatabase().catch((err) => console.error('[db] init failed:', err));
});
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.focus();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  for (const run of activeRuns.values()) run.abort();
  killElectronExecChildren();
});
