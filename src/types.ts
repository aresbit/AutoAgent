export interface Chat {
  id: string;
  createdAt: number;
  title: string;
  model: string | null;
  lastReplyAt: number | null;
  assistantId: string | null;
  toolEnabled: number | null;
  toolIds: string | null;
}

export interface Message {
  id: string;
  chatId: string;
  createdAt: number;
  content: string;
  role: 'user' | 'assistant' | 'system';
  model: string | null;
  files: string | null;
}

export interface Assistant {
  id: string;
  createdAt: number;
  name: string;
  icon: string | null;
  description: string | null;
  model: string | null;
  temperature: number | null;
  systemInstruction: string | null;
  replyLanguage: string | null;
  truncateMessages: string | null;
  toolEnabled: number | null;
  toolIds: string | null;
}

export interface ProviderConfig {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  models: string[];
  apiKey?: string;
  allowCustomModels?: boolean;
  docPath?: string;
  icon?: string;
}

export interface ModelInfo {
  id: string;
  modelId: string;
  modelName: string;
  type: 'chat' | 'embedding' | 'image';
  contextLength?: number;
  maxOutput?: number;
  imageInput?: boolean;
  audioInput?: boolean;
  imageOutput?: boolean;
  isReasoningModel?: boolean;
  supportReasoningEffort?: boolean;
  canDisableReasoning?: boolean;
  inputTokenPricing?: number;
  outputTokenPricing?: number;
}

export interface ProviderEndpoint {
  url: string;
  headers: Record<string, string>;
}
