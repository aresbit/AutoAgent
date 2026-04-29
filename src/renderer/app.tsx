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
  Loader2,
  MessageSquarePlus,
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

declare global {
  interface Window {
    autoagent: AutoAgentBridge;
  }
}

type Role = 'user' | 'assistant' | 'system' | 'tool';
type Panel = 'skills' | 'agent' | 'mcp' | 'workspace';

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
  providerId: string;
  apiType: string;
  model: string;
  apiKey: string;
  baseURL: string;
  cwd: string;
  permissionMode: string;
  maxTurns: number;
  allowedTools: string[];
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
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeChatIdRef = useRef<string | null>(null);

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
    void boot();
    const off = window.autoagent.onAgentEvent(handleAgentEvent);
    return () => {
      off();
    };
  }, []);

  async function boot() {
    try {
      const payload = (await window.autoagent.bootstrap()) as BootstrapPayload;
      setProviders(payload.providers);
      setSettings(payload.settings);
      setChats(payload.chats);
      setMcpServers(payload.mcpServers || []);
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
    await window.autoagent.toggleSkill(skill.name, !skill.enabled);
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

  if (error) {
    return <div className="fatal"><strong>Bootstrap failed</strong><pre>{error}</pre></div>;
  }

  return (
    <div className={`shell ${rightOpen ? 'right-open' : 'right-closed'}`}>
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

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{activeChat?.title || 'New session'}</h1>
            <p><span className={`run-dot ${running ? 'on' : ''}`} />{status} · {settings?.cwd}</p>
          </div>
          <div className="topbar-actions">
            <button className="ghost" disabled={!running} onClick={() => void stopRun()}>{running ? <Square size={16} /> : <Circle size={16} />}Stop</button>
            <button className="ghost" onClick={() => setRightOpen((value) => !value)}>
              {rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>
        </header>

        <section className="messages" ref={messagesRef}>
          {visibleMessages.length === 0 ? <EmptyState /> : visibleMessages.map((message) => <MessageView key={message.id} message={message} />)}
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
        />
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

function MessageView({ message }: { message: ChatMessage }) {
  const icon = message.role === 'assistant' ? <Bot size={15} /> : message.role === 'tool' ? <Wrench size={15} /> : message.role === 'system' ? <Settings2 size={15} /> : <Circle size={15} />;
  return (
    <article className={`message ${message.role}`}>
      <div className="message-role">{icon}<span>{message.role}</span></div>
      <pre>{message.text}</pre>
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
}) {
  const tabs: Array<[Panel, React.ReactNode, string]> = [
    ['skills', <Boxes size={15} />, 'Skills'],
    ['agent', <Settings2 size={15} />, 'Agent'],
    ['mcp', <Plug size={15} />, 'MCP'],
    ['workspace', <FolderGit2 size={15} />, 'Workspace'],
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
      </div>
    </aside>
  );
}

function AgentPanel(props: React.ComponentProps<typeof ControlPanel>) {
  const { settings, setSettings } = props;
  return (
    <div className="form-grid">
      <Field label="Provider"><select value={settings.providerId} onChange={(e) => void props.resolveProvider(e.target.value)}>{props.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="API type"><select value={settings.apiType} onChange={(e) => setSettings({ ...settings, apiType: e.target.value })}><option value="anthropic-messages">Anthropic messages</option><option value="codex-completions">Codex compatible</option></select></Field>
      <Field label="Model"><input value={settings.model} list="model-options" onChange={(e) => setSettings({ ...settings, model: e.target.value })} /><datalist id="model-options">{props.modelOptions.map((model) => <option key={model} value={model} />)}</datalist></Field>
      <Field label="Base URL"><input value={settings.baseURL} onChange={(e) => setSettings({ ...settings, baseURL: e.target.value })} /></Field>
      <Field label="API key"><input type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} /></Field>
      <Field label="Workspace"><div className="inline-field"><input value={settings.cwd} onChange={(e) => setSettings({ ...settings, cwd: e.target.value })} /><button className="ghost" onClick={() => void props.pickCwd()} type="button">Choose</button></div></Field>
      <Field label="Permission"><select value={settings.permissionMode} onChange={(e) => setSettings({ ...settings, permissionMode: e.target.value })}><option value="bypassPermissions">Bypass</option><option value="acceptEdits">Accept edits</option><option value="auto">Auto</option><option value="default">Default</option></select></Field>
      <Field label="Max turns"><input type="number" min={1} value={settings.maxTurns} onChange={(e) => setSettings({ ...settings, maxTurns: Number(e.target.value) || 1024 })} /></Field>
      <Field label="Allowed tools"><input value={settings.allowedTools.join(', ')} onChange={(e) => setSettings({ ...settings, allowedTools: e.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></Field>
      <Field label="System append"><textarea rows={7} value={settings.appendSystemPrompt} onChange={(e) => setSettings({ ...settings, appendSystemPrompt: e.target.value })} /></Field>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function PanelTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div className="panel-title"><strong>{title}</strong>{action}</div>;
}

createRoot(document.getElementById('root')!).render(<App />);
