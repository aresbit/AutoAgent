import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type EngineConfigPatch,
  type EngineConfigView,
  type EngineStatusView,
  type PermissionMode,
  type ProviderCatalogView,
  type SettingsPatch,
  type SettingsView,
  type ThinkingMode,
  type Effort,
} from "@/api/client";
import { useTheme, type Theme } from "@/app/providers";
import {
  Badge,
  Button,
  Field,
  Input,
  SaveCheck,
  SectionLabel,
  Select,
  Skeleton,
  Textarea,
} from "@/cds";
import { errorMessage } from "@/lib/errorMessage";
import {
  buildEngineConfigPatch,
  effectiveModelName,
  engineConfigDraftFrom,
  modelSourceLabel,
  modelSourceTone,
  type EngineConfigDraft,
} from "./logic";

interface Draft {
  providerId: string;
  model: string;
  fallbackModel: string;
  baseURL: string;
  cwd: string;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  effort: Effort;
  maxTurns: string;
  maxBudgetUsd: string;
  taskBudget: string;
  allowedTools: string;
  disallowedTools: string;
  addDirs: string;
  appendSystemPrompt: string;
}

function draftFrom(settings: SettingsView): Draft {
  return {
    providerId: settings.providerId,
    model: settings.model,
    fallbackModel: settings.fallbackModel ?? "",
    baseURL: settings.baseURL ?? "",
    cwd: settings.cwd,
    permissionMode: settings.permissionMode,
    thinkingMode: settings.thinkingMode,
    effort: settings.effort,
    maxTurns: String(settings.maxTurns),
    maxBudgetUsd: settings.maxBudgetUsd === null ? "" : String(settings.maxBudgetUsd),
    taskBudget: settings.taskBudget === null ? "" : String(settings.taskBudget),
    allowedTools: settings.allowedTools.join(", "),
    disallowedTools: settings.disallowedTools.join(", "),
    addDirs: settings.addDirs.join(", "),
    appendSystemPrompt: settings.appendSystemPrompt,
  };
}

function listOf(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SettingsPanel({
  settings,
  providers,
  onSave,
}: {
  settings: SettingsView;
  providers: ProviderCatalogView;
  onSave: (patch: SettingsPatch) => Promise<SettingsView>;
}) {
  const { theme, setTheme } = useTheme();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const engineConfigQuery = useQuery({
    queryKey: ["engine-config"],
    queryFn: () => api.engineConfig(),
  });
  const [fallback, setFallback] = useState<EngineConfigDraft>({
    model: "",
    baseURL: "",
    apiKey: "",
    apiKeyHelper: "",
  });
  const [fallbackSaved, setFallbackSaved] = useState(false);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  useEffect(() => {
    if (!engineConfigQuery.data) return;
    setFallback(engineConfigDraftFrom(engineConfigQuery.data));
  }, [engineConfigQuery.data]);

  useEffect(() => {
    if (!fallbackSaved) return;
    const timer = setTimeout(() => setFallbackSaved(false), 2400);
    return () => clearTimeout(timer);
  }, [fallbackSaved]);

  const saveFallback = useMutation({
    mutationFn: (patch: EngineConfigPatch) => api.updateEngineConfig(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["engine-config"] });
      const previous = queryClient.getQueryData<EngineConfigView>(["engine-config"]);
      if (previous) {
        queryClient.setQueryData<EngineConfigView>(["engine-config"], {
          ...previous,
          model: patch.model ?? previous.model,
          baseURL:
            patch.baseURL === undefined
              ? previous.baseURL
              : patch.baseURL.trim() || null,
          apiKeyHelper:
            patch.apiKeyHelper === undefined
              ? previous.apiKeyHelper
              : patch.apiKeyHelper.trim() || null,
          apiKeyConfigured:
            patch.apiKey === undefined
              ? previous.apiKeyConfigured
              : patch.apiKey.trim().length > 0,
        });
      }
      return { previous };
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["engine-config"], next);
      setFallback(engineConfigDraftFrom(next));
      setFallbackError(null);
      setFallbackSaved(true);
    },
    onError: (mutationError, _patch, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["engine-config"], context.previous);
      }
      setFallbackError(
        errorMessage(mutationError, "The fallback config could not be saved."),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["engine-config"] });
    },
  });

  const settingsKey = JSON.stringify(draftFrom(settings));

  useEffect(() => {
    setDraft(draftFrom(settings));
    // Resets only when editable values change; layout updates keep the draft intact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2400);
    return () => clearTimeout(timer);
  }, [saved]);

  const allProviders = useMemo(
    () => [...providers.builtin, ...providers.custom],
    [providers],
  );
  const provider = allProviders.find((item) => item.id === draft.providerId);
  const isMatebot = draft.providerId === "matebot" || provider?.id === "matebot";
  const matebotEngine =
    settings.engine.preset === "matebot" ||
    settings.engine.mode === "matebot" ||
    isMatebot;
  const runtimeLabel = matebotEngine
    ? "MateBot (opencc --matebot)"
    : settings.engine.preset === "bundled"
      ? "Bundled engine"
      : "Custom engine";
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftFrom(settings)) || apiKey.trim().length > 0;

  const patch = (values: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...values }));

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const next: SettingsPatch = {
        providerId: draft.providerId,
        model: draft.model.trim(),
        fallbackModel: draft.fallbackModel.trim() || null,
        baseURL: draft.baseURL.trim() || null,
        cwd: draft.cwd.trim(),
        permissionMode: draft.permissionMode,
        thinkingMode: draft.thinkingMode,
        effort: draft.effort,
        maxTurns: Math.max(1, Number.parseInt(draft.maxTurns, 10) || 1),
        maxBudgetUsd:
          draft.maxBudgetUsd.trim() === "" ? null : Number(draft.maxBudgetUsd),
        taskBudget:
          draft.taskBudget.trim() === "" ? null : Number(draft.taskBudget),
        allowedTools: listOf(draft.allowedTools),
        disallowedTools: listOf(draft.disallowedTools),
        addDirs: listOf(draft.addDirs),
        appendSystemPrompt: draft.appendSystemPrompt,
      };
      if (apiKey.trim()) next.apiKey = apiKey.trim();
      await onSave(next);
      setApiKey("");
      setSaved(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-area flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 px-3 py-4">
          <section className="flex flex-col gap-3">
            <SectionLabel>Model</SectionLabel>
            <Field label="Provider">
              <div className="control flex h-9 items-center gap-2 rounded-lg px-3">
                <Badge tone="accent">MateBot</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {provider?.name ?? "MateBot (OpenCC)"}
                </span>
                <span className="t-code flex-none text-[10.5px] text-ink-3">
                  {isMatebot ? "opencc --matebot" : provider?.apiType ?? ""}
                </span>
              </div>
            </Field>
            <Field label="Effective model">
              <div className="control flex min-h-9 items-center gap-2 rounded-lg px-3 py-1.5">
                <span className="t-code min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {effectiveModelName(settings.engine.model)}
                </span>
                <Badge
                  tone={modelSourceTone(settings.engine.modelSource)}
                  className="flex-none"
                >
                  {modelSourceLabel(settings.engine.modelSource)}
                </Badge>
              </div>
            </Field>
            {settings.engine.configPath ? (
              <p className="-mt-1 text-[11px] leading-relaxed text-ink-3">
                Config:{" "}
                <span className="t-code text-ink-2">{settings.engine.configPath}</span>
              </p>
            ) : null}
            <Field
              label={isMatebot ? "App override (--model)" : "Model"}
              htmlFor="setting-model"
              hint={
                isMatebot
                  ? "Leave blank to reuse ~/.claude/settings.json. An override is passed as --model for desktop sessions only and does not modify the file."
                  : provider?.allowCustomModels
                    ? "Type any model id this provider accepts."
                    : "Choose one of the models supported by this provider."
              }
            >
              <Input
                id="setting-model"
                value={draft.model}
                list="model-options"
                placeholder={isMatebot ? "Reuse global config" : undefined}
                onChange={(event) => patch({ model: event.target.value })}
              />
              {!isMatebot ? (
                <datalist id="model-options">
                  {provider?.models.map((model) => <option key={model} value={model} />)}
                </datalist>
              ) : null}
            </Field>
            <Field label="Fallback model" htmlFor="setting-fallback">
              <Input
                id="setting-fallback"
                value={draft.fallbackModel}
                onChange={(event) => patch({ fallbackModel: event.target.value })}
                placeholder="Optional"
              />
            </Field>
            {isMatebot ? (
              <p className="rounded-card bg-panel-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-2">
                Credentials are inherited from the OpenCC/MateBot environment; the
                engine runs locally with{" "}
                <span className="t-code text-ink">--matebot</span>.
              </p>
            ) : (
              <>
                <Field label="Base URL" htmlFor="setting-base-url">
                  <Input
                    id="setting-base-url"
                    value={draft.baseURL}
                    onChange={(event) => patch({ baseURL: event.target.value })}
                    placeholder="Provider default"
                  />
                </Field>
                <Field
                  label="API key"
                  htmlFor="setting-api-key"
                  hint="Stored by the local service and never shown again."
                >
                  <Input
                    id="setting-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      settings.apiKeyConfigured ? "Configured" : "Not configured"
                    }
                    autoComplete="off"
                  />
                </Field>
              </>
            )}
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>AutoAgent fallback config</SectionLabel>
            {engineConfigQuery.isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : engineConfigQuery.isError ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[11.5px] leading-relaxed text-bad" role="alert">
                  {errorMessage(
                    engineConfigQuery.error,
                    "The fallback config could not be read.",
                  )}
                </p>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => void engineConfigQuery.refetch()}
                  loading={engineConfigQuery.isFetching}
                >
                  Retry
                </Button>
              </div>
            ) : engineConfigQuery.data ? (
              <>
                <p className="-mt-1 text-[11px] leading-relaxed text-ink-3">
                  File:{" "}
                  <span className="t-code text-ink-2">
                    {engineConfigQuery.data.configPath}
                  </span>
                </p>
                <Field label="Model" htmlFor="fallback-model" hint="Leave blank to clear.">
                  <Input
                    id="fallback-model"
                    value={fallback.model}
                    placeholder="OpenCC default"
                    onChange={(event) =>
                      setFallback((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Base URL" htmlFor="fallback-base-url" hint="Leave blank to clear.">
                  <Input
                    id="fallback-base-url"
                    value={fallback.baseURL}
                    placeholder="Not set"
                    onChange={(event) =>
                      setFallback((current) => ({
                        ...current,
                        baseURL: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="API key"
                  htmlFor="fallback-api-key"
                  hint="Stored by the local service and never shown again."
                >
                  <Input
                    id="fallback-api-key"
                    type="password"
                    value={fallback.apiKey}
                    placeholder={
                      engineConfigQuery.data.apiKeyConfigured
                        ? "Configured"
                        : "Not configured"
                    }
                    autoComplete="off"
                    onChange={(event) =>
                      setFallback((current) => ({
                        ...current,
                        apiKey: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field
                  label="API key helper"
                  htmlFor="fallback-api-key-helper"
                  hint="Optional command that prints the key. Leave blank to clear."
                >
                  <Input
                    id="fallback-api-key-helper"
                    value={fallback.apiKeyHelper}
                    placeholder="Optional"
                    autoComplete="off"
                    onChange={(event) =>
                      setFallback((current) => ({
                        ...current,
                        apiKeyHelper: event.target.value,
                      }))
                    }
                  />
                </Field>
                <p className="rounded-card bg-panel-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-2">
                  Used only when ~/.claude/settings.json has no model/credentials.
                  The app override above still takes precedence.
                </p>
                {fallbackError ? (
                  <p className="text-[11.5px] text-bad" role="alert">
                    {fallbackError}
                  </p>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-ink-3">
                    {saveFallback.isPending ? "Saving fallback…" : ""}
                  </span>
                  <div className="flex items-center gap-2">
                    <SaveCheck show={fallbackSaved} />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={saveFallback.isPending}
                      onClick={() =>
                        saveFallback.mutate(buildEngineConfigPatch(fallback))
                      }
                    >
                      Save fallback
                    </Button>
                  </div>
                </div>
              </>
            ) : null}
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>Engine</SectionLabel>
            <dl className="flex flex-col gap-2 rounded-card bg-panel-2 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[12px] text-ink-3">Runtime</dt>
                <dd className="text-right text-[12px] font-medium text-ink">
                  {runtimeLabel}
                </dd>
              </div>
              {settings.engine.mode ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[12px] text-ink-3">Mode</dt>
                  <dd className="t-code text-[11.5px] text-ink-2">
                    {settings.engine.mode}
                  </dd>
                </div>
              ) : null}
              {settings.engine.cli ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="flex-none text-[12px] text-ink-3">CLI</dt>
                  <dd
                    className="t-code min-w-0 truncate text-right text-[11.5px] text-ink-2"
                    title={settings.engine.cli}
                  >
                    {settings.engine.cli}
                  </dd>
                </div>
              ) : null}
              {settings.engine.version ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-[12px] text-ink-3">Version</dt>
                  <dd className="t-code truncate text-[11.5px] text-ink-2">
                    {settings.engine.version}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>Workspace</SectionLabel>
            <Field
              label="Working directory"
              htmlFor="setting-cwd"
              hint="The engine runs inside this directory."
            >
              <Input
                id="setting-cwd"
                value={draft.cwd}
                onChange={(event) => patch({ cwd: event.target.value })}
                className="t-code"
              />
            </Field>
            <Field
              label="Permission mode"
              htmlFor="setting-permission"
              hint="This build runs with full access. Other modes are not available yet."
            >
              <Select
                id="setting-permission"
                value={draft.permissionMode}
                onChange={(event) =>
                  patch({ permissionMode: event.target.value as PermissionMode })
                }
              >
                <option value="bypassPermissions">Full access</option>
                <option value="default" disabled>
                  Ask before changes
                </option>
                <option value="acceptEdits" disabled>
                  Accept edits
                </option>
                <option value="auto" disabled>
                  Automatic
                </option>
              </Select>
            </Field>
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>Behaviour</SectionLabel>
            <Field label="Thinking" htmlFor="setting-thinking">
              <Select
                id="setting-thinking"
                value={draft.thinkingMode}
                onChange={(event) =>
                  patch({ thinkingMode: event.target.value as ThinkingMode })
                }
              >
                <option value="">Provider default</option>
                <option value="adaptive">Adaptive</option>
                <option value="enabled">Always on</option>
                <option value="disabled">Off</option>
              </Select>
            </Field>
            <Field label="Effort" htmlFor="setting-effort">
              <Select
                id="setting-effort"
                value={draft.effort}
                onChange={(event) => patch({ effort: event.target.value as Effort })}
              >
                <option value="">Provider default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="max">Maximum</option>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max turns" htmlFor="setting-turns">
                <Input
                  id="setting-turns"
                  inputMode="numeric"
                  value={draft.maxTurns}
                  onChange={(event) => patch({ maxTurns: event.target.value })}
                  className="t-num"
                />
              </Field>
              <Field label="Budget (USD)" htmlFor="setting-budget">
                <Input
                  id="setting-budget"
                  inputMode="decimal"
                  value={draft.maxBudgetUsd}
                  onChange={(event) => patch({ maxBudgetUsd: event.target.value })}
                  placeholder="None"
                  className="t-num"
                />
              </Field>
            </div>
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>Tools and context</SectionLabel>
            <Field
              label="Allowed tools"
              htmlFor="setting-allowed-tools"
              hint="Comma-separated. Leave blank to allow the provider default."
            >
              <Input
                id="setting-allowed-tools"
                value={draft.allowedTools}
                onChange={(event) => patch({ allowedTools: event.target.value })}
                placeholder="Read, Grep, Glob"
              />
            </Field>
            <Field
              label="Disallowed tools"
              htmlFor="setting-disallowed-tools"
              hint="Comma-separated. These always stay off."
            >
              <Input
                id="setting-disallowed-tools"
                value={draft.disallowedTools}
                onChange={(event) => patch({ disallowedTools: event.target.value })}
                placeholder="WebFetch"
              />
            </Field>
            <Field label="Extra directories" htmlFor="setting-add-dirs">
              <Input
                id="setting-add-dirs"
                value={draft.addDirs}
                onChange={(event) => patch({ addDirs: event.target.value })}
                placeholder="/path/to/library"
                className="t-code"
              />
            </Field>
            <Field label="Append to system prompt" htmlFor="setting-system-prompt">
              <Textarea
                id="setting-system-prompt"
                value={draft.appendSystemPrompt}
                onChange={(event) =>
                  patch({ appendSystemPrompt: event.target.value })
                }
                placeholder="Optional guidance for every turn"
                className="min-h-16"
              />
            </Field>
            <Field label="Task budget (USD)" htmlFor="setting-task-budget">
              <Input
                id="setting-task-budget"
                inputMode="decimal"
                value={draft.taskBudget}
                onChange={(event) => patch({ taskBudget: event.target.value })}
                placeholder="None"
                className="t-num"
              />
            </Field>
          </section>

          <section className="hairline-t flex flex-col gap-3 pt-4">
            <SectionLabel>Appearance</SectionLabel>
            <Field label="Theme" htmlFor="setting-theme">
              <Select
                id="setting-theme"
                value={theme}
                onChange={(event) => setTheme(event.target.value as Theme)}
              >
                <option value="system">Follow the system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </Field>
          </section>
        </div>
      </div>

      <div className="hairline-t bg-panel px-3 py-2.5">
        {error ? (
          <p className="mb-2 text-[11.5px] leading-relaxed text-bad" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-3">
            {dirty ? "Unsaved changes" : "Everything is up to date"}
          </span>
          <div className="flex items-center gap-2">
            <SaveCheck show={saved} />
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EnginePanel({
  engine,
  refreshing,
  onRefresh,
}: {
  engine: EngineStatusView | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="scroll-area flex-1 overflow-y-auto px-3 py-4">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Engine</SectionLabel>
        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          loading={refreshing}
        >
          Refresh
        </Button>
      </div>

      {!engine ? (
        <p className="mt-4 text-[12px] text-ink-3">Waiting for the engine…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Badge
              tone={
                engine.state === "error"
                  ? "bad"
                  : engine.state === "idle"
                    ? "ok"
                    : "accent"
              }
              dot
            >
              {engine.state}
            </Badge>
            <span className="text-[12px] text-ink-2">{engine.mode}</span>
          </div>

          <dl className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[12px] text-ink-3">Active turns</dt>
              <dd className="t-num text-[12px] text-ink">{engine.activeTurns}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[12px] text-ink-3">Version</dt>
              <dd className="t-code truncate text-[11.5px] text-ink-2">
                {engine.version ?? "Unknown"}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[12px] text-ink-3">Runtime</dt>
              <dd className="text-[12px] text-ink-2">
                {engine.mode === "matebot"
                  ? "MateBot (opencc --matebot)"
                  : engine.mode}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[12px] text-ink-3">Mode</dt>
              <dd className="text-[12px] text-ink-2">{engine.mode}</dd>
            </div>
          </dl>

          {engine.lastError ? (
            <div className="rounded-card bg-bad/10 px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-bad">
                Last error
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
                {engine.lastError}
              </p>
            </div>
          ) : (
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              No engine errors have been reported in this session.
            </p>
          )}

          <p className="hairline-t pt-3 text-[11px] leading-relaxed text-ink-3">
            Status is read-only. The local service manages the engine process and
            exposes only sanitized details here.
          </p>
        </div>
      )}
    </div>
  );
}
