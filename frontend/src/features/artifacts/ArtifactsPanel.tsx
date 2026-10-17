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
import { api, type ArtifactView } from "@/api/client";
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
import { displayTitle, newestVersion, sortArtifacts, versionLabel } from "./logic";

type PathAction = { kind: "export"; artifact: ArtifactView } | { kind: "import" };

export function ArtifactsPanel({
  initialArtifacts = [],
}: {
  initialArtifacts?: ArtifactView[];
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
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pathAction, setPathAction] = useState<PathAction | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const composing = useRef(false);

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
    enabled: Boolean(preview),
    staleTime: 30_000,
  });

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

  const openPreview = (artifact: ArtifactView) => {
    setPreview(artifact);
    setMode("preview");
    touch.mutate(artifact.id);
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
                      <span className="t-num">{artifact.versions.length}</span>
                      {artifact.versions.length === 1 ? " version" : " versions"}
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
              and rendered in an empty-sandbox frame.
            </p>
          </div>
        </div>
      </PanelScroll>

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview ? displayTitle(preview) : "Artifact"}
        description={preview?.description || undefined}
        width={720}
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
            <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
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

          {contentQuery.isLoading ? (
            <Skeleton className="h-[min(52vh,460px)]" />
          ) : contentQuery.isError ? (
            <ErrorState
              title="Preview unavailable"
              message={errorMessage(contentQuery.error, "The artifact content could not be read.")}
              retry={() => void contentQuery.refetch()}
              retrying={contentQuery.isFetching}
            />
          ) : mode === "preview" ? (
            <iframe
              title={`${preview ? displayTitle(preview) : "Artifact"} preview`}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={contentQuery.data ?? ""}
              className="h-[min(52vh,460px)] w-full rounded-card bg-panel shadow-panel"
            />
          ) : (
            <pre className="t-code scroll-area h-[min(52vh,460px)] overflow-auto rounded-card bg-code p-3 text-[11px] leading-relaxed text-code-ink">
              {contentQuery.data ?? ""}
            </pre>
          )}

          {preview && preview.versions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SectionLabel>Versions</SectionLabel>
              <ul className="flex flex-wrap gap-1">
                {[...preview.versions]
                  .sort((a, b) => b - a)
                  .map((timestamp) => (
                    <li key={timestamp}>
                      <Badge
                        tone={timestamp === newestVersion(preview) ? "accent" : "neutral"}
                      >
                        <span className="t-num">{versionLabel(timestamp)}</span>
                      </Badge>
                    </li>
                  ))}
              </ul>
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
