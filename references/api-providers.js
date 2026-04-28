(function () {
  try {
    var e =
      typeof window != "undefined"
        ? window
        : typeof global != "undefined"
          ? global
          : typeof globalThis != "undefined"
            ? globalThis
            : typeof self != "undefined"
              ? self
              : {};
    var n = new e.Error().stack;
    if (n) {
      e._posthogChunkIds = e._posthogChunkIds || {};
      e._posthogChunkIds[n] = "019dca39-ff7d-7f92-a685-b9f7e0c938a4";
    }
  } catch (e) {}
})();
import {
  Ct as e,
  D as t,
  Dt as n,
  Et as r,
  J as i,
  L as a,
  R as o,
  Tt as s,
  _t as c,
  bt as ee,
  lt as l,
  nt as u,
  r as d,
  yt as te,
} from "./CrP897dy.js";
import { m as f, n as p, s as m } from "./CpWfWUHL.js";
import { R as h, v as g, w as _, y as v } from "./CSqTKQw8.js";
import {
  Gn as ne,
  J as re,
  Jt as ie,
  Mt as ae,
  Zt as y,
  a as b,
  ar as oe,
  ir as se,
  jn as ce,
  nr as le,
  o as ue,
  wn as x,
} from "./DXE32dZW.js";
import "./CuyqONxg.js";
import { t as S } from "./8-LEmzIm.js";
var C = (e) => () => e.data;
var de = (e, t) => {
  let n = (e) => {
    t(e);
  };
  return {
    updateModels: n,
    addModels: (t) => {
      let r = e() || [];
      let i = [...r];
      let a = new Map(r.map((e, t) => [e.modelId, t]));
      for (let e of t) {
        let t = a.get(e.modelId);
        if (t == null) {
          a.set(e.modelId, i.length);
          i.push(e);
          continue;
        }
        let n = i[t];
        i[t] = {
          ...n,
          ...e,
          id: n.id,
        };
      }
      n(i);
    },
    updateModel: (t, r) => {
      let i = e();
      if (i) {
        n(
          i.map((e) =>
            e.id === t
              ? {
                  ...e,
                  ...r,
                }
              : e,
          ),
        );
      }
    },
  };
};
var w = () => ({
  id: ne(),
  modelId: ``,
  type: `chat`,
});
var T = (e) =>
  !e.id.includes(`flux`) &&
  !e.id.includes(`embedding`) &&
  !e.id.includes(`tts`) &&
  !e.id.includes(`whisper`) &&
  !e.id.includes(`video`);
var E = (e, t) => {
  if (e) {
    if (e.endsWith(`/`)) {
      e = e.slice(0, -1);
    }
    if (/\/v\d+([\w]+)?$/.test(e)) {
      if (t) {
        return e.replace(/\/v\d+([\w]+)?$/, `/${t}`);
      } else {
        return e;
      }
    } else {
      return `${e}/${t || `v1`}`;
    }
  }
};
var D = `https://openrouter.ai/api/v1`;
var fe = (e) => {
  let [t, n] = e.split(`->`);
  return {
    input: t?.split(`+`) || [],
    output: n?.split(`+`) || [],
  };
};
var pe = async ({ apiUrl: e, apiKey: t, headers: n }, r) => {
  let i = `${E(e)}/models`;
  let a = await r(i, {
    headers: {
      ...n,
      ...(t
        ? {
            Authorization: `Bearer ${t}`,
          }
        : {}),
    },
  }).catch((e) => {
    reportError(Error(`failed to fetch openrouter ${i}: ${String(e.stack)}`));
    return null;
  });
  if (a?.ok) {
    return (await a.json()).data
      .map((e) => {
        let t = fe(e.architecture?.modality || ``);
        let n = e.id;
        return {
          ...e,
          id: `openrouter-${n}`,
          description: e.description,
          capabilities: {
            fileInput: [
              ...(t.input.includes(`image`) ? [`.jpg`, `.png`, `.jpeg`] : []),
            ],
            reasoning: e.supported_parameters?.includes(`reasoning`),
            reasoningEffort: e.supported_parameters?.includes(`reasoning`),
            canDisableReasoning:
              e.supported_parameters?.includes(`include_reasoning`) &&
              !n.includes(`gpt-5-image`),
          },
          price: {
            input: e.pricing.prompt * 1000 * 1000,
            output: e.pricing.completion * 1000 * 1000,
          },
          contextLength: e.context_length,
          maxOutput: e.top_provider?.max_completion_tokens || undefined,
        };
      })
      .sort((e, t) => e.name.localeCompare(t.name));
  } else {
    return [];
  }
};
var me = async ({ apiUrl: e, apiKey: t, headers: n }, r) => {
  let [i, a] = await Promise.all([
    r(`${E(e)}/auth/key`, {
      headers: {
        ...(t
          ? {
              Authorization: `Bearer ${t}`,
            }
          : {}),
        ...n,
      },
    }).then(async (e) => {
      if (!e.ok) {
        throw Error(`Failed to get OpenRouter key info: ${await e.text()}`);
      }
      return await e.json();
    }),
    r(`${E(e)}/credits`, {
      headers: {
        ...(t
          ? {
              Authorization: `Bearer ${t}`,
            }
          : {}),
        ...n,
      },
    }).then(async (e) => {
      if (!e.ok) {
        throw Error(`Failed to get OpenRouter key info: ${await e.text()}`);
      }
      return await e.json();
    }),
  ]);
  if (i.data.limit) {
    return {
      used: i.data.usage,
      remaining: i.data.limit - i.data.usage,
    };
  } else {
    return {
      used: i.data.usage,
      remaining: a.data.total_credits - a.data.total_usage,
    };
  }
};
var he = [
  {
    type: `chat`,
    modelName: `Claude 3.5 Sonnet v2`,
    modelId: `us.anthropic.claude-3-5-sonnet-20241022-v2:0`,
    contextLength: 200000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Claude 3 Opus`,
    modelId: `us.anthropic.claude-3-opus-20240229-v1:0`,
    contextLength: 200000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Claude 3 Sonnet`,
    modelId: `us.anthropic.claude-3-sonnet-20240229-v1:0`,
    contextLength: 200000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Claude 3.5 Haiku`,
    modelId: `us.anthropic.claude-3-5-haiku-20241022-v1:0`,
    contextLength: 200000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Claude 3.7 Sonnet`,
    modelId: `us.anthropic.claude-3-7-sonnet-20250219-v1:0`,
    contextLength: 200000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Claude 3.7 Sonnet Thinking`,
    modelId: `us.anthropic.claude-3-7-sonnet-20250219-v1:0`,
    contextLength: 200000,
    imageInput: true,
    isReasoningModel: true,
  },
  {
    type: `chat`,
    modelName: `Amazon Nova Lite`,
    modelId: `us.amazon.nova-lite-v1:0`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `Amazon Nova Micro`,
    modelId: `us.amazon.nova-micro-v1:0`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `Amazon Nova Pro`,
    modelId: `us.amazon.nova-pro-v1:0`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Grande Instruct`,
    modelId: `ai21.j2-grande-instruct`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Jumbo Instruct`,
    modelId: `ai21.j2-jumbo-instruct`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Mid`,
    modelId: `ai21.j2-mid`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Mid V1`,
    modelId: `ai21.j2-mid-v1`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Ultra`,
    modelId: `ai21.j2-ultra`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Ultra V1 8K`,
    modelId: `ai21.j2-ultra-v1:0:8k`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jurassic2 Ultra V1`,
    modelId: `ai21.j2-ultra-v1`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `AI21 Jamba Instruct`,
    modelId: `ai21.jamba-instruct-v1:0`,
    contextLength: 32768,
  },
  {
    type: `chat`,
    modelName: `AI21 Jamba 1.5 Large`,
    modelId: `ai21.jamba-1-5-large-v1:0`,
    contextLength: 32768,
  },
  {
    type: `chat`,
    modelName: `AI21 Jamba 1.5 Mini`,
    modelId: `ai21.jamba-1-5-mini-v1:0`,
    contextLength: 32768,
  },
  {
    type: `chat`,
    modelName: `Cohere Command Text V14 4K`,
    modelId: `cohere.command-text-v14:7:4k`,
    contextLength: 4000,
  },
  {
    type: `chat`,
    modelName: `Cohere Command R V1`,
    modelId: `cohere.command-r-v1:0`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Cohere Command R Plus V1`,
    modelId: `cohere.command-r-plus-v1:0`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Cohere Command Light Text V14 4K`,
    modelId: `cohere.command-light-text-v14:7:4k`,
    contextLength: 4000,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 8B Instruct V1`,
    modelId: `meta.llama3-8b-instruct-v1:0`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 70B Instruct V1`,
    modelId: `meta.llama3-70b-instruct-v1:0`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 1.8B Instruct V1 128K`,
    modelId: `meta.llama3-1-8b-instruct-v1:0:128k`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 1.8B Instruct V1`,
    modelId: `meta.llama3-1-8b-instruct-v1:0`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 1 70B Instruct V1 128K`,
    modelId: `meta.llama3-1-70b-instruct-v1:0:128k`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 1 70B Instruct V1`,
    modelId: `meta.llama3-1-70b-instruct-v1:0`,
    contextLength: 8192,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 2 11B Instruct V1`,
    modelId: `meta.llama3-2-11b-instruct-v1:0`,
    contextLength: 128000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 2 90B Instruct V1`,
    modelId: `meta.llama3-2-90b-instruct-v1:0`,
    contextLength: 128000,
    imageInput: true,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 2 1B Instruct V1`,
    modelId: `meta.llama3-2-1b-instruct-v1:0`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Meta Llama 3 2 3B Instruct V1`,
    modelId: `meta.llama3-2-3b-instruct-v1:0`,
    contextLength: 128000,
  },
  {
    type: `chat`,
    modelName: `Mistral 7B Instruct V0`,
    modelId: `mistral.mistral-7b-instruct-v0:2`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `Mistral Mixtral 8x7B Instruct V0`,
    modelId: `mistral.mixtral-8x7b-instruct-v0:1`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `Mistral Large 2402 V1`,
    modelId: `mistral.mistral-large-2402-v1:0`,
    contextLength: 32000,
  },
  {
    type: `chat`,
    modelName: `Mistral Small 2402 V1`,
    modelId: `mistral.mistral-small-2402-v1:0`,
    contextLength: 32000,
  },
];
var O = [
  {
    name: `Anthropic`,
    value: `anthropic`,
  },
  {
    name: `Google AI`,
    value: `googleai`,
  },
  {
    name: `OpenAI`,
    value: `openai`,
  },
  {
    name: `Cerebras`,
    value: `cerebras`,
  },
  {
    name: `DeepSeek`,
    value: `deepseek`,
  },
  {
    name: `Groq`,
    value: `groq`,
  },
  {
    name: `Mistral`,
    value: `mistral`,
  },
  {
    name: `OpenRouter`,
    value: `openrouter`,
  },
  {
    name: `Perplexity`,
    value: `pplx`,
  },
  {
    name: `xAI`,
    value: `xai`,
  },
].sort((e, t) => e.name.localeCompare(t.name));
var k = [`cerebras`];
var A = (e, t) => {
  if (t.id === `anthropic` && e.anthropic_auth_mode === `oauth`) {
    return {
      isObserved: false,
      reason: `anthropic_oauth`,
    };
  }
  if (e.observability_provider === `cloudflare_ai_gateway`) {
    let n = t.id.startsWith(`cus_`) ? t.baseUrl : e[`${t.id}_api_url`];
    return {
      isObserved: e.observability_cloudflare_ai_gateway_config?.providers?.some(
        (e) =>
          t.type && t.id.startsWith(`cus_`)
            ? !n && t.type === e && k.includes(t.type)
            : e === t.id && !n,
      ),
      reason: n ? `has_base_url` : `not_enabled`,
    };
  }
  return {
    isObserved: false,
    reason: `not_enabled`,
  };
};
var j = (e) =>
  O.some((t) =>
    e.id.startsWith(`cus_`)
      ? e.type === t.value && k.includes(e.type)
      : t.value === e.id,
  );
var M = [`minimax`, `kimi_for_coding`];
var N = (e) => (e ? M.includes(e) : false);
var P = [
  {
    id: `openai`,
    name: `OpenAI`,
    checkStatus: true,
  },
  {
    id: `codex`,
    name: `OpenAI Codex`,
  },
  {
    id: `anthropic`,
    name: `Anthropic`,
  },
  {
    id: `googleai`,
    name: `Google AI`,
  },
  {
    id: `groq`,
    name: `Groq`,
    checkStatus: true,
  },
  {
    id: `copilot`,
    name: `GitHub Copilot`,
  },
  {
    id: `deepseek`,
    name: `DeepSeek`,
    checkStatus: true,
  },
  {
    id: `ollama`,
    name: `Ollama`,
  },
  {
    id: `xai`,
    name: `xAI`,
  },
  {
    id: `pplx`,
    name: `Perplexity`,
  },
  {
    id: `azure`,
    name: `Azure OpenAI`,
  },
  {
    id: `mistral`,
    name: `Mistral`,
  },
  {
    id: `together`,
    name: `Together`,
    allowCustomModels: true,
  },
  {
    id: `openrouter`,
    name: `OpenRouter`,
    allowCustomModels: true,
  },
];
var F = (e) => P.find((t) => t.id === e);
var I = (e) => P.some((t) => t.id === e);
var L = le(
  [
    {
      id: `cus_baseten`,
      name: `Baseten`,
      type: `baseten`,
      baseUrl: `https://inference.baseten.co/v1`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_siliconflow`,
      name: `SiliconFlow`,
      type: `siliconflow`,
      baseUrl: `https://api.siliconflow.cn/v1`,
    },
    {
      id: `cus_lmstudio`,
      name: `LM Studio`,
      type: `lmstudio`,
      baseUrl: `http://localhost:1234/v1`,
      models: [],
    },
    {
      id: `cus_deepbricks`,
      name: `Deepbricks`,
      baseUrl: `https://api.deepbricks.ai/v1`,
      models: [],
    },
    {
      id: `cus_fireworks`,
      name: `Fireworks`,
      type: `fireworks`,
      baseUrl: `https://api.fireworks.ai/inference/v1`,
      models: [],
    },
    {
      id: `cus_aliyun`,
      name: `Aliyun`,
      type: `aliyun`,
      baseUrl: `https://dashscope.aliyuncs.com/compatible-mode/v1`,
      models: [],
    },
    {
      id: `cus_alibaba_coding_plan`,
      name: `Alibaba Coding Plan`,
      type: `alibaba_coding_plan`,
      baseUrl: `https://coding.dashscope.aliyuncs.com/v1`,
      models: [],
    },
    {
      id: `cus_volcengine`,
      name: `Volcengine`,
      type: `volcengine`,
      baseUrl: `https://ark.cn-beijing.volces.com/api/v3`,
      docPath: `/volcengine`,
      models: [
        {
          type: `chat`,
          modelName: `DeepSeek R1`,
          modelId: `deepseek-r1-250120`,
        },
        {
          type: `chat`,
          modelName: `DeepSeek V3`,
          modelId: `deepseek-v3-241226`,
        },
        {
          type: `chat`,
          modelName: `Doubao 1.5 Pro`,
          modelId: `doubao-1-5-pro-256k-250115`,
        },
      ],
    },
    {
      id: `cus_bedrock`,
      name: `Amazon Bedrock`,
      type: `bedrock`,
      baseUrl: ``,
      models: he,
    },
    {
      id: `cus_aihubmix`,
      name: `AiHubMix`,
      type: `aihubmix`,
      baseUrl: `https://aihubmix.com/v1`,
    },
    {
      id: `cus_github_models`,
      name: `GitHub Models`,
      type: `github_models`,
      baseUrl: ``,
    },
    {
      id: `cus_kimi`,
      name: `Kimi`,
      type: `kimi`,
      baseUrl: `https://api.moonshot.cn/v1`,
    },
    {
      id: `cus_zhipu`,
      name: `ZhiPu`,
      type: `zhipu`,
      baseUrl: `https://open.bigmodel.cn/api/paas/v4`,
    },
    {
      id: `cus_302ai`,
      name: `302.AI`,
      type: `302ai`,
      baseUrl: `https://api.302.ai/v1`,
    },
    {
      id: `cus_cerebras`,
      name: `Cerebras`,
      type: `cerebras`,
      baseUrl: `https://api.cerebras.ai/v1`,
    },
    {
      id: `cus_hyperbolic`,
      name: `Hyperbolic`,
      type: `hyperbolic`,
      baseUrl: `https://api.hyperbolic.xyz/v1`,
    },
    {
      id: `cus_poe`,
      name: `Poe`,
      type: `poe`,
      baseUrl: `https://api.poe.com/v1`,
    },
    {
      id: `cus_vercel`,
      name: `Vercel`,
      type: `vercel`,
      baseUrl: `https://ai-gateway.vercel.sh/v1/`,
    },
    {
      id: `cus_zai`,
      name: `Z.ai`,
      type: `zai`,
      baseUrl: `https://api.z.ai/api/paas/v4`,
    },
    {
      id: `cus_zai_coding_plan`,
      name: `Z.ai Coding Plan`,
      type: `zai_coding_plan`,
      baseUrl: `https://api.z.ai/api/coding/paas/v4`,
      icon: `zai`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_zhipu_coding_plan`,
      name: `Zhipu Coding Plan`,
      type: `zhipu_coding_plan`,
      baseUrl: `https://open.bigmodel.cn/api/coding/paas/v4/`,
      icon: `zhipu`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_minimax`,
      name: `MiniMax`,
      type: `minimax`,
      baseUrl: `https://api.minimax.io/anthropic/v1`,
    },
    {
      id: `cus_vertex`,
      name: `Vertex AI`,
      type: `vertex`,
      baseUrl: ``,
    },
    {
      id: `cus_huggingface`,
      name: `Hugging Face`,
      type: `huggingface`,
      baseUrl: `https://router.huggingface.co/v1`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_opencode_zen`,
      name: `OpenCode Zen`,
      type: `opencode_zen`,
      baseUrl: `https://opencode.ai/zen/v1`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_opencode_go`,
      name: `OpenCode Go`,
      type: `opencode_go`,
      baseUrl: `https://opencode.ai/zen/go/v1`,
      icon: `opencode_zen`,
      models: [],
      allowCustomModels: true,
    },
    {
      id: `cus_kimi_for_coding`,
      name: `Kimi for Coding`,
      type: `kimi_for_coding`,
      baseUrl: `https://api.kimi.com/coding/v1`,
      icon: `kimi`,
      models: [],
      allowCustomModels: true,
    },
  ],
  `id`,
);
var R = (e, t) => {
  let n = t.split(`-`)[0];
  return e.find((e) => e.id === n);
};
var z = (e, t) => {
  let n = t.id.replace(`cus_`, ``);
  if (e.exists(`providers.${n}`)) {
    return e.t(`providers.${n}`);
  } else if (t.type && e.exists(`providers.${t.type}`)) {
    return e.t(`providers.${t.type}`);
  } else {
    return t.name;
  }
};
var B = (e) =>
  P.some((t) => t.id === e.id)
    ? e.id
    : (e.type === `openai` || !e.type) &&
        [
          `volcengine`,
          `lmstudio`,
          `aliyun`,
          `jina_deepsearch`,
          `fireworks`,
          `siliconflow`,
        ].some((t) => e.id === `cus_${t}`)
      ? e.id.replace(`cus_`, ``)
      : e.type;
var ge = (e, t) => {
  let n = V(e, t).url;
  if (t.type === `github_models`) {
    return `https://models.github.ai/catalog/models`;
  } else if (t.type === `vercel`) {
    return `https://ai-gateway.vercel.sh/v1/models`;
  } else {
    return `${n}/models`;
  }
};
var V = (e, t) => {
  let n =
    e.observability_provider === `cloudflare_ai_gateway`
      ? e.observability_cloudflare_ai_gateway_config
      : null;
  let r = `https://gateway.ai.cloudflare.com/v1/${n?.account_id}/${n?.gateway_name}`;
  let { isObserved: i } = A(e, t);
  let { url: a, headers: o } = oe(B(t))
    .with(`openai`, () =>
      t.id.startsWith(`cus_`)
        ? {
            url: t.baseUrl?.replace(`/chat/completions`, ``),
            headers: {},
          }
        : {
            url:
              n && i
                ? `${r}/openai`
                : E(e.openai_api_url) || E(`https://api.openai.com`, `v1`),
            headers: {},
          },
    )
    .with(`anthropic`, () => ({
      url:
        n && i
          ? `${r}/anthropic`
          : E(e.anthropic_api_url) || E(`https://api.anthropic.com`, `v1`),
      headers: {},
    }))
    .with(`googleai`, () => ({
      url:
        n && i
          ? `${r}/google-ai-studio/v1beta`
          : E(
              e.googleai_api_url || `https://generativelanguage.googleapis.com`,
              `v1beta`,
            ),
      headers: {},
    }))
    .with(`groq`, () => ({
      url: n && i ? `${r}/groq` : E(e.groq_api_url),
      headers: {},
    }))
    .with(`openrouter`, () => ({
      url:
        n && i
          ? `${r}/openrouter`
          : E(e.openrouter_api_url || `https://openrouter.ai/api/v1`),
      headers: {
        "HTTP-Referer": `https://chatwise.app`,
        "X-Title": `ChatWise`,
      },
    }))
    .with(`deepseek`, () => ({
      url: n && i ? `${r}/deepseek` : E(e.deepseek_api_url),
      headers: {},
    }))
    .with(`mistral`, () => ({
      url:
        n && i
          ? `${r}/mistral`
          : E(e.mistral_api_url || `https://api.mistral.ai`),
      headers: {},
    }))
    .with(`xai`, () => ({
      url: n && i ? `${r}/grok` : E(e.xai_api_url),
      headers: {},
    }))
    .with(`pplx`, () => ({
      url:
        n && i
          ? `${r}/perplexity`
          : e.pplx_api_url || `https://api.perplexity.ai`,
      headers: {},
    }))
    .with(`aliyun`, () => ({
      url: `https://dashscope${t.config?.endpoint_type === `intl` ? `-intl` : ``}.aliyuncs.com/compatible-mode/v1`,
      headers: {},
    }))
    .with(`alibaba_coding_plan`, () => ({
      url: `https://coding${t.config?.endpoint_type === `intl` ? `-intl` : ``}.dashscope.aliyuncs.com/apps/anthropic/v1`,
      headers: {},
    }))
    .otherwise(() => ({
      url:
        n && i ? `${r}/${t.type}` : t.baseUrl?.replace(`/chat/completions`, ``),
      headers: {},
    }));
  if (i && a?.startsWith(r) && n?.auth_token) {
    o[`cf-aig-authorization`] = `Bearer ${n.auth_token}`;
  }
  return {
    url: a,
    headers: o,
  };
};
var _e = v({
  device_code: _(),
  user_code: _(),
  verification_uri: _(),
  interval: g(),
});
var ve = v({
  token: _(),
  expires_at: g(),
});
var H = `Iv1.b507a08c87ecfe98`;
var U = () => ({
  "copilot-integration-id": `vscode-chat`,
  "openai-intent": `conversation-panel`,
  "editor-plugin-version": `copilot-chat/0.99.0`,
  "editor-version": `vscode/1.999.0`,
});
var W = new Map();
var G = class {
  constructor(e) {
    this.fetch = e;
  }
  async requestDeviceCode() {
    let e = await this.fetch(
      `https://github.com/login/device/code?${new URLSearchParams({
        client_id: H,
      })}`,
      {
        method: `POST`,
        headers: {
          accept: `application/json`,
        },
      },
    );
    if (!e.ok) {
      throw Error(`Failed to request device code: ${await e.text()}`);
    }
    let t = await e.json();
    console.log(t);
    return _e.parse(t);
  }
  async verifyAuth({ device_code: e }) {
    let t = await this.fetch(
      `https://github.com/login/oauth/access_token?${new URLSearchParams({
        client_id: H,
        device_code: e,
        grant_type: `urn:ietf:params:oauth:grant-type:device_code`,
      })}`,
      {
        method: `POST`,
        headers: {
          accept: `application/json`,
        },
      },
    );
    if (!t.ok) {
      return null;
    }
    let n = await t.json();
    return v({
      access_token: _(),
    }).parse(n);
  }
  async getCopilotToken(e) {
    let t = W.get(e);
    if (t) {
      let e = await t;
      if (e && e.expires_at * 1000 > Date.now()) {
        return e;
      }
    }
    let n = (async () => {
      console.log(`Fetching new Copilot token`);
      let t = await this.fetch(
        `https://api.github.com/copilot_internal/v2/token`,
        {
          headers: {
            authorization: `Bearer ${e}`,
            accept: `application/json`,
          },
        },
      );
      if (!t.ok) {
        throw Error(`Failed to get token for chat: ${await t.text()}`);
      }
      let n = await t.json();
      return ve.parse(n);
    })();
    W.set(e, n);
    return n;
  }
  async fetchModels(e) {
    let t = await this.getCopilotToken(e);
    let n = await this.fetch(`https://api.githubcopilot.com/models`, {
      headers: {
        Authorization: `Bearer ${t.token}`,
        ...U(),
      },
    });
    if (n.ok) {
      return (await n.json()).data
        .filter((e) => !e.id.includes(`embedding`) && e.model_picker_enabled)
        .map((e) => {
          let t = e.id;
          let n =
            e.capabilities?.limits?.vision?.supported_media_types
              ?.map((e) => {
                switch (e) {
                  case `image/jpeg`:
                    return [`.jpg`, `.jpeg`];
                  case `image/png`:
                    return [`.png`];
                  case `image/gif`:
                    return [`.gif`];
                  case `image/webp`:
                    return [`.webp`];
                  default:
                    return [];
                }
              })
              .flat() || [];
          return {
            id: `copilot-${t}`,
            apiModelId: t,
            name: e.name,
            description: `${e.vendor} ${e.name}${e.preview ? ` (Preview)` : ``}`,
            capabilities: {
              fileInput: n.length > 0 ? n : undefined,
            },
            contextLength: e.capabilities?.limits?.max_context_window_tokens,
            maxOutput: e.capabilities?.limits?.max_output_tokens,
          };
        })
        .sort((e, t) => e.name.localeCompare(t.name));
    } else {
      return null;
    }
  }
};
var ye = async (e, t) => {
  let n = await t(`https://api.together.xyz/v1/models`, {
    headers: {
      Authorization: `Bearer ${e}`,
    },
  });
  if (n.ok) {
    return (await n.json())
      .filter(
        (e) =>
          e.type === `chat` &&
          !e.id.startsWith(`devuser/`) &&
          !e.id.includes(`lora`),
      )
      .map((e) => ({
        id: `together-${e.id}`,
        name: e.display_name || e.id,
        apiModelId: e.id,
        contextLength:
          typeof e.context_length == `number` ? e.context_length : undefined,
        maxOutput: e.config?.max_output_length,
        price: e.pricing
          ? {
              input: e.pricing.input,
              output: e.pricing.output,
            }
          : undefined,
      }));
  } else {
    return [];
  }
};
var be = 1000000;
var xe = `https://models.dev/api.json`;
var K = async () => await (await S(xe)).json();
var q = (e) => {
  if (e) {
    return e * be;
  }
};
var J = (e) => (!e || typeof e != `object` ? null : e);
var Se = (e, t) => {
  let n = J(t);
  if (!n) {
    return [];
  }
  let r = J(n[e])?.models;
  if (r) {
    return Object.entries(r)
      .map(([e, t]) => {
        let n = t.modalities?.input;
        let r = t.modalities?.output || [];
        return {
          id: t.id || e,
          modelId: t.id || e,
          modelName: t.name || t.id || e,
          type: `chat`,
          contextLength: t.limit?.context,
          maxOutputLimit: t.limit?.output,
          imageInput: n?.includes(`image`),
          audioInput: n?.includes(`audio`),
          imageOutput: r.includes(`image`),
          isReasoningModel: t.reasoning,
          supportReasoningEffort: t.reasoning,
          inputTokenPricing: t.cost?.input,
          outputTokenPricing: t.cost?.output,
        };
      })
      .filter((e) => T(e));
  } else {
    return [];
  }
};
var Ce = (e, t) => {
  let n = J(t);
  if (n) {
    for (let t of Object.keys(n)) {
      let r = J(n[t])?.models;
      if (r) {
        for (let [t, n] of Object.entries(r)) {
          if ((n.id || t) === e) {
            return n;
          }
        }
      }
    }
  }
};
var we = (e, t) => {
  if (e === `aliyun`) {
    if (t?.config?.endpoint_type === `intl`) {
      return `alibaba`;
    } else {
      return `alibaba-cn`;
    }
  }
  if (e === `alibaba_coding_plan`) {
    if (t?.config?.endpoint_type === `intl`) {
      return `alibaba-coding-plan`;
    } else {
      return `alibaba-coding-plan-cn`;
    }
  }
  switch (e) {
    case `zhipu`:
      return `zhipuai`;
    case `kimi`:
      return `moonshotai`;
    case `bedrock`:
      return `amazon-bedrock`;
    case `fireworks`:
      return `fireworks-ai`;
    case `vertex`:
      return `google-vertex`;
    case `opencode_zen`:
      return `opencode`;
    case `opencode_go`:
      return `opencode-go`;
    case `siliconflow`:
      return `siliconflow-cn`;
    case `kimi_for_coding`:
      return `kimi-for-coding`;
    case `zai_coding_plan`:
      return `zai-coding-plan`;
    case `zhipu_coding_plan`:
      return `zhipuai-coding-plan`;
    case `zai`:
    case `minimax`:
    case `baseten`:
    case `cerebras`:
      return e;
  }
};
var Te = async (e) => {
  let t = await m(f);
  let n = we(
    e.type === `custom` ? B(e.customProvider) || `openai` : e.type,
    e.type === `custom` ? e.customProvider : undefined,
  );
  if (n) {
    return Se(n, await K());
  }
  let r = ``;
  let i = {
    ...e.headers,
  };
  if (e.type === `openrouter`) {
    let n = e.openrouterApiKey || t.openrouter_api_key;
    r = `${e.openrouterBaseUrl || `https://openrouter.ai/api/v1`}/models`;
    if (n) {
      Object.assign(i, {
        Authorization: `Bearer ${n}`,
      });
    }
  } else if (e.type === `together`) {
    let n = e.togetherApiKey || t.together_api_key;
    if (!n) {
      throw Error(`API key is required to fetch models`);
    }
    r = `https://api.together.xyz/v1/models`;
    Object.assign(i, {
      Authorization: `Bearer ${n}`,
    });
  } else if (e.type === `custom`) {
    let n = e.customProvider;
    if (!n) {
      throw Error(`Custom provider configuration is required`);
    }
    r = ge(t, n);
    Object.assign(i, V(t, n).headers);
    if (n.apiKey) {
      Object.assign(i, {
        Authorization: `Bearer ${se(n.apiKey)}`,
      });
    }
    if (n.type === `github_models`) {
      i[`X-GitHub-Api-Version`] = `2022-11-28`;
      i.Accept = `application/vnd.github+json`;
    }
  }
  let a = await S(r, {
    headers: i,
  });
  if (!a.ok) {
    throw Error(`${a.status}: ${await a.text()}`);
  }
  let o = await a.json();
  let s = Array.isArray(o) ? o : o.data;
  let c = e.type === `custom` ? await K().catch(() => null) : null;
  return s
    .filter((t) =>
      T(t)
        ? e.type === `custom` && e.customProvider?.type === `anthropic`
          ? t.owned_by === `Anthropic`
          : true
        : false,
    )
    .map((t) => {
      let n = ce(t.id);
      let r = c == null ? undefined : Ce(t.id, c);
      let i = r?.modalities?.input;
      let a = r?.modalities?.output || [];
      return {
        id: t.id,
        modelId: t.id,
        modelName: t.display_name || t.name,
        type: `chat`,
        contextLength:
          r?.limit?.context ||
          (typeof t.context_window == `number` && t.context_window) ||
          (typeof t.context_window == `object` &&
            t.context_window &&
            t.context_window.context_length) ||
          t.context_length,
        maxOutputLimit:
          r?.limit?.output ||
          t.max_tokens ||
          t.max_completion_tokens ||
          t.top_provider?.max_completion_tokens ||
          (typeof t.context_window == `object` && t.context_window
            ? t.context_window.max_output_tokens
            : undefined),
        description: t.description,
        imageInput:
          i?.includes(`image`) ||
          t.supported_input_modalities?.includes(`image`) ||
          t.architecture?.input_modalities?.includes(`image`) ||
          n.imageInput,
        imageOutput:
          a.includes(`image`) ||
          t.architecture?.output_modalities?.includes(`image`) ||
          n.imageOutput,
        audioInput:
          i?.includes(`audio`) ||
          t.supported_input_modalities?.includes(`audio`) ||
          t.architecture?.input_modalities?.includes(`audio`),
        inputTokenPricing:
          r?.cost?.input ??
          (t.pricing?.input
            ? q(parseFloat(t.pricing.input))
            : q(t.pricing?.prompt)),
        outputTokenPricing:
          r?.cost?.output ??
          (t.pricing?.output
            ? q(parseFloat(t.pricing.output))
            : q(t.pricing?.completion)),
        ...(e.type === `openrouter`
          ? {
              isReasoningModel: t.supported_parameters?.includes(`reasoning`),
              supportReasoningEffort:
                t.supported_parameters?.includes(`reasoning`),
              canDisableReasoning:
                t.supported_parameters?.includes(`include_reasoning`) &&
                !t.id.includes(`gpt-5-image`),
            }
          : r
            ? {
                isReasoningModel: r.reasoning,
                supportReasoningEffort: r.reasoning,
                canDisableReasoning: n.canDisableReasoning,
              }
            : {
                isReasoningModel: n.reasoning,
                supportReasoningEffort: n.reasoningEffort,
                canDisableReasoning: n.canDisableReasoning,
              }),
      };
    })
    .sort((t, n) =>
      e.type === `openrouter` ||
      e.type === `together` ||
      (e.type === `custom` && e.customProvider.type === `vercel`)
        ? 0
        : t.modelId.localeCompare(n.modelId),
    );
};
var Ee = (e, t) => {
  let n = false;
  Promise.all([
    e.get(`cache_builtin_models`).then((e) => {
      if (!n) {
        t(e?.models || []);
      }
      n = true;
    }),
    fetch(`https://chatwise.app/api/models`, {
      headers: {
        "x-app-version": `26.4.16`,
      },
    })
      .then((e) => (e.ok ? e.json() : []))
      .then((r) => {
        n = true;
        t(r || []);
        e.set(`cache_builtin_models`, {
          models: r || [],
        });
      })
      .catch(console.error),
  ]);
};
var Y = (e, t, n, r) => {
  let i = n?.openrouter_api_key;
  let { isObserved: a } = A(n || {}, {
    id: `openrouter`,
  });
  let { url: o = D, headers: s } = V(n || {}, {
    id: `openrouter`,
  });
  if (o && (i || a)) {
    let n = false;
    Promise.all([
      e.get(`cache_openrouter`).then((e) => {
        if (!n) {
          t(e?.models || []);
        }
        n = true;
      }),
      pe(
        {
          apiUrl: o,
          apiKey: i || ``,
          headers: s,
        },
        r,
      ).then((r) => {
        n = true;
        t(r || []);
        e.set(`cache_openrouter`, {
          models: r || [],
        });
      }),
    ]);
  } else {
    t([]);
  }
};
var De = (e, t, n, r) => {
  let i = n?.copilot_auth_token;
  if (i) {
    let n = false;
    let a = new G(r);
    Promise.all([
      e.get(`cache_github_copilot`).then((e) => {
        if (!n) {
          t(e?.models || []);
        }
        n = true;
      }),
      a.fetchModels(i).then((r) => {
        if (r) {
          n = true;
          t(r || []);
          e.set(`cache_github_copilot`, {
            models: r || [],
          });
        }
      }),
    ]);
  } else {
    t([]);
  }
};
var Oe = (e, t, n, r) => {
  let i = n?.together_api_key;
  if (i) {
    let n = false;
    Promise.all([
      e.get(`cache_together`).then((e) => {
        if (!n) {
          t(e?.models || []);
        }
        n = true;
      }),
      ye(i, r).then((r) => {
        n = true;
        t(r || []);
        e.set(`cache_together`, {
          models: r || [],
        });
      }),
    ]);
  } else {
    t([]);
  }
};
async function ke(e) {
  return h.appCacheGet({
    key: e,
  });
}
async function Ae(e, t) {
  await h.appCacheSet({
    key: e,
    value: t,
  });
}
var X = {
  get: ke,
  set: Ae,
};
var Z = {
  set: async (e, t) => {
    let n = JSON.stringify(t);
    await X.set(e, n);
  },
  get: async (e) => {
    let t = await X.get(e);
    if (t) {
      return JSON.parse(t);
    } else {
      return null;
    }
  },
};
var je = () => {
  let e = C(b());
  let t = (e) => {
    if (!e?.openrouter_models || e.openrouter_models.length === 0) {
      Y(
        Z,
        (e) => {
          y.openrouter = e;
        },
        e,
        S,
      );
    } else if (e?.openrouter_models) {
      y.openrouter = e.openrouter_models
        .map((e) => x(`openrouter`, e))
        .filter((e) => e !== null);
    }
  };
  let n = (e) => {
    if (e) {
      if (!e?.together_models || e.together_models.length === 0) {
        Oe(
          Z,
          (e) => {
            y.together = e;
          },
          e,
          S,
        );
      } else if (e?.together_models) {
        y.together = e.together_models
          .map((e) => x(`together`, e))
          .filter((e) => e !== null);
      }
    }
  };
  let r = (e) => {
    if (e) {
      re(e)
        .then((e) => {
          y.ollama = e || [];
        })
        .catch((e) => {
          console.error(e);
          y.ollama = [];
        });
    }
  };
  let i = (e) => {
    if (e) {
      De(
        Z,
        (e) => {
          y.copilot = e;
        },
        e,
        S,
      );
    }
  };
  let a = () => {
    Ee(Z, (e) => {
      y.builtin = e;
    });
  };
  u(() => {
    t(e());
  });
  u(() => {
    i(e());
  });
  u(() => {
    a();
  });
  u(() => {
    n(e());
  });
  u(() => {
    r(e());
  });
  d(() =>
    ae(() => {
      m(f).then((e) => {
        t(e);
        r(e);
        n(e);
        i(e);
        a();
      });
    }),
  );
};
var Q = `flatModelsKey`;
var Me = () => e(Q);
var $ = `providersKey`;
var Ne = () => e($);
function Pe(e, u) {
  r(u, true);
  let d = () => ee(p, `$i18n`, f);
  let [f, m] = te();
  let h = b();
  h.data;
  let g = ue();
  g.data;
  n($, () => [
    ...(g.data ?? []).map((e) => ({
      ...e,
      name: z(d(), e),
    })),
    ...P,
  ]);
  let _ = c(() => h.data || {});
  n(Q, () =>
    ie({
      openai:
        !!i(_).openai_api_key ||
        !!A(i(_), {
          id: `openai`,
        }).isObserved,
      codex: !!i(_).codex_auth?.access_token,
      groq:
        !!i(_).groq_api_key ||
        !!A(i(_), {
          id: `groq`,
        }).isObserved,
      anthropic:
        !!i(_).anthropic_api_key ||
        i(_).anthropic_auth_mode === `oauth` ||
        !!A(i(_), {
          id: `anthropic`,
        }).isObserved,
      googleai:
        !!i(_).googleai_api_key ||
        i(_).googleai_auth_mode === `oauth` ||
        !!A(i(_), {
          id: `googleai`,
        }).isObserved,
      deepseek:
        !!i(_).deepseek_api_key ||
        !!A(i(_), {
          id: `deepseek`,
        }).isObserved,
      copilot: !!i(_).copilot_auth_token,
      xai:
        !!i(_).xai_api_key ||
        !!A(i(_), {
          id: `xai`,
        }).isObserved,
      pplx:
        !!i(_).pplx_api_key ||
        !!A(i(_), {
          id: `pplx`,
        }).isObserved,
      azure:
        !!i(_).azure_api_key ||
        !!A(i(_), {
          id: `azure`,
        }).isObserved,
      mistral:
        !!i(_).mistral_api_key ||
        !!A(i(_), {
          id: `mistral`,
        }).isObserved,
      customProviders: g.data,
    }),
  );
  je();
  var v = o();
  t(l(v), () => u.children);
  a(e, v);
  s();
  m();
}
export {
  de as C,
  E as S,
  C as T,
  O as _,
  G as a,
  D as b,
  L as c,
  z as d,
  V as f,
  I as g,
  N as h,
  Te as i,
  P as l,
  B as m,
  Me as n,
  U as o,
  R as p,
  Ne as r,
  M as s,
  Pe as t,
  F as u,
  j as v,
  w,
  me as x,
  A as y,
};
//# sourceMappingURL=BgIK4H_S.js.map
//# chunkId=019dca39-ff7d-7f92-a685-b9f7e0c938a4
