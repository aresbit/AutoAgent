// Provider factory using Vercel AI SDK
// Replaces vendor-specific wrappers with standard ai-sdk packages.

import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createMistral } from '@ai-sdk/mistral';
import { createXai } from '@ai-sdk/xai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createAzure } from '@ai-sdk/azure';
import { createOpenRouter } from '@ai-sdk/openrouter';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createVertex } from '@ai-sdk/google-vertex';
import { resolveProviderEndpoint } from './config';
import type { LanguageModel } from 'ai';

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export function createModel(
  providerId: string,
  modelId: string,
  config: Record<string, string | undefined>
): LanguageModel {
  const apiKey = config[`${providerId}_api_key`] || config.apiKey;
  const { url, headers } = resolveProviderEndpoint(providerId, config);

  const options: ProviderOptions = {
    apiKey,
    baseURL: url || undefined,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}`, ...headers } : headers,
  };

  switch (providerId) {
    case 'codex':
      return createOpenAI(options).languageModel(modelId);
    case 'anthropic':
      return createAnthropic(options).languageModel(modelId);
    case 'googleai':
      return createGoogleGenerativeAI(options).languageModel(modelId);
    case 'groq':
      return createGroq(options).languageModel(modelId);
    case 'mistral':
      return createMistral(options).languageModel(modelId);
    case 'xai':
      return createXai(options).languageModel(modelId);
    case 'deepseek':
      return createDeepSeek(options).languageModel(modelId);
    case 'azure':
      return createAzure(options).languageModel(modelId);
    case 'openrouter':
      return createOpenRouter(options).languageModel(modelId);
    case 'together':
      return createTogetherAI(options).languageModel(modelId);
    case 'pplx':
      return createOpenAI({ ...options, baseURL: 'https://api.perplexity.ai' }).languageModel(modelId);
    case 'bedrock':
      return createAmazonBedrock({
        region: config.aws_region || 'us-east-1',
        accessKeyId: config.aws_access_key_id,
        secretAccessKey: config.aws_secret_access_key,
      }).languageModel(modelId);
    case 'vertex':
      return createVertex({ ...options, project: config.gcp_project, location: config.gcp_location }).languageModel(modelId);
    default: {
      // Generic Codex-compatible provider (LM Studio, local, etc.)
      return createOpenAI(options).languageModel(modelId);
    }
  }
}

// Alias mapping for model IDs with provider prefixes
export function resolveModelId(modelId: string): { provider: string; model: string } {
  const prefixes: Record<string, string> = {
    'codex-': 'codex',
    'anthropic-': 'anthropic',
    'google-': 'googleai',
    'groq-': 'groq',
    'mistral-': 'mistral',
    'xai-': 'xai',
    'deepseek-': 'deepseek',
    'azure-': 'azure',
    'openrouter-': 'openrouter',
    'together-': 'together',
    'perplexity-': 'pplx',
    'pplx-': 'pplx',
    'copilot-': 'copilot',
    'claude-': 'anthropic',
    'gpt-': 'codex',
    'gemini-': 'googleai',
  };

  for (const [prefix, provider] of Object.entries(prefixes)) {
    if (modelId.startsWith(prefix)) {
      return { provider, model: modelId.slice(prefix.length) };
    }
  }

  // No prefix - assume Codex-compatible format or custom provider
  return { provider: 'codex', model: modelId };
}
