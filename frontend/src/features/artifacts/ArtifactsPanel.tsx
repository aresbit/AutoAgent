import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Code2,
  Download,
  Eye,
  FileUp,
  RefreshCw,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, ApiError, type ArtifactView } from "@/api/client";
import { fallbackArtifactVersions } from "@/api/artifacts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SectionLabel,
  Skeleton,
  isComposingEvent,
} from "@/cds";
import { InlineError, PanelHeader, PanelScroll } from "@/features/panels/Chrome";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import { relativeTime, truncate } from "@/lib/format";
import { chooseOpenPath, chooseSavePath, nativeBridge } from "@/lib/native";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactVersionList } from "./VersionList";
import { displayTitle, sortArtifacts, artifactVersionCount, type ChatArtifact } from "./logic";

type PathAction = { kind: "export"; artifact: ArtifactView } | { kind: "import" };

export function ArtifactsPanel({
  initialArtifacts = [],
  request = null,
  onRequestHandled,
}: {
  initialArtifacts?: ArtifactView[];
  request?: ChatArtifact | null;
  onRequestHandled?: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["artifacts"] as const;
  const artifactsQuery = useQuery({
    queryKey,
    queryFn: () => api.artifacts(),
    initialData: initialArtifacts,
  });
  const artifacts = sortArtifacts(artifactsQuery.data);
  const [preview, setPreview] = useState<ArtifactView | null>(null);
  const [draft, setDraft] = useState<ChatArtifact | null>(null);
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [versionApiSupported, setVersionApiSupported] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pathAction, setPathAction] = useState<PathAction | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const composing = useRef(false);

  useEffect(() => {
    if (!request) return;
    setPreview(null);
    setDraft(request);
    setMode("preview");
    onRequestHandled?.();
  }, [request, onRequestHandled]);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const contentQuery = useQuery({
    queryKey: ["artifact-content", preview?.id],
    queryFn: () => api.artifactContent(preview?.id ?? ""),
    enabled: Boolean(preview) && draft === null,
    staleTime: 30_000,
  });

  const versionsQuery = useQuery({
    queryKey: ["artifact-versions", preview?.id],
    queryFn: () => api.artifactVersions(preview?.id ?? ""),
    enabled: Boolean(preview) && draft === null && versionApiSupported,
    retry: false,
    staleTime: 15_000,
  });

  /**
   * A short-lived token for the backend-served frame document. The key
   * includes the revision, so restoring or switching versions refetches it.
   * Failures (mock/dev without the endpoint) leave `data` undefined and the
   * frame falls back to the static srcDoc.
   */
  const frameTokenQuery = useQuery({
    queryKey: ["artifact-frame-token", preview?.id, preview?.revision ?? null],
    queryFn: () => api.artifactFrameToken(preview?.id ?? "", preview?.revision),
    enabled: Boolean(preview) && draft === null,
    retry: false,
  });

  useEffect(() => {
    const error = versionsQuery.error;
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      setVersionApiSupported(false);
    }
  }, [versionsQuery.error]);

  const touch = useMutation({
    mutationFn: (id: string) => api.markArtifactOpened(id),
    onSuccess: (next) => {
      queryClient.setQueryData<ArtifactView[]>(queryKey, (current) =>
        current?.map((item) => (item.id === next.id ? next : item)),
      );
    },
  });

  const exportArtifact = useMutation({
    mutationFn: ({ id, targetPath }: { id: string; targetPath: string }) =>
      api.exportArtifact(id, targetPath),
    onSuccess: (result, input) => {
      const artifact = artifacts.find((item) => item.id === input.id);
      setNotice(`Exported ${artifact ? displayTitle(artifact) : "artifact"} to ${result.path}`);
      setPathAction(null);
      setPathDraft("");
    },
    onError: (error) => setActionError(errorMessage(error, "The artifact could not be exported.")),
  });

  const importArtifact = useMutation({
    mutationFn: (zipPath: string) => api.importArtifact(zipPath),
    onSuccess: (next) => {
      queryClient.setQueryData<ArtifactView[]>(queryKey, (current) => [next, ...(current ?? [])]);
      setNotice(`Imported ${displayTitle(next)}`);
      setPathAction(null);
      setPathDraft("");
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => setActionError(errorMessage(error, "The artifact could not be imported.")),
  });

  const restoreVersion = useMutation({
    mutationFn: ({ id, versionId }: { id: string; versionId: string }) =>
      api.restoreArtifactVersion(id, versionId),
    onSuccess: (next) => {
      queryClient.setQueryData<ArtifactView[]>(queryKey, (current) =>
        current?.map((item) => (item.id === next.id ? next : item)),
      );
      setPreview(next);
      setNotice("Restored the snapshot as a new version.");
      void queryClient.invalidateQueries({ queryKey: ["artifact-versions", next.id] });
      void queryClient.invalidateQueries({ queryKey: ["artifact-content", next.id] });
    },
    onError: (error) =>
      setActionError(errorMessage(error, "The artifact version could not be restored.")),
  });

  const openPreview = (artifact: ArtifactView) => {
    setDraft(null);
    setPreview(artifact);
    setMode("preview");
    touch.mutate(artifact.id);
  };

  const closePreview = () => {
    setPreview(null);
    setDraft(null);
    setMode("preview");
  };

  const startExport = async (artifact: ArtifactView) => {
    setActionError(null);
    if (nativeBridge()) {
      try {
        const path = await chooseSavePath({
          title: "Export artifact",
          defaultPath: `${artifact.id}.zip`,
          filters: [{ name: "Zip archive", extensions: ["zip"] }],
        });
        if (path) exportArtifact.mutate({ id: artifact.id, targetPath: path });
        return;
      } catch (error) {
        setActionError(errorMessage(error, "The save dialog could not be opened."));
        return;
      }
    }
    setPathDraft(`${artifact.id}.zip`);
    setPathError(null);
    setPathAction({ kind: "export", artifact });
  };

  const startImport = async () => {
    setActionError(null);
    if (nativeBridge()) {
      try {
        const path = await chooseOpenPath({
          title: "Import artifact",
          filters: [{ name: "Zip archive", extensions: ["zip"] }],
        });
        if (path) importArtifact.mutate(path);
        return;
      } catch (error) {
        setActionError(errorMessage(error, "The open dialog could not be opened."));
        return;
      }
    }
    setPathDraft("");
    setPathError(null);
    setPathAction({ kind: "import" });
  };

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    const value = pathDraft.trim();
    if (!value) {
      setPathError("A path is required.");
      return;
    }
    if (!pathAction) return;
    if (pathAction.kind === "export") {
      exportArtifact.mutate({ id: pathAction.artifact.id, targetPath: value });
    } else {
      importArtifact.mutate(value);
    }
  };

  const pathPending = exportArtifact.isPending || importArtifact.isPending;
  const dialogOpen = preview !== null || draft !== null;
  const previewTitle = draft?.title ?? (preview ? displayTitle(preview) : "Artifact");
  const previewHtml = draft?.html ?? contentQuery.data ?? "";
  const versions = !preview
    ? []
    : versionsQuery.data && versionsQuery.data.length > 0
      ? versionsQuery.data.map((item) => ({
          ...item,
          current: preview.revision
            ? item.versionId === preview.revision
            : item.current,
        }))
      : fallbackArtifactVersions(preview.versions);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={<Boxes size={14} strokeWidth={2} />}
        title="Artifacts"
        meta={artifacts.length}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh artifacts"
              onClick={() => void artifactsQuery.refetch()}
              loading={artifactsQuery.isFetching}
            >
              <RefreshCw size={13} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Import artifact"
              onClick={() => void startImport()}
              loading={importArtifact.isPending}
            >
              <FileUp size={13} strokeWidth={2} />
            </Button>
          </>
        }
      />
      <PanelScroll>
        <div className="flex flex-col gap-3">
          {actionError ? (
            <InlineError message={actionError} onDismiss={() => setActionError(null)} />
          ) : null}
          {notice ? (
            <p
              role="status"
              className="rounded-lg bg-ok/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-ok"
            >
              {truncate(notice, 120)}
            </p>
          ) : null}

          {artifactsQuery.isError ? (
            <ErrorState
              title="Artifacts unavailable"
              message={errorMessage(artifactsQuery.error, "The artifact list could not be read.")}
              retry={() => void artifactsQuery.refetch()}
              retrying={artifactsQuery.isFetching}
            />
          ) : artifactsQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : artifacts.length === 0 ? (
            <EmptyState
              icon={<Boxes size={18} strokeWidth={1.8} />}
              title="No artifacts yet"
              description="Artifacts created during a turn, or imported from a zip archive, appear here."
              action={
                <Button size="sm" variant="secondary" onClick={() => void startImport()}>
                  <Upload size={13} strokeWidth={2} />
                  Import
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {artifacts.map((artifact) => (
                <li
                  key={artifact.id}
                  className="flex flex-col gap-1.5 rounded-card bg-surface p-2.5 shadow-panel transition-shadow duration-150 ease-out-expo hover:shadow-panel-hover"
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:shadow-focus"
                      onClick={() => openPreview(artifact)}
                    >
                      <p className="truncate text-[12.5px] font-medium text-ink">
                        {displayTitle(artifact)}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-2">
                        {artifact.description || "No description."}
                      </p>
                    </button>
                    <div className="flex flex-none items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Preview ${displayTitle(artifact)}`}
                        onClick={() => openPreview(artifact)}
                      >
                        <Eye size={12} strokeWidth={2} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Export ${displayTitle(artifact)}`}
                        onClick={() => void startExport(artifact)}
                        loading={exportArtifact.isPending}
                      >
                        <Download size={12} strokeWidth={2} />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="neutral">
                      <span className="t-num">{artifactVersionCount(artifact)}</span>
                      {artifactVersionCount(artifact) === 1 ? " version" : " versions"}
                    </Badge>
                    <span className="text-[10.5px] text-ink-3">
                      updated {relativeTime(artifact.updatedAt)}
                    </span>
                    {artifact.lastOpenedAt ? (
                      <span className="text-[10.5px] text-ink-3">
                        opened {relativeTime(artifact.lastOpenedAt)}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col gap-1">
            <SectionLabel>Storage</SectionLabel>
            <p className="text-[11px] leading-relaxed text-ink-3">
              Artifacts are addressed by id. Preview content is fetched through the local API
              and rendered in a sandboxed frame with a strict CSP: scripts may run, but
              same-origin access, network requests, top navigation and popups are blocked.
            </p>
          </div>
        </div>
      </PanelScroll>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
        title={previewTitle}
        description={
          draft ? "Artifact from the conversation" : preview?.description || undefined
        }
        width={760}
        footer={
          <>
            {preview ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void startExport(preview)}
                loading={exportArtifact.isPending}
              >
                <Download size={13} strokeWidth={2} />
                Export
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={closePreview}>
              Close
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2.5">
          <div className="inline-flex self-start rounded-full bg-[var(--segmented-track)] p-0.5">
            <button
              type="button"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus",
                mode === "preview"
                  ? "bg-[var(--segmented-thumb)] text-ink shadow-thumb"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              <Eye size={12} strokeWidth={2} />
              Preview
            </button>
            <button
              type="button"
              aria-pressed={mode === "source"}
              onClick={() => setMode("source")}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus",
                mode === "source"
                  ? "bg-[var(--segmented-thumb)] text-ink shadow-thumb"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              <Code2 size={12} strokeWidth={2} />
              Source
            </button>
          </div>

          {!draft && contentQuery.isLoading ? (
            <Skeleton className="h-[min(52vh,460px)]" />
          ) : !draft && contentQuery.isError ? (
            <ErrorState
              title="Preview unavailable"
              message={errorMessage(contentQuery.error, "The artifact content could not be read.")}
              retry={() => void contentQuery.refetch()}
              retrying={contentQuery.isFetching}
            />
          ) : mode === "preview" ? (
            <ArtifactFrame
              html={previewHtml}
              title={previewTitle}
              minHeight={320}
              maxHeight={460}
              frameUrl={draft ? undefined : frameTokenQuery.data?.url}
              onShowSource={() => setMode("source")}
            />
          ) : (
            <pre className="t-code scroll-area h-[min(52vh,460px)] overflow-auto rounded-card bg-code p-3 text-[11px] leading-relaxed text-code-ink">
              {previewHtml}
            </pre>
          )}

          {preview ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>Versions</SectionLabel>
                {versionsQuery.isFetching ? (
                  <span className="flex items-center gap-1 text-[10.5px] text-ink-3">
                    <RefreshCw size={10} strokeWidth={2} className="animate-spin" />
                    Refreshing
                  </span>
                ) : null}
              </div>
              <ArtifactVersionList
                versions={versions}
                canRestore={versionApiSupported && versionsQuery.isSuccess}
                restoringVersion={
                  restoreVersion.isPending
                    ? restoreVersion.variables?.versionId ?? null
                    : null
                }
                onRestore={(versionId) =>
                  restoreVersion.mutate({ id: preview.id, versionId })
                }
              />
              {!versionApiSupported ? (
                <p className="text-[10.5px] leading-relaxed text-ink-3">
                  This backend exposes version timestamps only; restore becomes available
                  with the versions API.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Dialog>

      <Dialog
        open={pathAction !== null}
        onOpenChange={(open) => {
          if (!open) setPathAction(null);
        }}
        title={pathAction?.kind === "import" ? "Import artifact" : "Export artifact"}
        description={
          pathAction?.kind === "import"
            ? "Enter the path of a zip archive containing an index.html file."
            : "Enter the destination path for the zip archive."
        }
      >
        <form className="flex flex-col gap-3" onSubmit={submitPath}>
          <Field
            label={pathAction?.kind === "import" ? "Archive path" : "Destination path"}
            htmlFor="artifact-path"
            error={pathError}
          >
            <Input
              id="artifact-path"
              value={pathDraft}
              className="font-mono text-[11.5px]"
              placeholder={
                pathAction?.kind === "import"
                  ? "/home/user/Downloads/artifact.zip"
                  : "/home/user/Downloads/artifact.zip"
              }
              autoComplete="off"
              autoFocus
              onChange={(event) => setPathDraft(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter" && (isComposingEvent(event) || composing.current)) {
                  event.preventDefault();
                }
              }}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPathAction(null)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={pathPending}>
              {pathAction?.kind === "import" ? "Import" : "Export"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
