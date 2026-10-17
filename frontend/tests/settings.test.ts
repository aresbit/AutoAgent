import { describe, expect, it } from "vitest";
import {
  buildEngineConfigPatch,
  effectiveModelName,
  engineConfigDraftFrom,
  modelSourceLabel,
  modelSourceTone,
} from "@/features/settings/logic";

describe("engine model source", () => {
  it("labels claude settings and env as the global config", () => {
    expect(modelSourceLabel("claude-settings")).toBe("from ~/.claude/settings.json");
    expect(modelSourceLabel("env")).toBe("from ~/.claude/settings.json");
    expect(modelSourceTone("claude-settings")).toBe("info");
    expect(modelSourceTone("env")).toBe("info");
  });

  it("labels the AutoAgent fallback source", () => {
    expect(modelSourceLabel("autoagent")).toBe("from ~/.autoagent/settings.json");
    expect(modelSourceTone("autoagent")).toBe("info");
  });

  it("marks an app override and the OpenCC default", () => {
    expect(modelSourceLabel("override")).toBe("app override");
    expect(modelSourceTone("override")).toBe("accent");
    expect(modelSourceLabel("default")).toBe("OpenCC default");
    expect(modelSourceLabel(undefined)).toBe("OpenCC default");
    expect(modelSourceTone(undefined)).toBe("neutral");
  });

  it("falls back to a readable effective model name", () => {
    expect(effectiveModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(effectiveModelName("")).toBe("OpenCC default");
    expect(effectiveModelName(null)).toBe("OpenCC default");
    expect(effectiveModelName("  ")).toBe("OpenCC default");
  });
});

describe("AutoAgent fallback config", () => {
  const view = {
    configPath: "~/.autoagent/settings.json",
    model: "fallback-model",
    baseURL: "https://gateway.test",
    apiKeyConfigured: true,
    apiKeyHelper: "pass show autoagent",
    engine: { preset: "matebot" as const, version: "opencc" },
  };

  it("maps a view to an editable draft without the secret", () => {
    expect(engineConfigDraftFrom(view)).toEqual({
      model: "fallback-model",
      baseURL: "https://gateway.test",
      apiKey: "",
      apiKeyHelper: "pass show autoagent",
    });
  });

  it("clears model and URL with empty strings but omits an untouched key", () => {
    const patch = buildEngineConfigPatch({
      model: "  ",
      baseURL: "  ",
      apiKey: "   ",
      apiKeyHelper: "",
    });
    expect(patch).toEqual({ model: "", baseURL: "", apiKeyHelper: "" });
    expect(patch.apiKey).toBeUndefined();
  });

  it("sends a typed API key", () => {
    expect(
      buildEngineConfigPatch({
        model: "m",
        baseURL: "",
        apiKey: "sk-test",
        apiKeyHelper: "",
      }),
    ).toEqual({ model: "m", baseURL: "", apiKey: "sk-test", apiKeyHelper: "" });
  });
});

