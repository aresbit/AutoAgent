import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileDiff,
  FolderGit2,
  GitBranch,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  api,
  type FileDiffView,
  type WorkspaceStatusView,
} from "@/api/client";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  SectionLabel,
  Skeleton,
  useRovingFocus,
} from "@/cds";
import { InlineError, PanelHeader, PanelScroll } from "@/features/panels/Chrome";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import { truncate } from "@/lib/format";
import {
  diffCounts,
  diffLineKind,
  fileStatusLabel,
  fileStatusTone,
} from "./logic";

export function WorkspacePanel({
  initialStatus,
}: {
  initialStatus?: WorkspaceStatusView;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["workspace"] as const;
  const statusQuery = useQuery({
    queryKey,
    queryFn: () => api.workspaceStatus(),
    initialData: initialStatus,
  });
  const status = statusQuery.data;
  const workDir = status?.workDir;
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const roving = useRovingFocus(status?.files.length ?? 0, "vertical");

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);

  useEffect(() => {
    if (!status || status.files.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (selected && status.files.some((file) => file.path === selected)) return;
    setSelected(status.files[0]?.path ?? null);
  }, [selected, status]);

  const diffQuery = useQuery({
    queryKey: ["workspace-diff", workDir, selected],
    queryFn: () => api.workspaceDiff(selected ?? "", workDir),
    enabled: Boolean(selected && workDir),
  });

  const switchBranch = useMutation({
    mutationFn: (branch: string) => api.switchBranch(branch, workDir),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onError: (error) =>
      setActionError(errorMessage(error, "The branch could not be switched.")),
  });

  const init = useMutation({
    mutationFn: () => api.initWorkspace(workDir),
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
    onError: (error) =>
      setActionError(errorMessage(error, "The repository could not be initialized.")),
  });

  if (statusQuery.isError) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader icon={<FolderGit2 size={14} strokeWidth={2} />} title="Workspace" />
        <ErrorState
          title="Workspace unavailable"
          message={errorMessage(statusQuery.error, "The workspace status could not be read.")}
          retry={() => void statusQuery.refetch()}
          retrying={statusQuery.isFetching}
        />
      </div>
    );
  }

  if (!status || statusQuery.isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader icon={<FolderGit2 size={14} strokeWidth={2} />} title="Workspace" />
        <div className="flex flex-col gap-2 p-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={<FolderGit2 size={14} strokeWidth={2} />}
        title="Workspace"
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh workspace"
            onClick={() => void statusQuery.refetch()}
            loading={statusQuery.isFetching}
          >
            <RefreshCw size={13} strokeWidth={2} />
          </Button>
        }
      />
      <PanelScroll>
        <div className="flex flex-col gap-3">
          {actionError ? (
            <InlineError message={actionError} onDismiss={() => setActionError(null)} />
          ) : null}

          <div className="flex flex-col gap-2 rounded-card bg-surface p-3">
            <p
              className="truncate font-mono text-[11px] text-ink-2"
              title={status.workDir}
            >
              {status.workDir}
            </p>
            <div className="flex items-center gap-4">
              <Stat label="changed" value={status.changedFiles} />
              <Stat label="added" value={status.additions} tone="ok" prefix="+" />
              <Stat label="removed" value={status.deletions} tone="bad" prefix="-" />
              <Badge tone={status.isGitRepo ? "ok" : "warn"} className="ml-auto">
                {status.isGitRepo ? "git" : "no repository"}
              </Badge>
            </div>
            {!status.isGitRepo ? (
              <Button
                size="xs"
                variant="secondary"
                className="self-start"
                loading={init.isPending}
                onClick={() => init.mutate()}
              >
                Initialize repository
              </Button>
            ) : null}
          </div>

          {status.warnings.length ? (
            <div className="flex flex-col gap-1.5 rounded-lg bg-warn/10 px-2.5 py-2">
              {status.warnings.map((warning) => (
                <p
                  key={warning}
                  className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-warn"
                >
                  <TriangleAlert size={12} strokeWidth={2} className="mt-0.5 flex-none" aria-hidden />
                  {warning}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <SectionLabel>Branches</SectionLabel>
            <ul className="flex flex-col gap-0.5">
              {status.branches.map((branch) => {
                const current = branch.current === true;
                return (
                  <li
                    key={`${branch.isRemote ? "r:" : "l:"}${branch.name}`}
                    className="flex items-center gap-2 rounded-lg px-1.5 py-1.5"
                  >
                    <GitBranch
                      size={12}
                      strokeWidth={2}
                      className={current ? "text-accent" : "text-ink-3"}
                      aria-hidden
                    />
                    <span
                      className={cx(
                        "min-w-0 flex-1 truncate font-mono text-[11.5px]",
                        current ? "font-medium text-ink" : "text-ink-2",
                      )}
                      title={branch.name}
                    >
                      {branch.name}
                    </span>
                    {branch.isRemote ? <Badge tone="neutral">remote</Badge> : null}
                    {current ? (
                      <Badge tone="accent">current</Badge>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={branch.isRemote || switchBranch.isPending}
                        title={branch.isRemote ? "Remote branches cannot be checked out directly." : undefined}
                        onClick={() => switchBranch.mutate(branch.name)}
                      >
                        Switch
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SectionLabel>Changed files</SectionLabel>
              <span className="t-num text-[10.5px] text-ink-3">
                {status.files.length}
              </span>
            </div>
            {status.files.length === 0 ? (
              <EmptyState
                className="py-8"
                icon={<FileDiff size={18} strokeWidth={1.8} />}
                title="Working tree is clean"
                description="No added, modified or deleted files in this workspace."
              />
            ) : (
              <ul className="flex flex-col gap-0.5" role="list">
                {status.files.map((file, index) => {
                  const active = selected === file.path;
                  return (
                    <li key={file.path}>
                      <button
                        type="button"
                        {...roving.itemProps(index)}
                        aria-pressed={active}
                        onClick={() => setSelected(file.path)}
                        className={cx(
                          "flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus",
                          active ? "bg-selected" : "hover:bg-hover",
                        )}
                      >
                        <Badge tone={fileStatusTone(file.status)}>
                          {fileStatusLabel(file.status)}
                        </Badge>
                        <span
                          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-2"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span className="t-num text-[10.5px] text-ok">+{file.additions}</span>
                        <span className="t-num text-[10.5px] text-bad">-{file.deletions}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SectionLabel>Diff</SectionLabel>
              {selected ? (
                <span
                  className="max-w-[60%] truncate font-mono text-[10.5px] text-ink-3"
                  title={selected}
                >
                  {truncate(selected, 46)}
                </span>
              ) : null}
            </div>
            {!selected ? (
              <EmptyState
                className="py-8"
                icon={<FileDiff size={18} strokeWidth={1.8} />}
                title="Select a file"
                description="Choose a changed file to read its patch."
              />
            ) : diffQuery.isLoading ? (
              <Skeleton className="h-40" />
            ) : diffQuery.isError ? (
              <ErrorState
                title="Diff unavailable"
                message={errorMessage(diffQuery.error, "The patch could not be read.")}
                retry={() => void diffQuery.refetch()}
                retrying={diffQuery.isFetching}
              />
            ) : diffQuery.data ? (
              <DiffViewer diff={diffQuery.data} />
            ) : null}
          </div>
        </div>
      </PanelScroll>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  prefix,
}: {
  label: string;
  value: number;
  tone?: "ok" | "bad";
  prefix?: string;
}) {
  return (
    <span className="flex flex-col">
      <span
        className={cx(
          "t-num text-[15px] font-semibold leading-tight",
          tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-ink",
        )}
      >
        {prefix}
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-[0.06em] text-ink-3">{label}</span>
    </span>
  );
}

function DiffViewer({ diff }: { diff: FileDiffView }) {
  const counts = diffCounts(diff.patch);
  const lines = diff.patch.split("\n");
  return (
    <div className="overflow-hidden rounded-card bg-code shadow-panel">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span className="t-num text-[10.5px] text-code-muted">+{counts.additions}</span>
        <span className="t-num text-[10.5px] text-code-muted">-{counts.deletions}</span>
        <span className="ml-auto text-[10.5px] text-code-muted">read only</span>
      </div>
      <pre className="t-code scroll-area max-h-[420px] overflow-auto pb-2 text-[11px] leading-[1.55]">
        {lines.map((line, index) => {
          const kind = diffLineKind(line);
          return (
            <span
              key={index}
              className={cx(
                "block whitespace-pre px-2.5",
                kind === "add"
                  ? "bg-ok/15 text-code-ink"
                  : kind === "remove"
                    ? "bg-bad/15 text-code-ink"
                    : kind === "hunk"
                      ? "text-info"
                      : kind === "meta"
                        ? "text-code-muted"
                        : "text-code-ink",
              )}
            >
              {line || " "}
            </span>
          );
        })}
      </pre>
    </div>
  );
}
