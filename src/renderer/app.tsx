import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Bot,
  Boxes,
  Check,
  Circle,
  FolderGit2,
  GitBranch,
  GitFork,
  LayoutPanelTop,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plug,
  RefreshCw,
  Save,
  SearchCode,
  Settings2,
  Square,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type { AutoAgentBridge } from '../preload';
import { MessageContent } from './message-content';

declare global {
  interface Window {
    autoagent: AutoAgentBridge;
  }
}

type Role = 'user' | 'assistant' | 'system' | 'tool';
type Panel = 'skills' | 'agent' | 'mcp' | 'workspace' | 'artifacts';

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: number;
}

interface ChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface Settings {
  claudeCommand: string;
  claudeConfigDir: string;
  providerId: string;
  apiType: string;
  model: string;
  fallbackModel: string;
  agentName: string;
  apiKey: string;
  baseURL: string;
  cwd: string;
  permissionMode: string;
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
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  appendSystemPrompt: string;
}

interface BootstrapPayload {
  settings: Settings;
  providers: {
    builtin: Array<{ id: string; name: string }>;
    custom: Array<{ id: string; name: string; type: string; baseUrl: string; models: string[]; allowCustomModels?: boolean }>;
  };
  chats: ChatRecord[];
  mcpServers: McpServer[];
  artifacts: ArtifactRecord[];
}

interface AgentEvent {
  runId: string;
  chatId: string;
  kind: string;
  text?: string;
}

interface McpServer {
  id: string;
  displayId: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  autoRun: boolean;
  createdAt: number;
  updatedAt: number;
}

interface McpDiscoveryResult {
  id: string;
  displayId: string;
  status: string;
  durationMs: number;
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
  error?: string;
}

interface GitStatus {
  stat: { isGitRepo: boolean; additions: number; deletions: number; changedFiles: number } | null;
  branches: Array<{ name: string; isRemote: boolean }>;
  files: { isGitRepo: boolean; files: Array<{ path: string; status: string; additions: number; deletions: number }> };
  errors: string[];
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
  source: 'system' | 'project';
  enabled: boolean;
}

interface SkillDir {
  path: string;
  source: 'system' | 'project';
  exists: boolean;
}

type LiveMessage = ChatMessage & { live?: boolean };

const emptyProviders: BootstrapPayload['providers'] = { builtin: [], custom: [] };
const defaultMcpForm = {
  id: '',
  displayId: '',
  type: 'stdio',
  command: '',
  url: '',
  env: '',
  enabled: true,
};

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function envObjectToText(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}=${String(entry ?? '')}`)
    .join('\n');
}

function parseEnvText(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    output[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return output;
}

function splitCommandLine(value: string): { command: string; args: string[] } {
  const parts = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, '')) || [];
  return { command: parts[0] || '', args: parts.slice(1) };
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
  thumbnailPath?: string | null;
}

function splitList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatMcpDetail(config: Record<string, unknown>): string {
  if (config.type === 'http' || config.type === 'sse') return `${config.type}: ${String(config.url || '')}`;
  return `stdio: ${String(config.command || '')} ${((config.args as string[] | undefined) || []).join(' ')}`.trim();
}

function allProviders(providers: BootstrapPayload['providers']) {
  const merged = [...providers.builtin, ...providers.custom.map((p) => ({ id: p.id, name: p.name }))];
  const seen = new Set<string>();
  return merged.filter((provider) => (seen.has(provider.id) ? false : (seen.add(provider.id), true)));
}

function App() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(260);
  const [controlWidth, setControlWidth] = useState(420);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<BootstrapPayload['providers']>(emptyProviders);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [activeChat, setActiveChat] = useState<ChatRecord | null>(null);
  const [liveMessages, setLiveMessages] = useState<LiveMessage[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [status, setStatus] = useState('Booting');
  const [prompt, setPrompt] = useState('');
  const [rightOpen, setRightOpen] = useState(true);
  const [panel, setPanel] = useState<Panel>('skills');
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpForm, setMcpForm] = useState(defaultMcpForm);
  const [mcpDiscovery, setMcpDiscovery] = useState<McpDiscoveryResult[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillDirs, setSkillDirs] = useState<SkillDir[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const resizingPaneRef = useRef<'left' | 'right' | null>(null);
  const layoutHydratedRef = useRef(false);

  const running = Boolean(activeRunId);
  const visibleMessages = useMemo(() => [...(activeChat?.messages || []), ...liveMessages], [activeChat, liveMessages]);
  const providerOptions = useMemo(() => allProviders(providers), [providers]);
  const modelOptions = useMemo(
    () => providers.custom.find((provider) => provider.id === settings?.providerId)?.models || [],
    [providers, settings?.providerId],
  );

  useEffect(() => {
    activeChatIdRef.current = activeChat?.id || null;
  }, [activeChat?.id]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [visibleMessages.length, visibleMessages.at(-1)?.text]);

  useEffect(() => {
    if (!settings || layoutHydratedRef.current) return;
    setLeftOpen(settings.leftSidebarOpen);
    setLeftWidth(settings.leftSidebarWidth);
    setRightOpen(settings.rightPanelOpen);
    setControlWidth(settings.rightPanelWidth);
    layoutHydratedRef.current = true;
  }, [settings]);

  function persistLayout(partial: Partial<Settings>) {
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current, ...partial };
      void window.autoagent.saveSettings(next);
      return next;
    });
  }

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (resizingPaneRef.current === 'left') {
        const next = Math.min(Math.max(event.clientX, 220), Math.min(460, window.innerWidth - (rightOpen ? controlWidth + 360 : 240)));
        setLeftWidth(next);
        return;
      }
      if (resizingPaneRef.current === 'right') {
        const next = Math.min(Math.max(window.innerWidth - event.clientX, 320), Math.min(760, window.innerWidth - (leftOpen ? leftWidth + 360 : 240)));
        setControlWidth(next);
      }
    };
    const stopResize = () => {
      const pane = resizingPaneRef.current;
      resizingPaneRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (pane === 'left') persistLayout({ leftSidebarWidth: leftWidth });
      if (pane === 'right') persistLayout({ rightPanelWidth: controlWidth });
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
  }, [controlWidth, leftWidth, settings]);

  useEffect(() => {
    void boot();
    const off = window.autoagent.onAgentEvent(handleAgentEvent);
    const offArtifacts = window.autoagent.onArtifactEvent((payload) => {
      const event = payload as { kind?: string; artifacts?: ArtifactRecord[] };
      if (event.kind === 'changed' && Array.isArray(event.artifacts)) {
        setArtifacts(event.artifacts);
      } else {
        void refreshArtifacts();
      }
    });
    return () => {
      off();
      offArtifacts();
    };
  }, []);

  async function boot() {
    try {
      const payload = (await window.autoagent.bootstrap()) as BootstrapPayload;
      setProviders(payload.providers);
      setSettings(payload.settings);
      setChats(payload.chats);
      setMcpServers(payload.mcpServers || []);
      setArtifacts(payload.artifacts || []);
      setStatus('Idle');

      if (payload.chats[0]) {
        await selectChat(payload.chats[0].id);
      } else {
        await createChat();
      }

      void refreshWorkspace(payload.settings.cwd);
      void refreshSkills(payload.settings.cwd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus('Bootstrap failed');
    }
  }

  async function reloadChats(selectId?: string) {
    const next = (await window.autoagent.listChats()) as ChatRecord[];
    setChats(next);
    const id = selectId || activeChatIdRef.current;
    const selected = next.find((chat) => chat.id === id) || next[0] || null;
    if (selected) {
      const full = (await window.autoagent.loadChat(selected.id)) as ChatRecord;
      setActiveChat(full);
    }
  }

  async function selectChat(id: string) {
    const chat = (await window.autoagent.loadChat(id)) as ChatRecord;
    setActiveChat(chat);
    setLiveMessages([]);
  }

  async function createChat() {
    const chat = (await window.autoagent.createChat()) as ChatRecord;
    setChats((prev) => [chat, ...prev]);
    setActiveChat(chat);
    setLiveMessages([]);
  }

  async function deleteChat(id: string) {
    if (running) return;
    await window.autoagent.deleteChat(id);
    await reloadChats(activeChat?.id === id ? undefined : activeChat?.id);
  }

  async function branchChat(id: string) {
    const branch = (await window.autoagent.branchChat(id)) as ChatRecord;
    setChats((prev) => [branch, ...prev]);
    setActiveChat(branch);
    setLiveMessages([]);
    setStatus('Branch created');
  }

  function collectSettings(): Settings {
    if (!settings) throw new Error('Settings are not loaded');
    return settings;
  }

  async function saveSettings() {
    if (!settings) return;
    const saved = (await window.autoagent.saveSettings(settings)) as Settings;
    setSettings(saved);
    setStatus('Settings saved');
    void refreshWorkspace(saved.cwd);
  }

  async function resolveProvider(providerId: string) {
    if (!settings) return;
    const next = { ...settings, providerId };
    const resolved = (await window.autoagent.resolveProvider(providerId, next)) as Partial<Settings>;
    setSettings({ ...next, ...resolved });
  }

  async function pickCwd() {
    const cwd = (await window.autoagent.selectCwd()) as string | null;
    if (!cwd || !settings) return;
    const next = { ...settings, cwd };
    setSettings(next);
    void refreshWorkspace(cwd);
    void refreshSkills(cwd);
  }

  async function submitPrompt(event?: React.FormEvent) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || running || !activeChat || !settings) return;

    setPrompt('');
    setStatus('Running');
    setLiveMessages([{ id: uid('user'), role: 'user', text, createdAt: Date.now(), live: true }]);

    const response = (await window.autoagent.sendPrompt({
      chatId: activeChat.id,
      prompt: text,
      settings: collectSettings(),
    })) as { runId: string };
    setActiveRunId(response.runId);
  }

  function appendAssistantDelta(text: string) {
    setLiveMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = { ...last, text: last.text + text };
      } else {
        next.push({ id: uid('assistant'), role: 'assistant', text, createdAt: Date.now(), live: true });
      }
      return next;
    });
  }

  function setAssistantText(text: string) {
    setLiveMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') next[next.length - 1] = { ...last, text };
      else next.push({ id: uid('assistant'), role: 'assistant', text, createdAt: Date.now(), live: true });
      return next;
    });
  }

  function appendTool(text: string) {
    setLiveMessages((prev) => [...prev, { id: uid('tool'), role: 'tool', text, createdAt: Date.now(), live: true }]);
  }

  function handleAgentEvent(payload: unknown) {
    const event = payload as AgentEvent;
    if (!activeChatIdRef.current || event.chatId !== activeChatIdRef.current) return;

    if (event.kind === 'partial_message' && event.text) {
      appendAssistantDelta(event.text);
    } else if (event.kind === 'assistant' && event.text) {
      setAssistantText(event.text);
    } else if (event.kind === 'tool_result' && event.text) {
      appendTool(event.text);
    } else if (event.kind === 'error') {
      setLiveMessages((prev) => [...prev, { id: uid('system'), role: 'system', text: event.text || 'Unknown error', createdAt: Date.now(), live: true }]);
      setStatus('Error');
      setActiveRunId(null);
    } else if (event.kind === 'done') {
      setStatus('Idle');
      setActiveRunId(null);
      setLiveMessages([]);
      void reloadChats(activeChatIdRef.current || undefined);
    }
  }

  async function stopRun() {
    if (!activeRunId) return;
    await window.autoagent.stopRun(activeRunId);
    setActiveRunId(null);
    setStatus('Stopped');
  }

  async function refreshMcpServers() {
    setMcpServers((await window.autoagent.listMcpServers()) as McpServer[]);
  }

  function loadMcpForm(server: McpServer) {
    const config = server.config;
    setMcpForm({
      id: server.id,
      displayId: server.displayId,
      type: typeof config.type === 'string' ? config.type : 'stdio',
      command: [config.command, ...((config.args as string[] | undefined) || [])].filter(Boolean).join(' '),
      url: typeof config.url === 'string' ? config.url : '',
      env: envObjectToText(config.env || config.headers),
      enabled: server.enabled,
    });
    setPanel('mcp');
    setRightOpen(true);
  }

  async function saveMcpForm() {
    const env = parseEnvText(mcpForm.env);
    const config =
      mcpForm.type === 'http' || mcpForm.type === 'sse'
        ? { type: mcpForm.type, url: mcpForm.url.trim(), headers: env }
        : { type: 'stdio', ...splitCommandLine(mcpForm.command), env };
    await window.autoagent.saveMcpServer({
      id: mcpForm.id || undefined,
      displayId: mcpForm.displayId.trim(),
      displayName: mcpForm.displayId.trim(),
      enabled: mcpForm.enabled,
      autoRun: false,
      config,
    });
    setMcpForm(defaultMcpForm);
    await refreshMcpServers();
    setStatus('MCP saved');
  }

  async function discoverMcpTools(input?: { id?: string; enabledOnly?: boolean }) {
    setStatus('Discovering MCP tools');
    const results = (await window.autoagent.discoverMcpTools(input || { enabledOnly: true })) as McpDiscoveryResult[];
    setMcpDiscovery(results);
    setStatus('MCP discovery complete');
  }

  async function refreshSkills(cwd = settings?.cwd || '') {
    if (!cwd) return;
    const result = (await window.autoagent.listSkills(cwd)) as { skills: SkillInfo[]; dirs: SkillDir[] };
    setSkills(result.skills);
    setSkillDirs(result.dirs);
  }

  async function toggleSkill(skill: SkillInfo) {
    await window.autoagent.toggleSkill(skill.name, !skill.enabled, skill.path);
    const nextSkills = skills.map((item) => (item.name === skill.name ? { ...item, enabled: !item.enabled } : item));
    setSkills(nextSkills);
    if (!settings) return;
    const enabledNames = nextSkills.filter((item) => item.enabled).map((item) => item.name);
    const lines = settings.appendSystemPrompt.split('\n').filter((line) => !line.startsWith('# skill:'));
    if (enabledNames.length) lines.push(`# skill: ${enabledNames.join(', ')}`);
    setSettings({ ...settings, appendSystemPrompt: lines.join('\n').trim() });
  }

  async function refreshWorkspace(cwd = settings?.cwd || '') {
    if (!cwd) return;
    setGitStatus((await window.autoagent.gitStatus(cwd)) as GitStatus);
  }

  async function refreshArtifacts() {
    setArtifacts((await window.autoagent.listArtifacts()) as ArtifactRecord[]);
  }

  async function createArtifact(input: { title?: string; description?: string; html: string }) {
    const artifact = (await window.autoagent.createArtifact(input)) as ArtifactRecord;
    await refreshArtifacts();
    return artifact;
  }

  async function openArtifact(record: ArtifactRecord) {
    await window.autoagent.openArtifact({ path: record.path, title: record.title });
    await refreshArtifacts();
  }

  async function exportArtifact(record: ArtifactRecord) {
    await window.autoagent.exportArtifact({ id: record.id });
  }

  async function importArtifact() {
    await window.autoagent.importArtifact();
    await refreshArtifacts();
  }

  async function showArtifactVersions(record: ArtifactRecord) {
    const versions = (await window.autoagent.listArtifactVersions({ id: record.id })) as Array<{ timestamp: number; path: string }>;
    const message = versions.length
      ? versions.map((item) => new Date(item.timestamp).toLocaleString()).join('\n')
      : 'No saved versions yet';
    window.alert(`${record.title}\n\n${message}`);
  }

  if (error) {
    return <div className="fatal"><strong>Bootstrap failed</strong><pre>{error}</pre></div>;
  }

  return (
    <div
      className={`shell ${leftOpen ? 'left-open' : 'left-closed'} ${rightOpen ? 'right-open' : 'right-closed'}`}
      style={{
        ['--left-width' as '--left-width']: `${leftWidth}px`,
        ['--control-width' as '--control-width']: `${controlWidth}px`,
      }}
    >
      {leftOpen ? (
        <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Bot size={18} /></div>
          <div><strong>AutoAgent</strong><span>{settings?.model || 'loading'}</span></div>
        </div>
        <button className="primary wide" onClick={() => void createChat()}><MessageSquarePlus size={16} />New session</button>
        <div className="sidebar-section">Sessions</div>
        <div className="chat-list">
          {chats.map((chat) => (
            <div className="chat-row" key={chat.id}>
              <button className={`chat ${chat.id === activeChat?.id ? 'active' : ''}`} onClick={() => void selectChat(chat.id)}>
                <span>{chat.title}</span>
                <em>{new Date(chat.updatedAt).toLocaleDateString()}</em>
              </button>
              <button className="icon ghost" title="Branch session" onClick={() => void branchChat(chat.id)}><GitFork size={15} /></button>
              <button className="icon ghost danger" title="Delete session" onClick={() => void deleteChat(chat.id)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
        </aside>
      ) : null}

      {leftOpen ? (
        <div
          className="panel-resizer left"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize session sidebar"
          onPointerDown={(event) => {
            resizingPaneRef.current = 'left';
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            event.preventDefault();
          }}
        />
      ) : null}

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{activeChat?.title || 'New session'}</h1>
            <p><span className={`run-dot ${running ? 'on' : ''}`} />{status} · {settings?.cwd}</p>
          </div>
          <div className="topbar-actions">
            <button className="ghost" onClick={() => {
              const next = !leftOpen;
              setLeftOpen(next);
              persistLayout({ leftSidebarOpen: next });
            }}>
              {leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <button className="ghost" disabled={!running} onClick={() => void stopRun()}>{running ? <Square size={16} /> : <Circle size={16} />}Stop</button>
            <button className="ghost" onClick={() => {
              const next = !rightOpen;
              setRightOpen(next);
              persistLayout({ rightPanelOpen: next });
            }}>
              {rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>
        </header>

        <section className="messages" ref={messagesRef}>
          {visibleMessages.length === 0 ? <EmptyState /> : visibleMessages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              onCreateArtifact={createArtifact}
            />
          ))}
        </section>

        <form className="composer" onSubmit={(event) => void submitPrompt(event)}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submitPrompt();
            }}
            placeholder="Message AutoAgent"
            rows={4}
          />
          <div className="composer-actions">
            <span>{settings?.providerId} · {settings?.maxTurns} turns</span>
            <button className="primary" disabled={!prompt.trim() || running} type="submit">{running ? <Loader2 className="spin" size={16} /> : <Play size={16} />}Send</button>
          </div>
        </form>
      </main>

      {rightOpen && settings ? (
        <>
          <div
            className="panel-resizer right"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize control panel"
            onPointerDown={(event) => {
              resizingPaneRef.current = 'right';
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
              event.preventDefault();
            }}
          />
          <ControlPanel
            panel={panel}
            setPanel={setPanel}
            settings={settings}
            setSettings={setSettings}
            providers={providerOptions}
            modelOptions={modelOptions}
            resolveProvider={resolveProvider}
            saveSettings={saveSettings}
            pickCwd={pickCwd}
            mcpServers={mcpServers}
            mcpForm={mcpForm}
            setMcpForm={setMcpForm}
            loadMcpForm={loadMcpForm}
            saveMcpForm={saveMcpForm}
            discoverMcpTools={discoverMcpTools}
            mcpDiscovery={mcpDiscovery}
            skills={skills}
            skillDirs={skillDirs}
            toggleSkill={toggleSkill}
            refreshSkills={() => void refreshSkills(settings.cwd)}
            gitStatus={gitStatus}
            refreshWorkspace={() => void refreshWorkspace(settings.cwd)}
            artifacts={artifacts}
            openArtifact={openArtifact}
            refreshArtifacts={() => void refreshArtifacts()}
            exportArtifact={exportArtifact}
            importArtifact={importArtifact}
            showArtifactVersions={showArtifactVersions}
          />
        </>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <Bot size={28} />
      <strong>Ready for repository work</strong>
      <span>Ask about files, diffs, MCP tools, or implementation tasks.</span>
    </div>
  );
}

function MessageView({
  message,
  onCreateArtifact,
}: {
  message: ChatMessage;
  onCreateArtifact: (input: { title?: string; description?: string; html: string }) => Promise<ArtifactRecord>;
}) {
  const icon = message.role === 'assistant' ? <Bot size={15} /> : message.role === 'tool' ? <Wrench size={15} /> : message.role === 'system' ? <Settings2 size={15} /> : <Circle size={15} />;
  return (
    <article className={`message ${message.role}`}>
      <div className="message-role">{icon}<span>{message.role}</span></div>
      <div className="message-body">
        {message.role === 'tool' ? (
          <pre>{message.text}</pre>
        ) : (
          <MessageContent
            text={message.text}
            onOpenLink={(url) => void window.autoagent.openExternal(url)}
            onCreateArtifact={onCreateArtifact}
          />
        )}
      </div>
    </article>
  );
}

function ControlPanel(props: {
  panel: Panel;
  setPanel: (panel: Panel) => void;
  settings: Settings;
  setSettings: (settings: Settings) => void;
  providers: Array<{ id: string; name: string }>;
  modelOptions: string[];
  resolveProvider: (providerId: string) => Promise<void>;
  saveSettings: () => Promise<void>;
  pickCwd: () => Promise<void>;
  mcpServers: McpServer[];
  mcpForm: typeof defaultMcpForm;
  setMcpForm: (form: typeof defaultMcpForm) => void;
  loadMcpForm: (server: McpServer) => void;
  saveMcpForm: () => Promise<void>;
  discoverMcpTools: (input?: { id?: string; enabledOnly?: boolean }) => Promise<void>;
  mcpDiscovery: McpDiscoveryResult[];
  skills: SkillInfo[];
  skillDirs: SkillDir[];
  toggleSkill: (skill: SkillInfo) => Promise<void>;
  refreshSkills: () => void;
  gitStatus: GitStatus | null;
  refreshWorkspace: () => void;
  artifacts: ArtifactRecord[];
  openArtifact: (record: ArtifactRecord) => Promise<void>;
  refreshArtifacts: () => void;
  exportArtifact: (record: ArtifactRecord) => Promise<void>;
  importArtifact: () => Promise<void>;
  showArtifactVersions: (record: ArtifactRecord) => Promise<void>;
}) {
  const tabs: Array<[Panel, React.ReactNode, string]> = [
    ['skills', <Boxes size={15} />, 'Skills'],
    ['agent', <Settings2 size={15} />, 'Agent'],
    ['mcp', <Plug size={15} />, 'MCP'],
    ['workspace', <FolderGit2 size={15} />, 'Workspace'],
    ['artifacts', <LayoutPanelTop size={15} />, 'Artifacts'],
  ];

  return (
    <aside className="control">
      <div className="control-head">
        <div><strong>Control</strong><span>{props.settings.providerId}</span></div>
        <button className="primary" onClick={() => void props.saveSettings()}><Save size={15} />Save</button>
      </div>
      <div className="panel-tabs">
        {tabs.map(([id, icon, label]) => <button key={id} className={props.panel === id ? 'active' : ''} onClick={() => props.setPanel(id)}>{icon}{label}</button>)}
      </div>
      <div className="panel-body">
        {props.panel === 'agent' && <AgentPanel {...props} />}
        {props.panel === 'mcp' && <McpPanel {...props} />}
        {props.panel === 'skills' && <SkillsPanel {...props} />}
        {props.panel === 'workspace' && <WorkspacePanel {...props} />}
        {props.panel === 'artifacts' && <ArtifactsPanel {...props} />}
      </div>
    </aside>
  );
}

function AgentPanel(props: React.ComponentProps<typeof ControlPanel>) {
  const { settings, setSettings } = props;
  return (
    <div className="form-grid">
      <Field label="OpenCC command"><input value={settings.claudeCommand} onChange={(e) => setSettings({ ...settings, claudeCommand: e.target.value })} placeholder="opencc" /></Field>
      <Field label="OpenCC config dir"><input value={settings.claudeConfigDir} onChange={(e) => setSettings({ ...settings, claudeConfigDir: e.target.value })} /></Field>
      <Field label="Provider"><select value={settings.providerId} onChange={(e) => void props.resolveProvider(e.target.value)}>{props.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="API type"><select value={settings.apiType} onChange={(e) => setSettings({ ...settings, apiType: e.target.value })}><option value="anthropic-messages">Anthropic messages</option><option value="codex-completions">Codex compatible</option></select></Field>
      <Field label="Model"><input value={settings.model} list="model-options" onChange={(e) => setSettings({ ...settings, model: e.target.value })} /><datalist id="model-options">{props.modelOptions.map((model) => <option key={model} value={model} />)}</datalist></Field>
      <Field label="Fallback model"><input value={settings.fallbackModel} onChange={(e) => setSettings({ ...settings, fallbackModel: e.target.value })} /></Field>
      <Field
        label="Agent profile"
        hint="Optional. Fill this only if your OpenCC/Claude setup defines a named agent profile to load with `--agent`."
      >
        <input
          value={settings.agentName}
          onChange={(e) => setSettings({ ...settings, agentName: e.target.value })}
          placeholder="Leave empty for the default agent"
        />
      </Field>
      <Field label="Base URL"><input value={settings.baseURL} onChange={(e) => setSettings({ ...settings, baseURL: e.target.value })} /></Field>
      <Field label="API key"><input type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} /></Field>
      <Field label="Workspace"><div className="inline-field"><input value={settings.cwd} onChange={(e) => setSettings({ ...settings, cwd: e.target.value })} /><button className="ghost" onClick={() => void props.pickCwd()} type="button">Choose</button></div></Field>
      <Field label="Permission"><select value={settings.permissionMode} onChange={(e) => setSettings({ ...settings, permissionMode: e.target.value })}><option value="bypassPermissions">Bypass</option><option value="acceptEdits">Accept edits</option><option value="auto">Auto</option><option value="default">Default</option></select></Field>
      <Field label="Thinking"><select value={settings.thinkingMode} onChange={(e) => setSettings({ ...settings, thinkingMode: e.target.value })}><option value="">default</option><option value="adaptive">adaptive</option><option value="enabled">enabled</option><option value="disabled">disabled</option></select></Field>
      <Field label="Effort"><select value={settings.effort} onChange={(e) => setSettings({ ...settings, effort: e.target.value })}><option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="max">max</option></select></Field>
      <Field label="Max thinking tokens"><input type="number" min={0} value={settings.maxThinkingTokens ?? ''} onChange={(e) => setSettings({ ...settings, maxThinkingTokens: e.target.value === '' ? null : Number(e.target.value) || 0 })} /></Field>
      <Field label="Thinking display"><input value={settings.thinkingDisplay} onChange={(e) => setSettings({ ...settings, thinkingDisplay: e.target.value })} /></Field>
      <Field label="Max budget USD"><input type="number" min={0} step="0.01" value={settings.maxBudgetUsd ?? ''} onChange={(e) => setSettings({ ...settings, maxBudgetUsd: e.target.value === '' ? null : Number(e.target.value) || 0 })} /></Field>
      <Field label="Task budget"><input type="number" min={0} value={settings.taskBudget ?? ''} onChange={(e) => setSettings({ ...settings, taskBudget: e.target.value === '' ? null : Number(e.target.value) || 0 })} /></Field>
      <Field label="Max turns"><input type="number" min={1} value={settings.maxTurns} onChange={(e) => setSettings({ ...settings, maxTurns: Number(e.target.value) || 1024 })} /></Field>
      <Field label="Allowed tools"><input value={settings.allowedTools.join(', ')} onChange={(e) => setSettings({ ...settings, allowedTools: splitList(e.target.value) })} /></Field>
      <Field label="Disallowed tools"><input value={settings.disallowedTools.join(', ')} onChange={(e) => setSettings({ ...settings, disallowedTools: splitList(e.target.value) })} /></Field>
      <Field label="Tools arg"><input value={settings.tools} onChange={(e) => setSettings({ ...settings, tools: e.target.value })} placeholder="default" /></Field>
      <Field label="Permission prompt tool"><input value={settings.permissionPromptTool} onChange={(e) => setSettings({ ...settings, permissionPromptTool: e.target.value })} /></Field>
      <Field label="Betas"><input value={settings.betas.join(', ')} onChange={(e) => setSettings({ ...settings, betas: splitList(e.target.value) })} /></Field>
      <Field label="MCP config"><textarea rows={3} value={settings.mcpConfig.join('\n')} onChange={(e) => setSettings({ ...settings, mcpConfig: splitLines(e.target.value) })} /></Field>
      <Field label="Add dir"><textarea rows={2} value={settings.addDirs.join('\n')} onChange={(e) => setSettings({ ...settings, addDirs: splitLines(e.target.value) })} /></Field>
      <Field label="Channels"><input value={settings.channels.join(', ')} onChange={(e) => setSettings({ ...settings, channels: splitList(e.target.value) })} /></Field>
      <Field label="Setting sources"><input value={settings.settingSources} onChange={(e) => setSettings({ ...settings, settingSources: e.target.value })} /></Field>
      <Field label="Plugin dir"><input value={settings.pluginDir} onChange={(e) => setSettings({ ...settings, pluginDir: e.target.value })} /></Field>
      <Field label="Managed settings"><input value={settings.managedSettings} onChange={(e) => setSettings({ ...settings, managedSettings: e.target.value })} /></Field>
      <Field label="Session ID"><input value={settings.sessionId} onChange={(e) => setSettings({ ...settings, sessionId: e.target.value })} /></Field>
      <Field label="Resume session at"><input value={settings.resumeSessionAt} onChange={(e) => setSettings({ ...settings, resumeSessionAt: e.target.value })} /></Field>
      <Field label="JSON schema"><textarea rows={4} value={settings.jsonSchema} onChange={(e) => setSettings({ ...settings, jsonSchema: e.target.value })} /></Field>
      <Field label="Debug file"><input value={settings.debugFile} onChange={(e) => setSettings({ ...settings, debugFile: e.target.value })} /></Field>
      <Field label="Extra CLI args"><textarea rows={4} value={settings.extraCliArgs} onChange={(e) => setSettings({ ...settings, extraCliArgs: e.target.value })} placeholder="--plugin-dir C:\\path --assistant" /></Field>
      <div className="stack">
        <label className="check-row"><input type="checkbox" checked={settings.allowDangerouslySkipPermissions} onChange={(e) => setSettings({ ...settings, allowDangerouslySkipPermissions: e.target.checked })} />Allow dangerously skip permissions</label>
        <label className="check-row"><input type="checkbox" checked={settings.strictMcpConfig} onChange={(e) => setSettings({ ...settings, strictMcpConfig: e.target.checked })} />Strict MCP config</label>
        <label className="check-row"><input type="checkbox" checked={settings.continueSession} onChange={(e) => setSettings({ ...settings, continueSession: e.target.checked })} />Use `--continue` when no session id exists</label>
        <label className="check-row"><input type="checkbox" checked={settings.forkSession} onChange={(e) => setSettings({ ...settings, forkSession: e.target.checked })} />Fork resumed session</label>
        <label className="check-row"><input type="checkbox" checked={settings.noSessionPersistence} onChange={(e) => setSettings({ ...settings, noSessionPersistence: e.target.checked })} />No session persistence (single-run experiments only)</label>
        <p className="field-hint">Desktop chat ignores this during sends so follow-up turns can keep working across the same session.</p>
        <label className="check-row"><input type="checkbox" checked={settings.includePartialMessages} onChange={(e) => setSettings({ ...settings, includePartialMessages: e.target.checked })} />Include partial messages</label>
        <label className="check-row"><input type="checkbox" checked={settings.includeHookEvents} onChange={(e) => setSettings({ ...settings, includeHookEvents: e.target.checked })} />Include hook events</label>
        <label className="check-row"><input type="checkbox" checked={settings.assistant} onChange={(e) => setSettings({ ...settings, assistant: e.target.checked })} />Assistant mode</label>
        <label className="check-row"><input type="checkbox" checked={settings.debug} onChange={(e) => setSettings({ ...settings, debug: e.target.checked })} />Debug</label>
        <label className="check-row"><input type="checkbox" checked={settings.verbose} onChange={(e) => setSettings({ ...settings, verbose: e.target.checked })} />Verbose</label>
      </div>
    </div>
  );
}

function McpPanel(props: React.ComponentProps<typeof ControlPanel>) {
  const urlMode = props.mcpForm.type === 'http' || props.mcpForm.type === 'sse';
  return (
    <div className="stack">
      <PanelTitle title="MCP servers" action={<button className="ghost" onClick={() => void props.discoverMcpTools({ enabledOnly: true })}><SearchCode size={15} />Discover</button>} />
      <div className="item-list">
        {props.mcpServers.map((server) => (
          <div className="mcp-row" key={server.id}>
            <span className={`status-pill ${server.enabled ? 'ok' : ''}`}>{server.enabled ? 'on' : 'off'}</span>
            <button className="item-main" onClick={() => props.loadMcpForm(server)}><strong>{server.displayName || server.displayId}</strong><span>{formatMcpDetail(server.config)}</span></button>
            <button className="ghost" onClick={() => void props.discoverMcpTools({ id: server.id, enabledOnly: false })}>Tools</button>
          </div>
        ))}
      </div>
      <div className="editor-card">
        <Field label="Display ID"><input value={props.mcpForm.displayId} onChange={(e) => props.setMcpForm({ ...props.mcpForm, displayId: e.target.value })} /></Field>
        <Field label="Transport"><select value={props.mcpForm.type} onChange={(e) => props.setMcpForm({ ...props.mcpForm, type: e.target.value })}><option value="stdio">stdio</option><option value="http">streamable HTTP</option><option value="sse">SSE</option></select></Field>
        {urlMode ? <Field label="URL"><input value={props.mcpForm.url} onChange={(e) => props.setMcpForm({ ...props.mcpForm, url: e.target.value })} /></Field> : <Field label="Command"><input value={props.mcpForm.command} onChange={(e) => props.setMcpForm({ ...props.mcpForm, command: e.target.value })} /></Field>}
        <Field label="Env / Headers"><textarea rows={4} value={props.mcpForm.env} onChange={(e) => props.setMcpForm({ ...props.mcpForm, env: e.target.value })} /></Field>
        <label className="check-row"><input type="checkbox" checked={props.mcpForm.enabled} onChange={(e) => props.setMcpForm({ ...props.mcpForm, enabled: e.target.checked })} />Enabled</label>
        <div className="button-row"><button className="primary" onClick={() => void props.saveMcpForm()}><Save size={15} />Save MCP</button><button className="ghost" onClick={() => props.setMcpForm(defaultMcpForm)}><X size={15} />Clear</button></div>
      </div>
      {props.mcpDiscovery.map((result) => <div className={`discovery-card ${result.status === 'connected' ? 'ok' : 'error'}`} key={result.id}><strong>{result.displayId}</strong><span>{result.status} · {result.durationMs}ms · {result.tools.length} tools</span>{result.error ? <em>{result.error}</em> : null}<div className="chip-list">{result.tools.slice(0, 24).map((tool) => <span key={tool.name}>{tool.name}</span>)}</div></div>)}
    </div>
  );
}

function formatArtifactTime(timestamp: number | null): string {
  if (!timestamp) return 'Never opened';
  return new Date(timestamp).toLocaleString();
}

function ArtifactsPanel(props: React.ComponentProps<typeof ControlPanel>) {
  return (
    <div className="stack">
      <PanelTitle
        title={`${props.artifacts.length} artifacts`}
        action={<div className="button-row"><button className="ghost" onClick={() => void props.importArtifact()}>Import</button><button className="ghost" onClick={props.refreshArtifacts}><RefreshCw size={15} />Refresh</button></div>}
      />
      <div className="item-list">
        {props.artifacts.length === 0 ? (
          <div className="editor-card">
            <strong>No artifacts yet</strong>
            <span>Generate an `artifact-html` block in chat to create a persistent artifact.</span>
          </div>
        ) : props.artifacts.map((artifact) => (
          <div className="artifact-row" key={artifact.id}>
            <button className="item-main artifact-main" onClick={() => void props.openArtifact(artifact)}>
              <strong>{artifact.title}</strong>
              <span>{artifact.description || 'No description'}</span>
              <small>Updated {new Date(artifact.updatedAt).toLocaleString()}</small>
              <small>{formatArtifactTime(artifact.lastOpenedAt)}</small>
              <small>{artifact.versions?.length || 0} saved versions</small>
            </button>
            <div className="artifact-actions-col">
              <button className="ghost" onClick={() => void props.openArtifact(artifact)}>Open</button>
              <button className="ghost" onClick={() => void props.showArtifactVersions(artifact)}>Versions</button>
              <button className="ghost" onClick={() => void props.exportArtifact(artifact)}>Export</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillsPanel(props: React.ComponentProps<typeof ControlPanel>) {
  const enabled = props.skills.filter((skill) => skill.enabled).length;
  return (
    <div className="stack">
      <PanelTitle title={`${enabled} enabled / ${props.skills.length} total`} action={<button className="ghost" onClick={props.refreshSkills}><RefreshCw size={15} />Scan</button>} />
      <div className="item-list">
        {props.skills.map((skill) => (
          <button className="skill-row" key={`${skill.source}-${skill.name}`} onClick={() => void props.toggleSkill(skill)}>
            <span className={`check-dot ${skill.enabled ? 'on' : ''}`}>{skill.enabled ? <Check size={13} /> : null}</span>
            <span><strong>{skill.name}</strong><em>{skill.description || 'No description'}</em><small>{skill.source} · {skill.path}</small></span>
          </button>
        ))}
      </div>
      <PanelTitle title="Skill dirs" />
      <div className="chip-list vertical">{props.skillDirs.map((dir) => <span key={`${dir.source}-${dir.path}`}>{dir.source}: {dir.exists ? dir.path : `${dir.path} (not found)`}</span>)}</div>
    </div>
  );
}

function WorkspacePanel(props: React.ComponentProps<typeof ControlPanel>) {
  const stat = props.gitStatus?.stat;
  return (
    <div className="stack">
      <PanelTitle title="Git review" action={<button className="ghost" onClick={props.refreshWorkspace}><RefreshCw size={15} />Refresh</button>} />
      <div className="stat-grid">
        <div><span>repo</span><strong>{stat?.isGitRepo ? 'yes' : 'no'}</strong></div>
        <div><span>files</span><strong>{stat?.changedFiles || 0}</strong></div>
        <div><span>+</span><strong>{stat?.additions || 0}</strong></div>
        <div><span>-</span><strong>{stat?.deletions || 0}</strong></div>
      </div>
      {props.gitStatus?.errors.map((item) => <p className="panel-error" key={item}>{item}</p>)}
      <PanelTitle title="Branches" />
      <div className="chip-list">{props.gitStatus?.branches.slice(0, 12).map((branch) => <span key={branch.name}><GitBranch size={12} />{branch.name}</span>)}</div>
      <PanelTitle title="Changed files" />
      <div className="diff-list">{props.gitStatus?.files?.files.slice(0, 24).map((file) => <div key={file.path}><span>{file.status}</span><strong>{file.path}</strong><em>+{file.additions} -{file.deletions}</em></div>)}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

function PanelTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div className="panel-title"><strong>{title}</strong>{action}</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
