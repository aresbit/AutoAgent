export const electronFetchPrefix = 'electron-fetch:';
export const electronFetchRequestChannel = `${electronFetchPrefix}request`;
export const electronFetchAbortChannel = (id: string) => `${electronFetchPrefix}abort:${id}`;

export const electronExecRequestChannel = 'electron-exec:request';
export const electronExecEventChannel = 'electron-exec:event';

export const chatwiseQueryKeys = {
  chats: (assistantId?: string | null) => ['chats', assistantId].filter((value) => value !== undefined),
  messages: (chatId: string) => ['chat-messages', chatId],
  config: ['config'],
  assistants: ['assistants'],
  customProviders: ['custom-provioders'],
  mcpServers: ['mcpServers'],
  prompts: ['prompts'],
  favoriteModels: ['favorite-models'],
  gitDiffStat: (workDir?: string) => ['git-diff-stat', workDir].filter(Boolean),
};

export type McpTransportConfig =
  | { type: 'stdio'; command: string; env?: string; longRunning?: boolean }
  | { type: 'http'; url: string; authorizationToken?: string; longRunning?: boolean };

export const defaultMcpServers: Array<{ displayId: string; config: McpTransportConfig }> = [
  { displayId: 'fetch', config: { type: 'stdio', command: 'npx -y fetch-mcp' } },
  {
    displayId: 'brave-search',
    config: { type: 'stdio', command: 'npx -y @modelcontextprotocol/server-brave-search', env: 'BRAVE_API_KEY=' },
  },
  { displayId: 'playwright', config: { type: 'stdio', command: 'npx -y @playwright/mcp@latest', longRunning: true } },
  { displayId: 'context7', config: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
];

export enum McpErrorCode {
  ConnectionClosed = -32000,
  RequestTimeout = -32001,
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  UrlElicitationRequired = -32042,
}

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse | JsonRpcError {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'id' in message &&
    ('result' in message || 'error' in message)
  );
}

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    'id' in message &&
    typeof (message as { method?: unknown }).method === 'string' &&
    !('result' in message) &&
    !('error' in message)
  );
}

export function isJsonRpcNotification(message: unknown): message is JsonRpcNotification {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    !('id' in message) &&
    typeof (message as { method?: unknown }).method === 'string'
  );
}
