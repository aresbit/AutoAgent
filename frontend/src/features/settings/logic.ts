import type {
  EngineConfigPatch,
  EngineConfigView,
  EngineModelSource,
} from "@/api/client";
import type { Tone } from "@/cds";

export function modelSourceLabel(source?: EngineModelSource): string {
  if (source === "override") return "app override";
  if (source === "claude-settings" || source === "env") {
    return "from ~/.claude/settings.json";
  }
  if (source === "autoagent") return "from ~/.autoagent/settings.json";
  return "OpenCC default";
}

export function modelSourceTone(source?: EngineModelSource): Tone {
  if (source === "override") return "accent";
  if (
    source === "claude-settings" ||
    source === "env" ||
    source === "autoagent"
  ) {
    return "info";
  }
  return "neutral";
}

export function effectiveModelName(model?: string | null): string {
  return model?.trim() || "OpenCC default";
}

export interface EngineConfigDraft {
  model: string;
  baseURL: string;
  apiKey: string;
  apiKeyHelper: string;
}

export function engineConfigDraftFrom(view: EngineConfigView): EngineConfigDraft {
  return {
    model: view.model,
    baseURL: view.baseURL ?? "",
    apiKey: "",
    apiKeyHelper: view.apiKeyHelper ?? "",
  };
}

export function buildEngineConfigPatch(
  draft: EngineConfigDraft,
): EngineConfigPatch {
  const patch: EngineConfigPatch = {
    model: draft.model.trim(),
    baseURL: draft.baseURL.trim(),
    apiKeyHelper: draft.apiKeyHelper.trim(),
  };
  if (draft.apiKey.trim()) patch.apiKey = draft.apiKey.trim();
  return patch;
}
