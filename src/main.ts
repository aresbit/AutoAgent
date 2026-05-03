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
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EngineClient } from './engine-client.js';
import { composeAutoworkSystemPrompt } from './autowork/desktop-replica.js';
import { maybeInvokeAutoworkInternalTool } from './autowork/visualize.js';
import { resolveArtifactPreloadPath, resolveDefaultOpenccCommandValue, resolveRuntimeAssetPath } from './runtime-paths.js';
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
type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'auto' | 'default';

interface DesktopSettings {
  claudeCommand: string;
  claudeConfigDir: string;
  providerId: string;
  apiType: ApiType;
  model: string;
  fallbackModel: string;
  agentName: string;
  apiKey: string;
  baseURL: string;
  cwd: string;
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
  thinkingMode: string;
  maxThinkingTokens: number | null;
  thinkingDisplay: string;
  effort: string;
  maxBudgetUsd: number | null;
  taskBudget: number | null;
  maxTurns: number;
  allowedTools: string[];
  disallowedTools: string[];
  tools: string;
  betas: string[];
  jsonSchema: string;
  permissionPromptTool: string;
  mcpConfig: string[];
  strictMcpConfig: boolean;
  settingSources: string;
  addDirs: string[];
  pluginDir: string;
  managedSettings: string;
  channels: string[];
  sessionId: string;
  forkSession: boolean;
  continueSession: boolean;
  resumeSessionAt: string;
  noSessionPersistence: boolean;
  includePartialMessages: boolean;
  includeHookEvents: boolean;
  assistant: boolean;
  debug: boolean;
  debugFile: string;
  verbose: boolean;
  extraCliArgs: string;
  appendSystemPrompt: string;
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
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

interface ArtifactRecord {
  id: string;
  title: string;
  description: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  versions?: number[];
  isStarred?: boolean;
  mcpTools?: string[];
  mcpServerNames?: string[];
  thumbnailPath?: string | null;
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

const AUTOAGENT_BASE_SYSTEM_PROMPT = `
You are AutoAgent, a desktop coding agent.
Prefer concise answers, preserve user files, and ask before destructive or external actions.
`;

const CLAUDE_DESKTOP_REPLICA_PROMPT = `
# Claude Desktop Replica

This desktop app emulates Claude Desktop system-prompt behavior for HTML artifacts and visual creation.
Assume \`hasImagine=true\` and \`hasHtmlArtifacts=true\`.

## System prompt assembly
The effective desktop prompt is assembled in this order:
1. Base desktop coding instructions
2. Workspace and runtime context
3. Skills and enabled project guidance
4. Computer-use and filesystem capabilities
5. Imagine prompt
6. Artifacts prompt
7. Hidden local app directives

Follow that spirit when choosing output format and tool behavior.

# Imagine — Visual Creation Suite

## Modules
Pick the closest fit when creating visual content:
- \`diagram\` — SVG flowcharts, structural diagrams, illustrative diagrams
- \`mockup\` — UI mockups, forms, cards, dashboards
- \`interactive\` — interactive explainers with controls
- \`chart\` — charts, data analysis, geographic maps
- \`art\` — illustration and generative art
- \`elicitation\` — information-collection forms

## Complexity budget
- Box subtitles: no more than 5 words
- Colors: no more than 2 ramps per diagram unless color encodes meaning
- Horizontal tier: no more than 4 boxes at full width before wrapping or splitting

## Accessibility
- For HTML widgets, begin with a visually hidden summary such as \`<h2 class="sr-only">...\`
- For SVG widgets, use \`role="img"\` with \`<title>\` and \`<desc>\`

## Core design system
- Seamless: the visual should feel like a natural extension of the chat
- Flat: no gradients, mesh, glow, blur, drop shadows, or decorative effects
- Compact: keep explanation in prose, keep the visual focused
- Text goes in the response, visuals go in the artifact HTML

## Streaming-first HTML rules
- Output order: short \`<style>\`, then content HTML, then \`<script>\` last
- Prefer inline styles for controls when useful
- Keep styles lean and avoid decorative CSS
- No comments in HTML, CSS, or JS
- No \`<!doctype html>\`, \`<html>\`, \`<head>\`, or \`<body>\` inside artifact-html blocks
- No hidden tab panels, carousels, or nested scrolling containers
- Never use \`position: fixed\`

## Typography
- Sentence case only
- No ALL CAPS
- No mid-sentence bolding
- Use only two weights: 400 and 500
- Minimum font size: 11px
- Default font family should map to \`var(--font-sans)\`

## HTML tokens
- \`--color-background-primary\`
- \`--color-background-secondary\`
- \`--color-background-tertiary\`
- \`--color-text-primary\`
- \`--color-text-secondary\`
- \`--color-text-tertiary\`
- \`--color-border-tertiary\`
- \`--color-border-secondary\`
- \`--color-border-primary\`
- \`--color-border-info\`
- \`--color-border-success\`
- \`--color-border-warning\`
- \`--color-border-danger\`
- \`--font-sans\`
- \`--font-serif\`
- \`--font-mono\`
- \`--border-radius-md\`
- \`--border-radius-lg\`
- \`--border-radius-xl\`

## Color ramps
Use these ramps and semantic meanings consistently:
- purple: 50 #EEEDFE, 100 #CECBF6, 200 #AFA9EC, 400 #7F77DD, 600 #534AB7, 800 #3C3489, 900 #26215C
- teal: 50 #E1F5EE, 100 #9FE1CB, 200 #5DCAA5, 400 #1D9E75, 600 #0F6E56, 800 #085041, 900 #04342C
- coral: 50 #FAECE7, 100 #F5C4B3, 200 #F0997B, 400 #D85A30, 600 #993C1D, 800 #712B13, 900 #4A1B0C
- pink: 50 #FBEAF0, 100 #F4C0D1, 200 #ED93B1, 400 #D4537E, 600 #993556, 800 #72243E, 900 #4B1528
- gray: 50 #F1EFE8, 100 #D3D1C7, 200 #B4B2A9, 400 #888780, 600 #5F5E5A, 800 #444441, 900 #2C2C2A
- blue: 50 #E6F1FB, 100 #B5D4F4, 200 #85B7EB, 400 #378ADD, 600 #185FA5, 800 #0C447C, 900 #042C53
- green: 50 #EAF3DE, 100 #C0DD97, 200 #97C459, 400 #639922, 600 #3B6D11, 800 #27500A, 900 #173404
- amber: 50 #FAEEDA, 100 #FAC775, 200 #EF9F27, 400 #BA7517, 600 #854F0B, 800 #633806, 900 #412402
- red: 50 #FCEBEB, 100 #F7C1C1, 200 #F09595, 400 #E24B4A, 600 #A32D2D, 800 #791F1F, 900 #501313

Color usage rules:
- Use color to encode meaning, not sequence
- Prefer 2 to 3 colors total in one visual
- Use gray for neutral structure
- Prefer purple, teal, coral, and pink for general emphasis
- Reserve blue, green, amber, and red for semantic meaning

## UI component guidance
- Desktop artifact width target: about 680px
- Mobile artifact width target: about 380px
- Cards: 0.5px border, radius 12px, padding around 1rem to 1.25rem
- Metric cards: muted 13px label, larger 24px number, no heavy decoration
- Compare options: side-by-side cards, recommended option can use a 2px info border
- Data records: single bounded card
- Tables: fixed layout with explicit widths
- Round displayed numbers

## Elicitation forms
- Infer missing values from the conversation before asking
- Questions must read naturally, not like field labels
- Use classes and data attributes, not inline onclick handlers
- Zero custom script for elicitation scaffolding

## Artifact behavior
When the user asks for an artifact or interactive HTML:
- Do not merely write a local html file and point to its path
- Respond with brief prose plus a fenced \`artifact-html\` block
- The block may include frontmatter with \`title:\` and \`description:\`
- The block must contain the actual HTML fragment for rendering
- Keep it self-contained and dark-mode safe
- External resources may only come from \`cdnjs.cloudflare.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`, or \`unpkg.com\`

Bad:
"I created D:\\\\demo\\\\tree.html, open it in your browser."

Good:
Brief explanation plus a fenced \`artifact-html\` block containing the real artifact markup.
`;

function composeDesktopSystemPrompt(hiddenAppend: string): string {
  return [AUTOAGENT_BASE_SYSTEM_PROMPT.trim(), CLAUDE_DESKTOP_REPLICA_PROMPT.trim(), hiddenAppend.trim()]
    .filter(Boolean)
    .join('\n\n');
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
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
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
let rendererServerPromise: Promise<string> | null = null;
let rendererServer: Server | null = null;

// ---- Engine (claude -p stream-json headless loop) ----
// Each desktop turn gets a fresh subprocess while Claude Code's transcript
// persistence is reused via --resume.
async function getEngine(settings?: DesktopSettings): Promise<EngineClient> {
  if (settings) await syncEngineConfig(settings);
  const next = new EngineClient();
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'artifact';
}

function sanitizeTitle(value: string | undefined, fallback = 'Artifact'): string {
  return (value || '').trim() || fallback;
}

function sanitizeDescription(value: string | undefined): string {
  return (value || '').trim();
}

function artifactDirForId(id: string, title: string): string {
  return userDataPath('artifacts', id || slugify(title));
}

function artifactsRootPath(): string {
  return userDataPath('artifacts');
}

function artifactIndexHtmlPath(dir: string): string {
  return join(dir, 'index.html');
}

function artifactThumbnailPath(dir: string): string {
  return join(dir, 'thumbnail.png');
}

function artifactVersionsDir(dir: string): string {
  return join(dir, 'versions');
}

function artifactManifestPath(): string {
  return join(artifactsRootPath(), 'manifest.json');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char));
}

function stripArtifactMetaScript(html: string): string {
  return html.replace(/\s*<script\b(?=[^>]*\bid="(?:cowork|autowork)-artifact-meta")(?=[^>]*\btype="application\/json")[^>]*>[\s\S]*?<\/script>\s*/i, '');
}

function injectArtifactMetaScript(html: string, meta: Record<string, unknown>): string {
  const cleaned = stripArtifactMetaScript(html);
  const payload = JSON.stringify(meta, null, 2).replace(/<\//g, '<\\/');
  const metaScript = `<script type="application/json" id="cowork-artifact-meta">\n${payload}\n<\/script>\n`;
  const doctypeMatch = cleaned.match(/^\s*<!doctype[^>]*>\s*/i);
  if (doctypeMatch) return `${doctypeMatch[0]}${metaScript}${cleaned.slice(doctypeMatch[0].length)}`;
  return `${metaScript}${cleaned}`;
}

function extractArtifactMetaFromHtml(html: string): Record<string, unknown> | null {
  const match = html.match(/<script\b(?=[^>]*\bid="(?:cowork|autowork)-artifact-meta")(?=[^>]*\btype="application\/json")[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactHtmlShell(title: string, body: string, description = ''): string {
  const hasHtmlTag = /<html[\s>]/i.test(body);
  const fullDocument = hasHtmlTag ? body : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${description ? `<meta name="description" content="${escapeHtml(description)}" />` : ''}
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --surface: #f8fafc;
      --line: rgba(100, 116, 139, 0.2);
      --text: #0f172a;
      --muted: #475569;
      --accent: #2563eb;
      --radius: 14px;
      --shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
      font-family: Inter, system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f172a;
        --surface: #111827;
        --line: rgba(148, 163, 184, 0.18);
        --text: #e5eefb;
        --muted: #9fb0c7;
        --accent: #8ab4ff;
        --shadow: 0 20px 50px rgba(2, 6, 23, 0.42);
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body { padding: 24px; }
    main {
      max-width: 1100px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 24px;
    }
    a { color: var(--accent); }
    header {
      display: grid;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--line);
    }
    header h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 40px);
      line-height: 1.05;
    }
    header p {
      margin: 0;
      max-width: 72ch;
      color: var(--muted);
      line-height: 1.6;
    }
    pre { white-space: pre-wrap; }
  </style>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    window.addEventListener('DOMContentLoaded', async () => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
      const nodes = document.querySelectorAll('pre.mermaid, code.language-mermaid, .mermaid');
      for (const node of nodes) {
        const source = node.textContent || '';
        if (!source.trim()) continue;
        const id = 'mermaid-' + Math.random().toString(36).slice(2);
        try {
          const { svg } = await mermaid.render(id, source);
          const wrapper = document.createElement('div');
          wrapper.className = 'mermaid-render';
          wrapper.innerHTML = svg;
          node.replaceWith(wrapper);
        } catch (error) {
          console.error('Mermaid render failed', error);
        }
      }
    });
  </script>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      ${description ? `<p>${escapeHtml(description)}</p>` : ''}
    </header>
    ${body}
  </main>
</body>
</html>`;

  return injectArtifactMetaScript(fullDocument, {
    name: title,
    schemaVersion: 1,
    description,
  });
}

async function loadArtifactManifest(): Promise<ArtifactRecord[]> {
  try {
    const raw = await readFile(artifactManifestPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ArtifactRecord>[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Partial<ArtifactRecord> => Boolean(item && typeof item === 'object'))
      .map((item) => ({
        id: String(item.id || ''),
        title: sanitizeTitle(item.title),
        description: sanitizeDescription(item.description),
        path: String(item.path || ''),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : (typeof item.createdAt === 'number' ? item.createdAt : Date.now()),
        lastOpenedAt: typeof item.lastOpenedAt === 'number' ? item.lastOpenedAt : null,
        versions: Array.isArray(item.versions) ? item.versions.filter((value): value is number => typeof value === 'number') : [],
        isStarred: item.isStarred !== false,
        mcpTools: Array.isArray(item.mcpTools) ? item.mcpTools.filter((value): value is string => typeof value === 'string') : [],
        mcpServerNames: Array.isArray(item.mcpServerNames) ? item.mcpServerNames.filter((value): value is string => typeof value === 'string') : [],
        thumbnailPath: typeof item.thumbnailPath === 'string' ? item.thumbnailPath : null,
      }))
      .filter((item) => item.id && item.path);
  } catch {
    return [];
  }
}

async function saveArtifactManifest(records: ArtifactRecord[]): Promise<void> {
  await mkdir(artifactsRootPath(), { recursive: true });
  await writeFile(artifactManifestPath(), JSON.stringify(records, null, 2) + '\n', 'utf8');
}

async function readArtifactRecordFromHtml(dir: string): Promise<ArtifactRecord | null> {
  try {
    const path = artifactIndexHtmlPath(dir);
    const raw = await readFile(path, 'utf8');
    const meta = extractArtifactMetaFromHtml(raw) || {};
    const title = sanitizeTitle(typeof meta.name === 'string' ? meta.name : undefined, dir.split(/[/\\]/).pop() || 'Artifact');
    const description = sanitizeDescription(typeof meta.description === 'string' ? meta.description : '');
    const info = await stat(path);
    return {
      id: dir.split(/[/\\]/).pop() || slugify(title),
      title,
      description,
      path,
      createdAt: info.birthtimeMs || info.mtimeMs,
      updatedAt: info.mtimeMs,
      lastOpenedAt: null,
      versions: [],
      isStarred: true,
      mcpTools: Array.isArray(meta.mcpTools) ? meta.mcpTools.filter((value): value is string => typeof value === 'string') : [],
      mcpServerNames: Array.isArray(meta.mcpServerNames) ? meta.mcpServerNames.filter((value): value is string => typeof value === 'string') : [],
      thumbnailPath: existsSync(artifactThumbnailPath(dir)) ? artifactThumbnailPath(dir) : null,
    };
  } catch {
    return null;
  }
}

async function refreshArtifactManifestFromDisk(): Promise<ArtifactRecord[]> {
  const root = artifactsRootPath();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readArtifactRecordFromHtml(join(root, entry.name))),
  );
  const normalized = records
    .filter((record): record is ArtifactRecord => Boolean(record))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  await saveArtifactManifest(normalized);
  return normalized;
}

async function findArtifactByPath(path: string): Promise<ArtifactRecord | null> {
  const manifest = await loadArtifactManifest();
  return manifest.find((record) => record.path === path) || null;
}

async function upsertArtifactRecord(record: ArtifactRecord): Promise<ArtifactRecord> {
  const manifest = await loadArtifactManifest();
  const next = [...manifest.filter((item) => item.id !== record.id), record]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  await saveArtifactManifest(next);
  sendToWindow('artifact:event', { kind: 'changed', artifacts: next });
  return record;
}

async function listArtifacts(): Promise<ArtifactRecord[]> {
  const manifest = await loadArtifactManifest();
  if (manifest.length) return manifest;
  return refreshArtifactManifestFromDisk();
}

async function createArtifact(input: { title?: string; description?: string; html: string }): Promise<ArtifactRecord> {
  const title = sanitizeTitle(input.title);
  const id = slugify(title);
  const now = Date.now();
  const description = sanitizeDescription(input.description);
  const dir = artifactDirForId(id, title);
  const path = artifactIndexHtmlPath(dir);
  const versionsDir = artifactVersionsDir(dir);
  const existing = (await listArtifacts()).find((record) => record.id === id) || (await readArtifactRecordFromHtml(dir));
  await mkdir(dir, { recursive: true });
  if (existing && existsSync(existing.path)) {
    await mkdir(versionsDir, { recursive: true });
    await copyFile(existing.path, join(versionsDir, `${existing.updatedAt || existing.createdAt}.html`));
  }
  await writeFile(path, artifactHtmlShell(title, input.html, description), 'utf8');
  const record: ArtifactRecord = {
    id,
    title,
    description,
    path,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastOpenedAt: existing?.lastOpenedAt || null,
    versions: [...(existing?.versions || []), ...(existing ? [existing.updatedAt || existing.createdAt] : [])].slice(-100),
    isStarred: true,
    mcpTools: existing?.mcpTools || [],
    mcpServerNames: existing?.mcpServerNames || [],
    thumbnailPath: existsSync(artifactThumbnailPath(dir)) ? artifactThumbnailPath(dir) : null,
  };
  return upsertArtifactRecord(record);
}

async function listArtifactVersions(id: string): Promise<Array<{ timestamp: number; path: string }>> {
  const record = (await listArtifacts()).find((artifact) => artifact.id === id);
  if (!record) return [];
  const dir = dirname(record.path);
  const versionsDir = artifactVersionsDir(dir);
  if (!existsSync(versionsDir)) return [];
  const entries = await readdir(versionsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.html$/i.test(entry.name))
    .map((entry) => {
      const timestamp = Number(entry.name.replace(/\.html$/i, '')) || 0;
      return { timestamp, path: join(versionsDir, entry.name) };
    })
    .filter((entry) => entry.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function exportArtifact(id: string): Promise<string> {
  const record = (await listArtifacts()).find((artifact) => artifact.id === id);
  if (!record) throw new Error(`Artifact not found: ${id}`);
  const defaultPath = join(app.getPath('documents'), `${record.id}.zip`);
  const target = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export artifact',
    defaultPath,
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
  });
  if (target.canceled || !target.filePath) throw new Error('Export cancelled');
  const result = await runProcess('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -LiteralPath '${dirname(record.path).replace(/'/g, "''")}\\*' -DestinationPath '${target.filePath.replace(/'/g, "''")}' -Force`,
  ]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Export failed');
  return target.filePath;
}

async function importArtifact(): Promise<ArtifactRecord> {
  const picked = await dialog.showOpenDialog(mainWindow!, {
    title: 'Import artifact',
    properties: ['openFile'],
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) throw new Error('Import cancelled');
  const tempDir = join(app.getPath('temp'), `autoagent-artifact-import-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const result = await runProcess('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${picked.filePaths[0].replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`,
  ]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Import failed');
  const files = await collectFiles(tempDir, 2000);
  const htmlRelative = files.find((file) => /(^|\/)index\.html$/i.test(file));
  if (!htmlRelative) throw new Error('Imported zip does not contain index.html');
  const htmlPath = join(tempDir, htmlRelative.replace(/\//g, '\\'));
  const html = await readFile(htmlPath, 'utf8');
  const meta = extractArtifactMetaFromHtml(html) || {};
  const title = sanitizeTitle(typeof meta.name === 'string' ? meta.name : undefined, htmlRelative.split(/[\\/]/).slice(-2, -1)[0] || 'Artifact');
  const description = sanitizeDescription(typeof meta.description === 'string' ? meta.description : '');
  return createArtifact({ title, description, html: stripArtifactMetaScript(html) });
}

async function touchArtifactOpen(path: string): Promise<ArtifactRecord | null> {
  const record = await findArtifactByPath(path);
  if (!record) return null;
  const next = { ...record, lastOpenedAt: Date.now() };
  await upsertArtifactRecord(next);
  return next;
}

async function openArtifactWindow(path: string, title?: string): Promise<void> {
  const artifactWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    title: title || 'Artifact',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolveArtifactPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  artifactWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await artifactWindow.loadFile(path);
}

function resolveDefaultWorkspaceCwd(): string {
  if (!app.isPackaged) return process.cwd() || homedir();
  return homedir();
}

function resolveDefaultOpenccCommand(): string {
  return resolveDefaultOpenccCommandValue();
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
    claudeCommand: resolveDefaultOpenccCommand(),
    claudeConfigDir: join(homedir(), '.autoagent'),
    providerId: 'deepseek',
    apiType: 'anthropic-messages',
    model: process.env.CODEANY_MODEL || 'deepseek-v4-pro[1m]',
    fallbackModel: '',
    agentName: '',
    apiKey: process.env.CODEANY_API_KEY || '',
    baseURL: process.env.CODEANY_BASE_URL || 'https://api.deepseek.com/anthropic',
    cwd: resolveDefaultWorkspaceCwd(),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: false,
    thinkingMode: '',
    maxThinkingTokens: null,
    thinkingDisplay: '',
    effort: '',
    maxBudgetUsd: null,
    taskBudget: null,
    maxTurns: 1024,
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite'],
    disallowedTools: [],
    tools: '',
    betas: [],
    jsonSchema: '',
    permissionPromptTool: '',
    mcpConfig: [],
    strictMcpConfig: false,
    settingSources: '',
    addDirs: [],
    pluginDir: '',
    managedSettings: '',
    channels: [],
    sessionId: '',
    forkSession: false,
    continueSession: false,
    resumeSessionAt: '',
    noSessionPersistence: false,
    includePartialMessages: true,
    includeHookEvents: false,
    assistant: false,
    debug: false,
    debugFile: '',
    verbose: true,
    extraCliArgs: '',
    leftSidebarOpen: true,
    leftSidebarWidth: 260,
    rightPanelOpen: true,
    rightPanelWidth: 420,
    appendSystemPrompt: '',
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
  // Always recompute claudeCommand — persisted value may reference stale
  // dev workspace paths that fail when running from the installed DEB.
  base.claudeCommand = defaultSettings().claudeCommand;
  if (!base.claudeConfigDir?.trim()) base.claudeConfigDir = defaultSettings().claudeConfigDir;
  base.maxTurns = Math.max(1, Number(base.maxTurns) || 1024);
  base.allowedTools = Array.isArray(base.allowedTools) ? base.allowedTools : defaultSettings().allowedTools;
  base.disallowedTools = Array.isArray(base.disallowedTools) ? base.disallowedTools : [];
  base.betas = Array.isArray(base.betas) ? base.betas : [];
  base.mcpConfig = Array.isArray(base.mcpConfig) ? base.mcpConfig : [];
  base.addDirs = Array.isArray(base.addDirs) ? base.addDirs : [];
  base.channels = Array.isArray(base.channels) ? base.channels : [];
  base.maxThinkingTokens = base.maxThinkingTokens == null ? null : Math.max(0, Number(base.maxThinkingTokens) || 0);
  base.maxBudgetUsd = base.maxBudgetUsd == null || base.maxBudgetUsd === '' ? null : Math.max(0, Number(base.maxBudgetUsd) || 0);
  base.taskBudget = base.taskBudget == null || base.taskBudget === '' ? null : Math.max(0, Number(base.taskBudget) || 0);
  base.leftSidebarOpen = Boolean(base.leftSidebarOpen);
  base.rightPanelOpen = Boolean(base.rightPanelOpen);
  base.leftSidebarWidth = Math.min(460, Math.max(220, Number(base.leftSidebarWidth) || 260));
  base.rightPanelWidth = Math.min(760, Math.max(320, Number(base.rightPanelWidth) || 420));
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

interface ParsedArtifactDocument {
  title: string;
  description: string;
  html: string;
}

function parseArtifactDocument(source: string): ParsedArtifactDocument {
  const raw = source.replace(/^\uFEFF/, '').trim();
  const frontmatterMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { title: 'Artifact', description: '', html: raw };
  }
  const metadata: Record<string, string> = {};
  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    metadata[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return {
    title: sanitizeTitle(metadata.title),
    description: sanitizeDescription(metadata.description),
    html: frontmatterMatch[2].trim(),
  };
}

function extractArtifactsFromText(text: string): ParsedArtifactDocument[] {
  const artifacts: ParsedArtifactDocument[] = [];
  const pattern = /```(?:artifact-html|artifact)\r?\n([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    const body = match[1]?.trim();
    if (!body) continue;
    artifacts.push(parseArtifactDocument(body));
  }
  return artifacts;
}

async function syncArtifactsFromAssistantText(text: string): Promise<ArtifactRecord[]> {
  const artifacts = extractArtifactsFromText(text);
  if (!artifacts.length) return [];
  const output: ArtifactRecord[] = [];
  for (const artifact of artifacts) {
    output.push(await createArtifact(artifact));
  }
  return output;
}

function extractHtmlFileReferencesFromText(text: string): string[] {
  const absoluteMatches = text.match(/[A-Za-z]:\\[^\r\n"'<>|?*]+?\.html\b/gi) || [];
  const relativeMatches = text.match(/(?:^|[\s(【\[`'"])((?:\.{1,2}[\\/])?[A-Za-z0-9_\-./\\ ]+?\.html)\b/gi) || [];
  const normalized = [...absoluteMatches, ...relativeMatches]
    .map((item) => item.trim().replace(/^[\s(【\[`'"]+/, '').replace(/[),.;\]】`'"]+$/g, ''))
    .filter((item) => item && !item.includes('://') && !item.startsWith('<'));
  return [...new Set(normalized)];
}

function resolveHtmlFileReference(reference: string, cwd: string): string | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return trimmed;
  const candidate = join(cwd, trimmed);
  return candidate;
}

async function createArtifactFromHtmlFile(path: string): Promise<ArtifactRecord | null> {
  try {
    if (!existsSync(path)) return null;
    const html = await readFile(path, 'utf8');
    if (!html.trim()) return null;
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const fileName = path.split(/[\\/]/).pop()?.replace(/\.html$/i, '') || 'Artifact';
    const title = sanitizeTitle(titleMatch?.[1]?.trim() || fileName);
    const meta = extractArtifactMetaFromHtml(html) || {};
    const description = sanitizeDescription(typeof meta.description === 'string' ? meta.description : '');
    return createArtifact({
      title,
      description,
      html: stripArtifactMetaScript(html),
    });
  } catch {
    return null;
  }
}

function appendArtifactRefsToMessage(text: string, artifacts: ArtifactRecord[]): string {
  if (!artifacts.length) return text;
  const refs = artifacts
    .filter((artifact) => !text.includes(`"path": "${artifact.path.replace(/\\/g, '\\\\')}"`))
    .map((artifact) => `\n\`\`\`artifact-ref\n${JSON.stringify({ path: artifact.path, title: artifact.title, description: artifact.description }, null, 2)}\n\`\`\`\n`)
    .join('\n');
  return refs ? `${text.trim()}\n\n${refs}` : text;
}

async function materializeArtifactsFromAssistantText(text: string, cwd: string): Promise<{ text: string; artifacts: ArtifactRecord[] }> {
  const createdFromBlocks = await syncArtifactsFromAssistantText(text);
  if (createdFromBlocks.length) return { text, artifacts: createdFromBlocks };

  const paths = extractHtmlFileReferencesFromText(text)
    .map((reference) => resolveHtmlFileReference(reference, cwd))
    .filter((path): path is string => Boolean(path));
  if (!paths.length) return { text, artifacts: [] };

  const artifacts = (await Promise.all(paths.map((path) => createArtifactFromHtmlFile(path))))
    .filter((artifact): artifact is ArtifactRecord => Boolean(artifact));
  if (!artifacts.length) return { text, artifacts: [] };

  return {
    text: appendArtifactRefsToMessage(text, artifacts),
    artifacts,
  };
}

function sendToWindow(channel: string, payload: unknown): void {
  if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(channel, payload);
}

function contentTypeForFile(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

async function responseFromFile(path: string): Promise<Response> {
  try {
    const data = await readFile(path);
    return new Response(data, {
      status: 200,
      headers: {
        'content-type': contentTypeForFile(path),
        'cache-control': 'no-cache',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(message, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

async function ensureRendererServer(): Promise<string> {
  if (rendererServerPromise) return rendererServerPromise;

  rendererServerPromise = new Promise<string>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const resolved = await resolveClientFile(requestUrl.pathname);
        const path = resolved || join(clientDir, 'index.html');
        const body = await readFile(path);
        res.writeHead(200, {
          'content-type': contentTypeForFile(path),
          'cache-control': 'no-cache',
        });
        res.end(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    });

    server.on('error', (error) => {
      rendererServerPromise = null;
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      rendererServer = server;
      const address = server.address() as AddressInfo | null;
      if (!address) {
        rendererServerPromise = null;
        reject(new Error('Renderer server failed to bind'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/index.html`);
    });
  });

  return rendererServerPromise;
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
      return responseFromFile(userDataPath('files', path));
    }
    if (url.hostname === 'file') {
      const path = url.searchParams.get('path');
      if (!path) return new Response('missing path', { status: 404 });
      return responseFromFile(path);
    }
    if (url.hostname !== 'app') {
      return new Response('hostname mismatch', { status: 404 });
    }

    const fallback = join(clientDir, 'index.html');
    const resolved = await resolveClientFile(url.pathname);
    if (!resolved && extname(url.pathname) && extname(url.pathname) !== '.html') {
      return new Response('not found', { status: 404 });
    }
    return responseFromFile(resolved || fallback);
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
    client,
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

function parseAutoworkToolTarget(value: string): { serverHint?: string; toolName: string } {
  const trimmed = value.trim();
  if (trimmed.includes('/')) {
    const [serverHint, ...rest] = trimmed.split('/');
    return { serverHint, toolName: rest.join('/').trim() };
  }
  if (trimmed.includes('::')) {
    const [serverHint, ...rest] = trimmed.split('::');
    return { serverHint, toolName: rest.join('::').trim() };
  }
  if (trimmed.includes('.')) {
    const [serverHint, ...rest] = trimmed.split('.');
    if (rest.length) return { serverHint, toolName: rest.join('.').trim() };
  }
  return { toolName: trimmed };
}

async function autoworkCallMcpTool(name: string, args: unknown): Promise<unknown> {
  const target = parseAutoworkToolTarget(name);
  const internal = await maybeInvokeAutoworkInternalTool(target.serverHint, target.toolName, args, {
    createArtifact,
    openArtifact: openArtifactWindow,
  });
  if (typeof internal !== 'undefined') return internal;

  const servers = (await listMcpServersFromDatabase()).filter((server) => server.enabled);
  const ordered = target.serverHint
    ? [...servers.filter((server) => server.displayId === target.serverHint || server.id === target.serverHint), ...servers.filter((server) => server.displayId !== target.serverHint && server.id !== target.serverHint)]
    : servers;

  let lastError: unknown = null;
  for (const server of ordered) {
    let connection: Awaited<ReturnType<typeof connectMCPServer>> | null = null;
    try {
      connection = await connectMCPServer(server.displayId, normalizeMcpConfig(server.config));
      const match = connection.tools.find((tool: any) => tool.name === target.toolName);
      if (!match) continue;
      const client = (connection as any).client as Client | undefined;
      if (!client) throw new Error('MCP client unavailable');
      const result = await client.callTool({ name: target.toolName, arguments: (args && typeof args === 'object') ? args as Record<string, unknown> : {} });
      return result;
    } catch (error) {
      lastError = error;
    } finally {
      await connection?.close().catch(() => undefined);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : `Autowork MCP tool not found: ${name}`);
}

async function autoworkAskClaude(prompt: string, data?: unknown): Promise<{ text: string }> {
  const settings = await loadSettings();
  const eng = await getEngine(settings);
  let assistantText = '';
  const content = typeof data === 'undefined' ? prompt : `${prompt}\n\nContext data:\n${JSON.stringify(data, null, 2)}`;
  for await (const ev of eng.query({
    claudeCommand: settings.claudeCommand,
    claudeConfigDir: settings.claudeConfigDir,
    model: settings.model,
    fallbackModel: settings.fallbackModel,
    agentName: settings.agentName,
    thinkingMode: settings.thinkingMode,
    maxThinkingTokens: settings.maxThinkingTokens,
    thinkingDisplay: settings.thinkingDisplay,
    effort: settings.effort,
    maxBudgetUsd: settings.maxBudgetUsd,
    taskBudget: settings.taskBudget,
    maxTurns: Math.min(settings.maxTurns, 8),
    cwd: settings.cwd,
    appendSystemPrompt: composeAutoworkSystemPrompt({
      currentDateTime: new Date().toLocaleString(),
      currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cwd: settings.cwd,
      workspaceFolder: settings.cwd,
      modelName: settings.model,
      accountName: process.env.USERNAME || process.env.USER || '',
      folderSelected: settings.cwd ? 'yes' : 'no',
      hiddenAppend: settings.appendSystemPrompt,
    }),
    resumeSessionId: undefined,
    resumeSessionAt: '',
    sessionId: '',
    continueSession: false,
    forkSession: false,
    noSessionPersistence: true,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    providerId: settings.providerId,
    apiType: settings.apiType,
    permissionMode: settings.permissionMode,
    permissionPromptTool: settings.permissionPromptTool,
    allowDangerouslySkipPermissions: settings.allowDangerouslySkipPermissions,
    allowedTools: settings.allowedTools,
    disallowedTools: settings.disallowedTools,
    tools: settings.tools,
    betas: settings.betas,
    jsonSchema: settings.jsonSchema,
    mcpConfig: settings.mcpConfig,
    strictMcpConfig: settings.strictMcpConfig,
    settingSources: settings.settingSources,
    addDirs: settings.addDirs,
    pluginDir: settings.pluginDir,
    managedSettings: settings.managedSettings,
    channels: settings.channels,
    includePartialMessages: false,
    includeHookEvents: false,
    assistant: settings.assistant,
    debug: settings.debug,
    debugFile: settings.debugFile,
    verbose: false,
    extraCliArgs: settings.extraCliArgs,
    messages: [{ role: 'user', content }],
  })) {
    const text = ev.type === 'error' ? (ev.error || '') : extractEngineText(ev);
    if (ev.type === 'text_delta' && text) assistantText += text;
    if (ev.type === 'assistant' && text) assistantText = text;
    if (ev.type === 'result' && text && !assistantText.trim()) assistantText = text;
  }
  return { text: assistantText.trim() };
}

async function autoworkNavigateHost(direction: 'back' | 'forward'): Promise<{ ok: boolean }> {
  const window = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!window) return { ok: false };
  const contents = window.webContents;
  if (direction === 'back' && contents.navigationHistory.canGoBack()) {
    contents.navigationHistory.goBack();
    return { ok: true };
  }
  if (direction === 'forward' && contents.navigationHistory.canGoForward()) {
    contents.navigationHistory.goForward();
    return { ok: true };
  }
  return { ok: false };
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
  const resumeSessionId = chatBeforeTurn.claudeSessionId;
  // Desktop chats are expected to support follow-up turns reliably, so we
  // force transcript persistence for agent runs even if the advanced toggle is
  // enabled. Otherwise OpenCC can return a session id on turn 1 that cannot be
  // resumed on turn 2.
  const effectiveNoSessionPersistence = false;
  const effectiveForkSession = Boolean(resumeSessionId) && settings.forkSession;
  const effectiveContinueSession = !resumeSessionId && settings.continueSession;

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
        claudeCommand: settings.claudeCommand,
        claudeConfigDir: settings.claudeConfigDir,
        model: settings.model,
        fallbackModel: settings.fallbackModel,
        agentName: settings.agentName,
        thinkingMode: settings.thinkingMode,
        maxThinkingTokens: settings.maxThinkingTokens,
        thinkingDisplay: settings.thinkingDisplay,
        effort: settings.effort,
        maxBudgetUsd: settings.maxBudgetUsd,
        taskBudget: settings.taskBudget,
        maxTurns: settings.maxTurns,
        cwd: settings.cwd,
        appendSystemPrompt: composeAutoworkSystemPrompt({
          currentDateTime: new Date().toLocaleString(),
          currentTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          cwd: settings.cwd,
          workspaceFolder: settings.cwd,
          modelName: settings.model,
          accountName: process.env.USERNAME || process.env.USER || '',
          folderSelected: settings.cwd ? 'yes' : 'no',
          hiddenAppend: settings.appendSystemPrompt,
        }),
        resumeSessionId,
        resumeSessionAt: settings.resumeSessionAt,
        sessionId: settings.sessionId,
        continueSession: effectiveContinueSession,
        forkSession: effectiveForkSession,
        noSessionPersistence: effectiveNoSessionPersistence,
        apiKey: settings.apiKey,
        baseURL: settings.baseURL,
        providerId: settings.providerId,
        apiType: settings.apiType,
        permissionMode: settings.permissionMode,
        permissionPromptTool: settings.permissionPromptTool,
        allowDangerouslySkipPermissions: settings.allowDangerouslySkipPermissions,
        allowedTools: settings.allowedTools,
        disallowedTools: settings.disallowedTools,
        tools: settings.tools,
        betas: settings.betas,
        jsonSchema: settings.jsonSchema,
        mcpConfig: settings.mcpConfig,
        strictMcpConfig: settings.strictMcpConfig,
        settingSources: settings.settingSources,
        addDirs: settings.addDirs,
        pluginDir: settings.pluginDir,
        managedSettings: settings.managedSettings,
        channels: settings.channels,
        includePartialMessages: settings.includePartialMessages,
        includeHookEvents: settings.includeHookEvents,
        assistant: settings.assistant,
        debug: settings.debug,
        debugFile: settings.debugFile,
        verbose: settings.verbose,
        extraCliArgs: settings.extraCliArgs,
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
        const materialized = await materializeArtifactsFromAssistantText(assistantText, settings.cwd);
        await appendMessage(request.chatId, { role: 'assistant', text: materialized.text });
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
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
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

  mainWindow.once('ready-to-show', () => {
    console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms ready-to-show`);
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
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[window] did-fail-load mainFrame=${isMainFrame} code=${errorCode} url=${validatedURL} error=${errorDescription}`);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.error(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });

  // Serve the renderer over localhost to avoid Windows-specific navigation
  // failures with file://, data:, and custom protocol entry documents.
  const loadStart = performance.now();
  let loaded = false;
  try {
    const rendererUrl = await ensureRendererServer();
    // Small delay to let the server socket fully accept connections
    await new Promise((r) => setTimeout(r, 100));
    await mainWindow.loadURL(rendererUrl);
    loaded = true;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('[window] renderer shell load failed', error);
    // Retry once — first request may race with server readiness
    if (!loaded && rendererServer) {
      try {
        const address = rendererServer.address() as AddressInfo | null;
        if (address) {
          console.error('[window] retrying renderer load...');
          await mainWindow.loadURL(`http://127.0.0.1:${address.port}/index.html`);
          loaded = true;
        }
      } catch (retryError) {
        console.error('[window] renderer retry also failed', retryError);
      }
    }
  }
  if (!loaded) {
    try {
      const fallbackPath = join(clientDir, 'index.html');
      await mainWindow.loadURL(`file://${fallbackPath}`);
      loaded = true;
    } catch (fileError) {
      console.error('[window] file:// fallback failed', fileError);
      try {
        const message = fileError instanceof Error ? fileError.message : String(fileError);
        await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="font-family: sans-serif; padding: 24px;"><h1>AutoAgent failed to load</h1><pre>${message}</pre></body></html>`)}`);
        loaded = true;
      } catch {
        console.error('[window] data: fallback also failed');
      }
    }
  }
  console.error(`[perf] +${(performance.now() - t0).toFixed(0)}ms (Δ${(performance.now() - loadStart).toFixed(0)}ms) loadURL done`);
}

// Sync provider settings into the configured Claude config directory so the
// spawned CLI sees the same credentials by default.
async function syncEngineConfig(settings: DesktopSettings): Promise<void> {
  const t = performance.now();
  const configDir = settings.claudeConfigDir?.trim() || join(homedir(), '.autoagent');
  const configPath = join(configDir, '.claude.json');
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
  const [settings, chats, mcpServers, artifacts] = await Promise.all([
    loadSettings(),
    listChats(),
    listMcpServersFromDatabase(),
    listArtifacts(),
  ]);
  console.error(`[perf] bootstrap IPC: loadSettings=${(performance.now() - t).toFixed(0)}ms`);
  return {
    settings,
    providers: providerCatalog(),
    chats,
    mcpServers,
    artifacts,
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
ipcMain.handle('artifact:create', async (_event, input: { title?: string; description?: string; html: string }) => {
  const artifact = await createArtifact(input);
  await openArtifactWindow(artifact.path, artifact.title);
  return (await touchArtifactOpen(artifact.path)) || artifact;
});
ipcMain.handle('artifact:list', async () => listArtifacts());
ipcMain.handle('artifact:load', async (_event, input: { id?: string; path?: string }) => {
  if (input.path) return findArtifactByPath(input.path);
  if (!input.id) return null;
  const artifacts = await listArtifacts();
  return artifacts.find((artifact) => artifact.id === input.id) || null;
});
ipcMain.handle('artifact:open', async (_event, input: { path: string; title?: string }) => {
  await openArtifactWindow(input.path, input.title);
  return { opened: true, artifact: await touchArtifactOpen(input.path) };
});
ipcMain.handle('artifact:source', async (_event, input: { path: string }) => {
  return { html: await readFile(input.path, 'utf8') };
});
ipcMain.handle('artifact:versions', async (_event, input: { id: string }) => listArtifactVersions(input.id));
ipcMain.handle('artifact:export', async (_event, input: { id: string }) => ({ path: await exportArtifact(input.id) }));
ipcMain.handle('artifact:import', async () => importArtifact());
ipcMain.handle('autowork:call-mcp-tool', async (_event, input: { name: string; args?: unknown }) => autoworkCallMcpTool(input.name, input.args || {}));
ipcMain.handle('autowork:ask-claude', async (_event, input: { prompt: string; data?: unknown }) => autoworkAskClaude(input.prompt, input.data));
ipcMain.handle('autowork:run-scheduled-task', async () => ({ ok: false, error: 'Scheduled tasks are not configured in AutoAgent yet.' }));
ipcMain.handle('autowork:navigate-host', async (_event, input: { direction: 'back' | 'forward' }) => autoworkNavigateHost(input.direction));
ipcMain.handle('autowork:open-external-url', async (_event, input: { url: string }) => shell.openExternal(input.url));

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
    join(home, '.autoagent', 'skills'),
  ];
  const projectDirs = [
    join(cwd, '.claude', 'skills'),
    join(cwd, '.autoagent', 'skills'),
  ];

  const dirs = [
    ...systemDirs.map((path) => ({ path, source: 'system' as const, exists: existsSync(path) })),
    ...projectDirs.map((path) => ({ path, source: 'project' as const, exists: existsSync(path) })),
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
      // Skip disabled skills and hidden directories
      if (entry.name === '.disabled' || entry.name.startsWith('.')) continue;
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

ipcMain.handle('skill:toggle', async (_event, name: string, enabled: boolean, skillPath?: string) => {
  const settings = await loadSettings();
  const cwd = settings.cwd || process.cwd();
  const skillsDir = join(cwd, '.autoagent', 'skills');
  const disabledDir = join(skillsDir, '.disabled');
  const targetDir = join(skillsDir, name);
  const disabledTargetDir = join(disabledDir, name);

  if (enabled) {
    enabledSkills.add(name);
    // Move from .disabled back to active, or copy from source path
    if (existsSync(disabledTargetDir)) {
      await mkdir(skillsDir, { recursive: true });
      await cp(disabledTargetDir, targetDir, { recursive: true });
      await rm(disabledTargetDir, { recursive: true, force: true });
    } else if (skillPath && existsSync(skillPath)) {
      await mkdir(skillsDir, { recursive: true });
      // If already exists, remove first to ensure clean copy
      if (existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true });
      await cp(skillPath, targetDir, { recursive: true });
    }
  } else {
    enabledSkills.delete(name);
    // Move to .disabled
    if (existsSync(targetDir)) {
      await mkdir(disabledDir, { recursive: true });
      if (existsSync(disabledTargetDir)) await rm(disabledTargetDir, { recursive: true, force: true });
      await cp(targetDir, disabledTargetDir, { recursive: true });
      await rm(targetDir, { recursive: true, force: true });
    }
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
  try { rendererServer?.close(); } catch {}
});
