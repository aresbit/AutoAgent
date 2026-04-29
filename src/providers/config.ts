// Provider configurations distilled for AutoAgent desktop runtime.

export interface BuiltinProvider {
  id: string;
  name: string;
  checkStatus?: boolean;
  allowCustomModels?: boolean;
}

export interface CustomProvider {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  models: string[];
  allowCustomModels?: boolean;
  docPath?: string;
  icon?: string;
}

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  { id: 'codex', name: 'Codex', checkStatus: true },
  { id: 'anthropic', name: 'Anthropic', checkStatus: true },
  { id: 'googleai', name: 'Google AI', checkStatus: true },
  { id: 'groq', name: 'Groq', checkStatus: true },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'deepseek', name: 'DeepSeek', checkStatus: true },
  { id: 'ollama', name: 'Ollama' },
  { id: 'xai', name: 'xAI' },
  { id: 'pplx', name: 'Perplexity' },
  { id: 'azure', name: 'Azure' },
  { id: 'mistral', name: 'Mistral' },
  { id: 'together', name: 'Together', allowCustomModels: true },
  { id: 'openrouter', name: 'OpenRouter', allowCustomModels: true },
];

export const CUSTOM_PROVIDERS: CustomProvider[] = [
  { id: 'cus_baseten', name: 'Baseten', type: 'baseten', baseUrl: 'https://inference.baseten.co/v1', models: [], allowCustomModels: true },
  { id: 'cus_siliconflow', name: 'SiliconFlow', type: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', models: [] },
  { id: 'cus_lmstudio', name: 'LM Studio', type: 'lmstudio', baseUrl: 'http://localhost:1234/v1', models: [] },
  { id: 'cus_deepbricks', name: 'Deepbricks', type: 'deepbricks', baseUrl: 'https://api.deepbricks.ai/v1', models: [] },
  { id: 'cus_fireworks', name: 'Fireworks', type: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', models: [] },
  { id: 'cus_aliyun', name: 'Aliyun', type: 'aliyun', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [] },
  { id: 'cus_alibaba_coding_plan', name: 'Alibaba Coding Plan', type: 'alibaba_coding_plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', models: [] },
  { id: 'cus_volcengine', name: 'Volcengine', type: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', docPath: '/volcengine', models: [
    'deepseek-r1-250120', 'deepseek-v3-241226', 'doubao-1-5-pro-256k-250115'
  ]},
  { id: 'cus_bedrock', name: 'Amazon Bedrock', type: 'bedrock', baseUrl: '', models: [
    'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
    'us.anthropic.claude-3-opus-20240229-v1:0',
    'us.anthropic.claude-3-sonnet-20240229-v1:0',
    'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    'meta.llama3-8b-instruct-v1:0',
    'meta.llama3-70b-instruct-v1:0',
    'mistral.mistral-7b-instruct-v0:2',
    'mistral.mixtral-8x7b-instruct-v0:1',
  ]},
  { id: 'cus_aihubmix', name: 'AiHubMix', type: 'aihubmix', baseUrl: 'https://aihubmix.com/v1', models: [] },
  { id: 'cus_github_models', name: 'GitHub Models', type: 'github_models', baseUrl: '', models: [] },
  { id: 'cus_kimi', name: 'Kimi', type: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', models: [] },
  { id: 'cus_zhipu', name: 'ZhiPu', type: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [] },
  { id: 'cus_302ai', name: '302.AI', type: '302ai', baseUrl: 'https://api.302.ai/v1', models: [] },
  { id: 'cus_cerebras', name: 'Cerebras', type: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', models: [] },
  { id: 'cus_hyperbolic', name: 'Hyperbolic', type: 'hyperbolic', baseUrl: 'https://api.hyperbolic.xyz/v1', models: [] },
  { id: 'cus_poe', name: 'Poe', type: 'poe', baseUrl: 'https://api.poe.com/v1', models: [] },
  { id: 'cus_vercel', name: 'Vercel', type: 'vercel', baseUrl: 'https://ai-gateway.vercel.sh/v1/', models: [] },
  { id: 'cus_zai', name: 'Z.ai', type: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', models: [] },
  { id: 'cus_zai_coding_plan', name: 'Z.ai Coding Plan', type: 'zai_coding_plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', icon: 'zai', models: [], allowCustomModels: true },
  { id: 'cus_zhipu_coding_plan', name: 'Zhipu Coding Plan', type: 'zhipu_coding_plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/', icon: 'zhipu', models: [], allowCustomModels: true },
  { id: 'cus_minimax', name: 'MiniMax', type: 'minimax', baseUrl: 'https://api.minimax.io/anthropic/v1', models: [] },
  { id: 'cus_vertex', name: 'Vertex AI', type: 'vertex', baseUrl: '', models: [] },
  { id: 'cus_huggingface', name: 'Hugging Face', type: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', models: [], allowCustomModels: true },
  { id: 'cus_opencode_zen', name: 'OpenCode Zen', type: 'opencode_zen', baseUrl: 'https://opencode.ai/zen/v1', models: [], allowCustomModels: true },
  { id: 'cus_opencode_go', name: 'OpenCode Go', type: 'opencode_go', baseUrl: 'https://opencode.ai/zen/go/v1', icon: 'opencode_zen', models: [], allowCustomModels: true },
  { id: 'cus_kimi_for_coding', name: 'Kimi for Coding', type: 'kimi_for_coding', baseUrl: 'https://api.kimi.com/coding/v1', icon: 'kimi', models: [], allowCustomModels: true },
];

// Resolve API URL and headers for a provider.
export function resolveProviderEndpoint(
  providerId: string,
  config: Record<string, string | undefined>
): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};

  switch (providerId) {
    case 'codex':
      return { url: config.codex_api_url || 'https://api.openai.com/v1', headers };
    case 'anthropic':
      return { url: config.anthropic_api_url || 'https://api.anthropic.com/v1', headers };
    case 'googleai':
      return { url: config.googleai_api_url || 'https://generativelanguage.googleapis.com/v1beta', headers };
    case 'groq':
      return { url: config.groq_api_url || 'https://api.groq.com/openai/v1', headers };
    case 'openrouter':
      return {
        url: config.openrouter_api_url || 'https://openrouter.ai/api/v1',
        headers: { 'HTTP-Referer': 'https://autoagent.local', 'X-Title': 'AutoAgent' }
      };
    case 'deepseek':
      return { url: config.deepseek_api_url || 'https://api.deepseek.com/v1', headers };
    case 'mistral':
      return { url: config.mistral_api_url || 'https://api.mistral.ai/v1', headers };
    case 'xai':
      return { url: config.xai_api_url || 'https://api.x.ai/v1', headers };
    case 'pplx':
      return { url: config.pplx_api_url || 'https://api.perplexity.ai', headers };
    case 'azure':
      return { url: config.azure_api_url || '', headers };
    case 'together':
      return { url: 'https://api.together.xyz/v1', headers };
    case 'aliyun': {
      const intl = config.endpoint_type === 'intl';
      return { url: `https://dashscope${intl ? '-intl' : ''}.aliyuncs.com/compatible-mode/v1`, headers };
    }
    case 'cus_lmstudio':
      return { url: 'http://localhost:1234/v1', headers };
    default: {
      const custom = CUSTOM_PROVIDERS.find(p => p.id === providerId || p.type === providerId);
      if (custom) {
        return { url: custom.baseUrl.replace('/chat/completions', ''), headers };
      }
      return { url: '', headers };
    }
  }
}
