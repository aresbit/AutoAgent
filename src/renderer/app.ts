import type { AutoAgentBridge } from '../preload';

declare global {
  interface Window {
    autoagent: AutoAgentBridge;
  }
}

type Role = 'user' | 'assistant' | 'system' | 'tool';

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

interface ProviderInfo {
  id: string;
  name: string;
  baseUrl?: string;
  models?: string[];
  type?: string;
}

interface BootstrapPayload {
  settings: Settings;
  providers: {
    builtin: ProviderInfo[];
    custom: ProviderInfo[];
  };
  chats: ChatRecord[];
  mcpServers: McpServer[];
  managedProviders: ProviderRecord[];
}

interface AgentEvent {
  runId: string;
  chatId: string;
  kind: string;
  text?: string;
  event?: unknown;
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

interface GitStatus {
  stat: { isGitRepo: boolean; additions: number; deletions: number; changedFiles: number } | null;
  branches: Array<{ name: string; isRemote: boolean }>;
  files: { isGitRepo: boolean; files: Array<{ path: string; status: string; additions: number; deletions: number }> };
  errors: string[];
}

const state: {
  settings: Settings | null;
  chats: ChatRecord[];
  activeChat: ChatRecord | null;
  activeRunId: string | null;
  draftAssistant: HTMLElement | null;
  mcpServers: McpServer[];
  providers: ProviderInfo[];
  managedProviders: ProviderRecord[];
} = {
  settings: null,
  chats: [],
  activeChat: null,
  activeRunId: null,
  draftAssistant: null,
  mcpServers: [],
  providers: [],
  managedProviders: [],
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};

const elements = {
  chatList: $('#chat-list'),
  newChat: $('#new-chat') as HTMLButtonElement,
  chatTitle: $('#chat-title'),
  status: $('#status'),
  messages: $('#messages'),
  composer: $('#composer') as HTMLFormElement,
  prompt: $('#prompt') as HTMLTextAreaElement,
  stopRun: $('#stop-run') as HTMLButtonElement,
  toggleSettings: $('#toggle-settings') as HTMLButtonElement,
  provider: $('#provider') as HTMLSelectElement,
  apiType: $('#api-type') as HTMLSelectElement,
  model: $('#model') as HTMLInputElement,
  modelOptions: $('#model-options') as HTMLDataListElement,
  baseURL: $('#base-url') as HTMLInputElement,
  apiKey: $('#api-key') as HTMLInputElement,
  cwd: $('#cwd') as HTMLInputElement,
  cwdLabel: $('#cwd-label'),
  permission: $('#permission') as HTMLSelectElement,
  maxTurns: $('#max-turns') as HTMLInputElement,
  allowedTools: $('#allowed-tools') as HTMLInputElement,
  systemAppend: $('#system-append') as HTMLTextAreaElement,
  saveSettings: $('#save-settings') as HTMLButtonElement,
  pickCwd: $('#pick-cwd') as HTMLButtonElement,
  panelTabs: Array.from(document.querySelectorAll<HTMLButtonElement>('[data-panel-tab]')),
  panels: Array.from(document.querySelectorAll<HTMLElement>('.settings-panel')),
  mcpCount: $('#mcp-count'),
  mcpList: $('#mcp-list'),
  mcpId: $('#mcp-id') as HTMLInputElement,
  mcpDisplayId: $('#mcp-display-id') as HTMLInputElement,
  mcpType: $('#mcp-type') as HTMLSelectElement,
  mcpCommand: $('#mcp-command') as HTMLInputElement,
  mcpUrl: $('#mcp-url') as HTMLInputElement,
  mcpEnv: $('#mcp-env') as HTMLTextAreaElement,
  mcpEnabled: $('#mcp-enabled') as HTMLInputElement,
  saveMcp: $('#save-mcp') as HTMLButtonElement,
  resetMcp: $('#reset-mcp') as HTMLButtonElement,
  discoverMcp: $('#discover-mcp') as HTMLButtonElement,
  mcpDiscovery: $('#mcp-discovery'),
  providerCount: $('#provider-count'),
  providerList: $('#provider-list'),
  providerId: $('#provider-id') as HTMLInputElement,
  providerName: $('#provider-name') as HTMLInputElement,
  providerType: $('#provider-type') as HTMLSelectElement,
  providerBaseUrl: $('#provider-base-url') as HTMLInputElement,
  providerApiKey: $('#provider-api-key') as HTMLInputElement,
  providerModels: $('#provider-models') as HTMLTextAreaElement,
  saveProvider: $('#save-provider') as HTMLButtonElement,
  resetProvider: $('#reset-provider') as HTMLButtonElement,
  refreshWorkspace: $('#refresh-workspace') as HTMLButtonElement,
  gitSummary: $('#git-summary'),
  branchList: $('#branch-list'),
  diffFiles: $('#diff-files'),
};

function setActivePanel(panelId: string): void {
  for (const tab of elements.panelTabs) tab.classList.toggle('active', tab.dataset.panelTab === panelId);
  for (const panel of elements.panels) panel.classList.toggle('active', panel.id === `panel-${panelId}`);
}

function renderProviderOptions(payload: BootstrapPayload): void {
  const map = new Map<string, ProviderInfo>();
  for (const provider of [...payload.providers.builtin, ...payload.providers.custom]) map.set(provider.id, provider);
  const providers = [...map.values()];
  state.providers = providers;
  elements.provider.replaceChildren(
    ...providers.map((provider) => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      return option;
    }),
  );
  renderModelOptions(elements.provider.value);
}

function renderModelOptions(providerId: string): void {
  const provider = state.providers.find((entry) => entry.id === providerId);
  elements.modelOptions.replaceChildren(
    ...((provider?.models || []).map((model) => {
      const option = document.createElement('option');
      option.value = model;
      return option;
    })),
  );
}

function renderSettings(settings: Settings): void {
  state.settings = settings;
  elements.provider.value = settings.providerId;
  elements.apiType.value = settings.apiType;
  elements.model.value = settings.model;
  elements.baseURL.value = settings.baseURL;
  elements.apiKey.value = settings.apiKey;
  elements.cwd.value = settings.cwd;
  elements.cwdLabel.textContent = settings.cwd;
  elements.permission.value = settings.permissionMode;
  elements.maxTurns.value = String(settings.maxTurns);
  elements.allowedTools.value = settings.allowedTools.join(', ');
  elements.systemAppend.value = settings.appendSystemPrompt;
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

function renderMcpServers(): void {
  const enabled = state.mcpServers.filter((server) => server.enabled).length;
  elements.mcpCount.textContent = `${enabled} enabled`;
  elements.mcpList.replaceChildren(
    ...state.mcpServers.map((server) => {
      const row = document.createElement('div');
      row.className = 'mcp-row';

      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = server.enabled;
      check.onchange = async () => {
        await window.autoagent.toggleMcpServer(server.id, check.checked);
        await refreshMcpServers();
      };

      const meta = document.createElement('div');
      meta.className = 'mcp-meta';
      const title = document.createElement('strong');
      title.textContent = server.displayName || server.displayId;
      const detail = document.createElement('span');
      const config = server.config;
      detail.textContent =
        config.type === 'http' || config.type === 'sse'
          ? `${config.type}: ${String(config.url || '')}`
          : `stdio: ${String(config.command || '')} ${(config.args as string[] | undefined)?.join(' ') || ''}`.trim();
      meta.append(title, detail);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost icon-button';
      edit.textContent = 'Edit';
      edit.onclick = () => loadMcpForm(server);

      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.className = 'ghost icon-button';
      inspect.textContent = 'Tools';
      inspect.onclick = () => void discoverMcpTools({ id: server.id, enabledOnly: false });

      row.append(check, meta, edit, inspect);
      return row;
    }),
  );
}

async function refreshMcpServers(): Promise<void> {
  state.mcpServers = (await window.autoagent.listMcpServers()) as McpServer[];
  renderMcpServers();
}

function updateMcpEditorMode(): void {
  const isUrlTransport = elements.mcpType.value === 'http' || elements.mcpType.value === 'sse';
  document.body.classList.toggle('mcp-url-mode', isUrlTransport);
}

function loadMcpForm(server: McpServer): void {
  const config = server.config;
  elements.mcpId.value = server.id;
  elements.mcpDisplayId.value = server.displayId;
  elements.mcpType.value = typeof config.type === 'string' ? config.type : 'stdio';
  elements.mcpCommand.value = [config.command, ...((config.args as string[] | undefined) || [])].filter(Boolean).join(' ');
  elements.mcpUrl.value = typeof config.url === 'string' ? config.url : '';
  elements.mcpEnv.value = envObjectToText(config.env || config.headers);
  elements.mcpEnabled.checked = server.enabled;
  updateMcpEditorMode();
}

function clearMcpForm(): void {
  elements.mcpId.value = '';
  elements.mcpDisplayId.value = '';
  elements.mcpType.value = 'stdio';
  elements.mcpCommand.value = '';
  elements.mcpUrl.value = '';
  elements.mcpEnv.value = '';
  elements.mcpEnabled.checked = true;
  updateMcpEditorMode();
}

async function saveMcpForm(): Promise<void> {
  const type = elements.mcpType.value;
  const env = parseEnvText(elements.mcpEnv.value);
  const config =
    type === 'http' || type === 'sse'
      ? { type, url: elements.mcpUrl.value.trim(), headers: env }
      : { type: 'stdio', ...splitCommandLine(elements.mcpCommand.value), env };
  await window.autoagent.saveMcpServer({
    id: elements.mcpId.value || undefined,
    displayId: elements.mcpDisplayId.value.trim(),
    displayName: elements.mcpDisplayId.value.trim(),
    enabled: elements.mcpEnabled.checked,
    autoRun: false,
    config,
  });
  clearMcpForm();
  await refreshMcpServers();
  setStatus('MCP saved');
}

function renderMcpDiscovery(results: McpDiscoveryResult[]): void {
  elements.mcpDiscovery.replaceChildren(
    ...results.map((result) => {
      const card = document.createElement('div');
      card.className = `discovery-card ${result.status === 'connected' ? 'ok' : 'error'}`;
      const title = document.createElement('div');
      title.className = 'discovery-title';
      title.innerHTML = `<strong>${result.displayId}</strong><span>${result.status} · ${result.durationMs}ms · ${result.tools.length} tools</span>`;
      card.append(title);
      if (result.error) {
        const error = document.createElement('p');
        error.className = 'panel-error';
        error.textContent = result.error;
        card.append(error);
      }
      const tools = document.createElement('div');
      tools.className = 'tool-chip-list';
      tools.append(
        ...result.tools.slice(0, 24).map((tool) => {
          const chip = document.createElement('span');
          chip.className = 'tool-chip';
          chip.title = tool.description || tool.name;
          chip.textContent = tool.name;
          return chip;
        }),
      );
      card.append(tools);
      return card;
    }),
  );
}

async function discoverMcpTools(input?: { id?: string; enabledOnly?: boolean }): Promise<void> {
  elements.mcpDiscovery.textContent = 'Discovering MCP tools...';
  const results = (await window.autoagent.discoverMcpTools(input || { enabledOnly: true })) as McpDiscoveryResult[];
  renderMcpDiscovery(results);
  setStatus('MCP discovery complete');
}

function renderProviders(): void {
  elements.providerCount.textContent = `${state.managedProviders.length} managed`;
  elements.providerList.replaceChildren(
    ...state.managedProviders.map((provider) => {
      const row = document.createElement('div');
      row.className = 'provider-row';
      const meta = document.createElement('div');
      meta.className = 'mcp-meta';
      const title = document.createElement('strong');
      title.textContent = provider.name;
      const detail = document.createElement('span');
      detail.textContent = `${provider.id} · ${provider.baseUrl || 'no base URL'} · ${provider.models.length} models`;
      meta.append(title, detail);

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost icon-button';
      edit.textContent = 'Edit';
      edit.onclick = () => loadProviderForm(provider);
      row.append(meta, edit);
      return row;
    }),
  );
}

async function refreshProviders(): Promise<void> {
  state.managedProviders = (await window.autoagent.listProviders()) as ProviderRecord[];
  const payload = {
    settings: collectSettings(),
    providers: {
      builtin: state.providers.filter((provider) => !provider.id.startsWith('cus_')),
      custom: [
        ...state.providers.filter((provider) => provider.id.startsWith('cus_')),
        ...state.managedProviders.map((provider) => ({
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          models: provider.models,
          type: provider.type,
        })),
      ],
    },
    chats: state.chats,
    mcpServers: state.mcpServers,
    managedProviders: state.managedProviders,
  } satisfies BootstrapPayload;
  renderProviderOptions(payload);
  elements.provider.value = state.settings?.providerId || elements.provider.value;
  renderModelOptions(elements.provider.value);
  renderProviders();
}

function loadProviderForm(provider: ProviderRecord): void {
  elements.providerId.value = provider.id;
  elements.providerName.value = provider.name;
  elements.providerType.value = provider.type === 'anthropic' ? 'anthropic' : 'openai';
  elements.providerBaseUrl.value = provider.baseUrl;
  elements.providerApiKey.value = provider.apiKey;
  elements.providerModels.value = provider.models.join('\n');
}

function clearProviderForm(): void {
  elements.providerId.value = '';
  elements.providerName.value = '';
  elements.providerType.value = 'openai';
  elements.providerBaseUrl.value = '';
  elements.providerApiKey.value = '';
  elements.providerModels.value = '';
}

async function saveProviderForm(): Promise<void> {
  const id = elements.providerId.value.trim();
  await window.autoagent.saveProvider({
    id,
    name: elements.providerName.value.trim() || id,
    type: elements.providerType.value,
    baseUrl: elements.providerBaseUrl.value.trim(),
    apiKey: elements.providerApiKey.value.trim(),
    models: elements.providerModels.value
      .split(/\r?\n|,/)
      .map((model) => model.trim())
      .filter(Boolean),
  });
  clearProviderForm();
  await refreshProviders();
  setStatus('Provider saved');
}

function collectSettings(): Settings {
  const current = state.settings;
  if (!current) throw new Error('Settings are not loaded');
  return {
    ...current,
    providerId: elements.provider.value,
    apiType: elements.apiType.value,
    model: elements.model.value.trim(),
    baseURL: elements.baseURL.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    cwd: elements.cwd.value.trim(),
    permissionMode: elements.permission.value,
    maxTurns: Number(elements.maxTurns.value) || 10,
    allowedTools: elements.allowedTools.value
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean),
    appendSystemPrompt: elements.systemAppend.value.trim(),
  };
}

function renderChats(): void {
  elements.chatList.replaceChildren(
    ...state.chats.map((chat) => {
      const row = document.createElement('div');
      row.className = 'chat-row';

      const button = document.createElement('button');
      button.className = chat.id === state.activeChat?.id ? 'chat active' : 'chat';
      button.textContent = chat.title;
      button.onclick = () => void selectChat(chat.id);

      const branchBtn = document.createElement('button');
      branchBtn.className = 'chat-action ghost';
      branchBtn.textContent = '⎇';
      branchBtn.title = 'Branch session';
      branchBtn.onclick = async (e) => {
        e.stopPropagation();
        await branchChat(chat.id);
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'chat-action ghost danger';
      delBtn.textContent = '×';
      delBtn.title = 'Delete session';
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        await deleteChatAction(chat.id);
      };

      row.append(button, branchBtn, delBtn);
      return row;
    }),
  );
}

function renderMessages(chat: ChatRecord): void {
  elements.chatTitle.textContent = chat.title;
  elements.messages.replaceChildren();
  for (const message of chat.messages) appendMessageNode(message.role, message.text);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function appendMessageNode(role: Role, text: string): HTMLElement {
  const wrapper = document.createElement('article');
  wrapper.className = `message ${role}`;

  const label = document.createElement('span');
  label.className = 'role';
  label.textContent = role;

  const body = document.createElement('pre');
  body.textContent = text;

  wrapper.append(label, body);
  elements.messages.append(wrapper);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  return body;
}

function setStatus(text: string, running = false): void {
  elements.status.textContent = text;
  elements.stopRun.disabled = !running;
  elements.composer.classList.toggle('running', running);
}

async function selectChat(id: string): Promise<void> {
  const chat = (await window.autoagent.loadChat(id)) as ChatRecord;
  state.activeChat = chat;
  renderChats();
  renderMessages(chat);
}

async function refreshChats(): Promise<void> {
  state.chats = (await window.autoagent.listChats()) as ChatRecord[];
  renderChats();
}

async function createChat(): Promise<void> {
  const chat = (await window.autoagent.createChat()) as ChatRecord;
  state.chats = [chat, ...state.chats];
  state.activeChat = chat;
  renderChats();
  renderMessages(chat);
}

async function deleteChatAction(id: string): Promise<void> {
  if (state.activeRunId) return; // don't delete while running
  await window.autoagent.deleteChat(id);
  await refreshChats();
  if (state.activeChat?.id === id) {
    state.activeChat = state.chats[0] || null;
    if (state.activeChat) {
      await selectChat(state.activeChat.id);
    } else {
      await createChat();
    }
  }
}

async function branchChat(id: string): Promise<void> {
  const branch = (await window.autoagent.branchChat(id)) as ChatRecord;
  state.chats = [branch, ...state.chats];
  state.activeChat = branch;
  renderChats();
  renderMessages(branch);
  setStatus('Branch created');
}

async function saveSettings(): Promise<void> {
  const saved = (await window.autoagent.saveSettings(collectSettings())) as Settings;
  renderSettings(saved);
  setStatus('Settings saved');
  void refreshWorkspace();
}

function renderGitStatus(payload: GitStatus): void {
  elements.gitSummary.replaceChildren();
  const stat = payload.stat;
  const summary = document.createElement('div');
  summary.className = 'stat-grid';
  for (const [label, value] of [
    ['repo', stat?.isGitRepo ? 'yes' : 'no'],
    ['files', String(stat?.changedFiles || 0)],
    ['+', String(stat?.additions || 0)],
    ['-', String(stat?.deletions || 0)],
  ]) {
    const item = document.createElement('div');
    item.className = 'stat-item';
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    summary.append(item);
  }
  elements.gitSummary.append(summary);
  if (payload.errors.length) {
    const error = document.createElement('p');
    error.className = 'panel-error';
    error.textContent = payload.errors[0];
    elements.gitSummary.append(error);
  }

  elements.branchList.replaceChildren(
    ...payload.branches.slice(0, 12).map((branch) => {
      const pill = document.createElement('span');
      pill.className = branch.isRemote ? 'branch remote' : 'branch';
      pill.textContent = branch.name;
      return pill;
    }),
  );

  const files = payload.files?.files || [];
  elements.diffFiles.replaceChildren(
    ...files.slice(0, 24).map((file) => {
      const row = document.createElement('div');
      row.className = 'diff-row';
      row.innerHTML = `<span>${file.status}</span><strong>${file.path}</strong><em>+${file.additions} -${file.deletions}</em>`;
      return row;
    }),
  );
}

async function refreshWorkspace(): Promise<void> {
  const workDir = elements.cwd.value.trim();
  if (!workDir) return;
  elements.gitSummary.textContent = 'Loading...';
  const status = (await window.autoagent.gitStatus(workDir)) as GitStatus;
  renderGitStatus(status);
}

async function submitPrompt(prompt: string): Promise<void> {
  if (!state.activeChat) await createChat();
  if (!state.activeChat) return;

  appendMessageNode('user', prompt);
  state.draftAssistant = appendMessageNode('assistant', '');
  setStatus('Running', true);

  const response = (await window.autoagent.sendPrompt({
    chatId: state.activeChat.id,
    prompt,
    settings: collectSettings(),
  })) as { runId: string };
  state.activeRunId = response.runId;
}

function handleAgentEvent(payload: unknown): void {
  const event = payload as AgentEvent;
  if (!state.activeChat || event.chatId !== state.activeChat.id) return;

  if (event.kind === 'partial_message' && event.text && state.draftAssistant) {
    state.draftAssistant.textContent += event.text;
  } else if (event.kind === 'assistant' && event.text && state.draftAssistant) {
    state.draftAssistant.textContent = event.text;
  } else if (event.kind === 'tool_result' && event.text) {
    appendMessageNode('tool', event.text);
  } else if (event.kind === 'error') {
    appendMessageNode('system', event.text || 'Unknown error');
    setStatus('Error');
    state.activeRunId = null;
  } else if (event.kind === 'done') {
    setStatus('Idle');
    state.activeRunId = null;
    state.draftAssistant = null;
    void refreshChats();
  }

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

async function boot(): Promise<void> {
  const payload = (await window.autoagent.bootstrap()) as BootstrapPayload;
  renderProviderOptions(payload);
  renderSettings(payload.settings);
  state.chats = payload.chats;
  state.mcpServers = payload.mcpServers || [];
  state.managedProviders = payload.managedProviders || [];
  renderChats();
  renderMcpServers();
  renderProviders();
  updateMcpEditorMode();

  if (state.chats[0]) {
    await selectChat(state.chats[0].id);
  } else {
    await createChat();
  }

  window.autoagent.onAgentEvent(handleAgentEvent);
  void refreshWorkspace();
}

for (const tab of elements.panelTabs) tab.onclick = () => setActivePanel(tab.dataset.panelTab || 'runtime');
elements.newChat.onclick = () => void createChat();
elements.saveSettings.onclick = () => void saveSettings();
elements.pickCwd.onclick = async () => {
  const cwd = (await window.autoagent.selectCwd()) as string | null;
  if (cwd) {
    elements.cwd.value = cwd;
    elements.cwdLabel.textContent = cwd;
    void refreshWorkspace();
  }
};
elements.provider.onchange = async () => {
  const resolved = (await window.autoagent.resolveProvider(elements.provider.value, collectSettings())) as Partial<Settings>;
  if (resolved.apiType) elements.apiType.value = resolved.apiType;
  if (resolved.baseURL) elements.baseURL.value = resolved.baseURL;
  if (resolved.apiKey) elements.apiKey.value = resolved.apiKey;
  renderModelOptions(elements.provider.value);
};
let settingsVisible = true;
elements.toggleSettings.onclick = () => {
  settingsVisible = !settingsVisible;
  document.querySelector('.settings')?.classList.toggle('collapsed', !settingsVisible);
  document.body.classList.toggle('settings-hidden', !settingsVisible);
  elements.toggleSettings.textContent = settingsVisible ? '☰' : '◫';
};
elements.stopRun.onclick = async () => {
  if (!state.activeRunId) return;
  await window.autoagent.stopRun(state.activeRunId);
  setStatus('Stopped');
  state.activeRunId = null;
};
elements.mcpType.onchange = updateMcpEditorMode;
elements.saveMcp.onclick = () => void saveMcpForm();
elements.resetMcp.onclick = clearMcpForm;
elements.discoverMcp.onclick = () => void discoverMcpTools({ enabledOnly: true });
elements.saveProvider.onclick = () => void saveProviderForm();
elements.resetProvider.onclick = clearProviderForm;
elements.refreshWorkspace.onclick = () => void refreshWorkspace();
elements.composer.onsubmit = (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  if (!prompt || state.activeRunId) return;
  elements.prompt.value = '';
  void submitPrompt(prompt);
};
elements.prompt.onkeydown = (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    elements.composer.requestSubmit();
  }
};

void boot().catch((error) => {
  appendMessageNode('system', error instanceof Error ? error.message : String(error));
  setStatus('Bootstrap failed');
});
