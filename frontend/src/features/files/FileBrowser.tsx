/**
 * Workspace file browser + text editor.
 *
 * Reference mapping: ``frontend/src/features/files/FileBrowser.tsx``.
 * Uses the existing CDS atoms/hooks through ``@/cds``:
 *   Button, Dialog, Field, Input, Badge, EmptyState, ErrorState, Skeleton
 * and the panel chrome through ``@/features/panels/Chrome``.  The files in
 * ``frontend/check/stubs`` exist only so this reference copy can be typechecked
 * outside the AutoAgent tree; delete them after integration.
 *
 * Accessibility: the tree is a single roving tab stop with
 * ``aria-activedescendant``; rows expose ``treeitem``/``aria-level`` and
 * ``aria-expanded``.  Virtualisation keeps the active row rendered.
 */

import {
  Binary,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
} from "@/cds";
import { InlineError } from "@/features/panels/Chrome";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import {
  FileApiError,
  type FileClient,
  type FileTextView,
} from "./fileClient";
import {
  joinPath,
  parentPath,
  useFileTree,
  type VisibleRow,
} from "./useFileTree";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const SAFE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
]);

export interface FileBrowserProps {
  client: FileClient;
  root?: string;
  rootLabel?: string;
  initialPath?: string;
  className?: string;
}

type DialogMode = "file" | "folder" | "rename";

interface NameDialogState {
  mode: DialogMode;
  value: string;
  parent: string;
  target?: string;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index] ?? "KB"}`;
}

function formatTime(ms: number): string {
  if (!ms) return "unknown";
  return new Date(ms).toLocaleString();
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function rowId(path: string): string {
  return `file-row-${encodeURIComponent(path)}`;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "download";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isSafeImage(mime: string): boolean {
  return SAFE_IMAGE_MIMES.has(mime.toLowerCase());
}

function entryIcon(row: VisibleRow) {
  if (row.kind === "directory") {
    return row.expanded ? (
      <FolderOpen size={13} strokeWidth={1.9} className="flex-none text-accent" aria-hidden />
    ) : (
      <Folder size={13} strokeWidth={1.9} className="flex-none text-ink-3" aria-hidden />
    );
  }
  if (row.kind === "symlink") {
    return <Link2 size={13} strokeWidth={1.9} className="flex-none text-warn" aria-hidden />;
  }
  return <FileIcon size={13} strokeWidth={1.9} className="flex-none text-ink-3" aria-hidden />;
}

export function FileBrowser({
  client,
  root = "workspace",
  rootLabel,
  initialPath,
  className,
}: FileBrowserProps) {
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [doc, setDoc] = useState<FileTextView | null>(null);
  const [draft, setDraft] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [guard, setGuard] = useState<{ next: string | null } | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    name: string;
    loaded: number;
    total: number;
  } | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 420 });

  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const {
    nodes,
    rows,
    selected,
    rootLoading,
    rootError,
    select,
    expand,
    collapse,
    toggle,
    refresh,
    loadMore,
    reveal,
  } = useFileTree({ client, root, hidden: showHidden });

  const selectedNode = selected ? nodes.get(selected) : undefined;
  const selectedEntry = selectedNode?.entry;
  const selectedPath = selectedEntry?.path;
  const selectedKind = selectedEntry?.kind;
  const activeDir = selectedKind === "directory" ? (selectedPath ?? "") : parentPath(selectedPath ?? "");
  const dirty = doc !== null && !doc.binary && draft !== (doc.text ?? "");

  // -- initial deep link ---------------------------------------------------

  useEffect(() => {
    if (initialized.current || !initialPath) return;
    initialized.current = true;
    void reveal(initialPath);
  }, [initialPath, reveal]);

  // -- document load -------------------------------------------------------

  useEffect(() => {
    if (!selectedPath || selectedKind !== "file") {
      setDoc(null);
      setDraft("");
      setDocError(null);
      setDocLoading(false);
      return;
    }
    const controller = new AbortController();
    setDocLoading(true);
    setDocError(null);
    client
      .readText({ root, path: selectedPath }, controller.signal)
      .then((document) => {
        setDoc(document);
        setDraft(document.text ?? "");
      })
      .catch((error: unknown) => {
        if (isAbort(error)) return;
        setDoc(null);
        setDraft("");
        setDocError(errorMessage(error, "The file could not be read."));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDocLoading(false);
      });
    return () => controller.abort();
  }, [client, reloadNonce, root, selectedKind, selectedPath]);

  // -- dirty guard on unload ----------------------------------------------

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // -- image preview -------------------------------------------------------

  useEffect(() => {
    if (!doc || !doc.binary || !isSafeImage(doc.mime)) {
      setImageUrl(null);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    client
      .thumbnail({ root, path: doc.path }, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (!isAbort(error)) setImageUrl(null);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, doc, root]);

  // -- viewport measurement ------------------------------------------------

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const update = (): void => {
      setViewport({ top: element.scrollTop, height: element.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);

  // -- actions -------------------------------------------------------------

  const save = useCallback(async (): Promise<boolean> => {
    if (!doc || doc.binary || doc.truncated) return true;
    setSaving(true);
    setDocError(null);
    try {
      const result = await client.writeText({
        root,
        path: doc.path,
        text: draft,
        expectedSha256: doc.sha256 ?? undefined,
      });
      setDoc({
        ...doc,
        text: draft,
        size: result.size,
        sha256: result.sha256,
        mtimeMs: result.mtimeMs,
        lineCount: countLines(draft),
        truncated: false,
      });
      return true;
    } catch (error) {
      if (error instanceof FileApiError && error.code === "HASH_MISMATCH") {
        setDocError("This file changed on disk. Reload it before saving.");
      } else {
        setDocError(errorMessage(error, "The file could not be saved."));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [client, doc, draft, root]);

  const requestSelect = useCallback(
    (path: string | null): void => {
      if (dirty && path !== selectedPath) {
        setGuard({ next: path });
        return;
      }
      if (path === null) {
        select(null);
        return;
      }
      void reveal(path);
    },
    [dirty, reveal, select, selectedPath],
  );

  const handleGuard = useCallback(
    async (action: "save" | "discard" | "cancel"): Promise<void> => {
      if (!guard) return;
      if (action === "cancel") {
        setGuard(null);
        return;
      }
      if (action === "save") {
        const ok = await save();
        if (!ok) return;
      }
      const next = guard.next;
      setGuard(null);
      if (next === null) select(null);
      else await reveal(next);
    },
    [guard, reveal, save, select],
  );

  const openCreate = useCallback(
    (mode: "file" | "folder"): void => {
      setNameDialog({ mode, value: "", parent: activeDir });
    },
    [activeDir],
  );

  const openRename = useCallback((row: VisibleRow): void => {
    setNameDialog({
      mode: "rename",
      value: row.name,
      parent: parentPath(row.path),
      target: row.path,
    });
  }, []);

  const submitName = useCallback(async (): Promise<void> => {
    const current = nameDialog;
    if (!current) return;
    const name = current.value.trim();
    if (
      !name ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\")
    ) {
      setActionError("Enter a single file or folder name without slashes.");
      return;
    }
    const target = joinPath(current.parent, name);
    setNameSaving(true);
    setActionError(null);
    try {
      if (current.mode === "rename") {
        if (!current.target) return;
        if (target === current.target) {
          setNameDialog(null);
          return;
        }
        await client.rename({ root, fromPath: current.target, toPath: target });
      } else if (current.mode === "folder") {
        await client.mkdir({ root, path: target });
      } else {
        await client.createFile({ root, path: target });
      }
      setNameDialog(null);
      await refresh(current.parent);
      await reveal(target);
    } catch (error) {
      setActionError(errorMessage(error, "The change could not be applied."));
    } finally {
      setNameSaving(false);
    }
  }, [client, nameDialog, refresh, reveal, root]);

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await client.deleteEntry({ root, path: deleteTarget });
      if (
        selectedPath === deleteTarget ||
        (selectedPath ?? "").startsWith(`${deleteTarget}/`)
      ) {
        select(null);
        setDoc(null);
        setDraft("");
      }
      await refresh(parentPath(deleteTarget));
      setDeleteTarget(null);
    } catch (error) {
      setActionError(errorMessage(error, "The entry could not be deleted."));
    } finally {
      setDeleteBusy(false);
    }
  }, [client, deleteTarget, refresh, root, select, selectedPath]);

  const downloadSelected = useCallback(async (): Promise<void> => {
    if (!selectedEntry || selectedEntry.kind !== "file") return;
    try {
      const blob = await client.download({ root, path: selectedEntry.path });
      triggerDownload(blob, selectedEntry.name);
    } catch (error) {
      setActionError(errorMessage(error, "The file could not be downloaded."));
    }
  }, [client, root, selectedEntry]);

  const revealSelected = useCallback(async (): Promise<void> => {
    if (!selectedEntry) return;
    try {
      await client.reveal({ root, path: selectedEntry.path });
    } catch (error) {
      setActionError(errorMessage(error, "The file manager could not be opened."));
    }
  }, [client, root, selectedEntry]);

  const onFilesPicked = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = "";
      if (!files.length) return;
      setActionError(null);
      for (const file of files) {
        const path = joinPath(activeDir, file.name);
        setUploadProgress({ name: file.name, loaded: 0, total: file.size });
        try {
          await client.upload({
            root,
            path,
            file,
            onProgress: (loaded, total) => setUploadProgress({ name: file.name, loaded, total }),
          });
        } catch (error) {
          setActionError(errorMessage(error, `Could not upload ${file.name}.`));
        }
      }
      setUploadProgress(null);
      await refresh(activeDir);
    },
    [activeDir, client, refresh, root],
  );

  // -- keyboard ------------------------------------------------------------

  const visibleRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows
      .filter((row) => row.name.toLowerCase().includes(term))
      .map((row) => ({ ...row, depth: 0 }));
  }, [rows, search]);

  const selectedIndex = useMemo(
    () => visibleRows.findIndex((row) => row.path === selected),
    [selected, visibleRows],
  );

  useEffect(() => {
    const element = listRef.current;
    if (!element || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [selectedIndex]);

  const focusRow = useCallback(
    (index: number): void => {
      if (!visibleRows.length) return;
      const clamped = Math.max(0, Math.min(visibleRows.length - 1, index));
      const row = visibleRows[clamped];
      if (row) requestSelect(row.path);
    },
    [requestSelect, visibleRows],
  );

  const onTreeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const index = selectedIndex;
      const current = index >= 0 ? visibleRows[index] : undefined;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRow(index < 0 ? 0 : index + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRow(index < 0 ? 0 : index - 1);
          break;
        case "Home":
          event.preventDefault();
          focusRow(0);
          break;
        case "End":
          event.preventDefault();
          focusRow(visibleRows.length - 1);
          break;
        case "ArrowRight":
          event.preventDefault();
          if (!current) {
            focusRow(0);
          } else if (current.kind === "directory") {
            if (!current.expanded) void expand(current.path);
            else focusRow(index + 1);
          }
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (!current) break;
          if (current.kind === "directory" && current.expanded) {
            collapse(current.path);
          } else {
            const path = parentPath(current.path);
            if (path !== current.path) requestSelect(path);
          }
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          if (!current) focusRow(0);
          else if (current.kind === "directory") void toggle(current.path);
          else requestSelect(current.path);
          break;
        case "F2":
          event.preventDefault();
          if (current) openRename(current);
          break;
        case "Delete":
          event.preventDefault();
          if (current) setDeleteTarget(current.path);
          break;
        default:
          break;
      }
    },
    [
      collapse,
      expand,
      focusRow,
      openRename,
      requestSelect,
      selectedIndex,
      toggle,
      visibleRows,
    ],
  );

  // -- virtual window ------------------------------------------------------

  const windowBounds = useMemo(() => {
    let start = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
    let end = Math.min(
      visibleRows.length,
      Math.ceil((viewport.top + Math.max(viewport.height, ROW_HEIGHT)) / ROW_HEIGHT) +
        OVERSCAN,
    );
    if (selectedIndex >= 0 && selectedIndex < start) start = selectedIndex;
    if (selectedIndex >= 0 && selectedIndex >= end) {
      end = Math.min(visibleRows.length, selectedIndex + 1);
    }
    return { start, end };
  }, [selectedIndex, viewport, visibleRows.length]);

  const crumbs = useMemo(() => {
    const parts = activeDir ? activeDir.split("/") : [];
    const items = [{ label: rootLabel ?? root, path: "" }];
    let accumulated = "";
    for (const part of parts) {
      accumulated = joinPath(accumulated, part);
      items.push({ label: part, path: accumulated });
    }
    return items;
  }, [activeDir, root, rootLabel]);

  const guardName = selectedPath ? baseName(selectedPath) : "This file";
  const dialogTitle =
    nameDialog?.mode === "rename"
      ? "Rename entry"
      : nameDialog?.mode === "folder"
        ? "New folder"
        : "New file";

  return (
    <div className={cx("flex h-full min-h-0 flex-col", className)}>
      <div className="flex min-h-11 flex-none items-center gap-2 border-b border-hairline px-3 py-2">
        <FolderOpen size={14} strokeWidth={2} className="text-ink-3" aria-hidden />
        <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">
          Files
        </h2>
        <span className="truncate font-mono text-[11px] text-ink-3">{rootLabel ?? root}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New file"
            title="New file"
            onClick={() => openCreate("file")}
          >
            <FilePlus2 size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New folder"
            title="New folder"
            onClick={() => openCreate("folder")}
          >
            <FolderPlus size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Upload files"
            title="Upload files"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh files"
            title="Refresh files"
            loading={rootLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={13} strokeWidth={2} />
          </Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void onFilesPicked(event)}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {actionError ? (
          <div className="px-3 pt-2">
            <InlineError message={actionError} onDismiss={() => setActionError(null)} />
          </div>
        ) : null}
        {uploadProgress ? (
          <div className="px-3 pt-2" aria-live="polite">
            <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-2.5 py-1.5 text-[11px] text-ink-2">
              <Upload size={12} strokeWidth={2} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{uploadProgress.name}</span>
              <span className="t-num">
                {uploadProgress.total > 0
                  ? `${Math.round((uploadProgress.loaded / uploadProgress.total) * 100)}%`
                  : "…"}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex min-h-[160px] max-h-[45%] flex-none flex-col border-b border-hairline">
          <div className="flex flex-none items-center gap-1.5 px-3 py-2">
            <Search size={12} strokeWidth={2} className="flex-none text-ink-3" aria-hidden />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter loaded files"
              aria-label="Filter loaded files"
              className="h-7 rounded-md text-[12px]"
              spellCheck={false}
            />
            {search ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear filter"
                onClick={() => setSearch("")}
              >
                <X size={12} strokeWidth={2} />
              </Button>
            ) : null}
          </div>

          <nav aria-label="Breadcrumb" className="flex flex-none flex-wrap items-center gap-0.5 px-3 pb-1.5">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path || "root"} className="flex items-center gap-0.5">
                {index > 0 ? (
                  <ChevronRight size={10} strokeWidth={2} className="text-ink-3" aria-hidden />
                ) : null}
                <button
                  type="button"
                  className="max-w-[140px] truncate rounded px-1 py-0.5 font-mono text-[11px] text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                  onClick={() => requestSelect(crumb.path)}
                  title={crumb.path || root}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>

          {rootError ? (
            <ErrorState
              title="Files unavailable"
              message={rootError}
              retry={() => void refresh()}
              retrying={rootLoading}
              className="py-6"
            />
          ) : rootLoading && rows.length === 0 ? (
            <div className="flex flex-col gap-1.5 px-3 py-2">
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
              <Skeleton className="h-6" />
            </div>
          ) : (
            <div
              ref={listRef}
              role="tree"
              aria-label="Workspace files"
              aria-activedescendant={
                selected && selected !== "" ? rowId(selected) : undefined
              }
              tabIndex={0}
              onKeyDown={onTreeKeyDown}
              className="scroll-area min-h-0 flex-1 overflow-auto px-1.5 pb-2 focus-visible:outline-none focus-visible:shadow-focus"
            >
              {visibleRows.length === 0 ? (
                <EmptyState
                  title={search ? "No matches" : "This folder is empty"}
                  description={
                    search
                      ? "Only entries already loaded in the tree can be filtered."
                      : "Create a file or folder, or upload something."
                  }
                  className="py-6"
                />
              ) : (
                <div
                  style={{
                    height: visibleRows.length * ROW_HEIGHT,
                    position: "relative",
                  }}
                >
                  {visibleRows
                    .slice(windowBounds.start, windowBounds.end)
                    .map((row, offset) => {
                      const index = windowBounds.start + offset;
                      const active = row.path === selected;
                      return (
                        <div
                          key={row.path}
                          id={rowId(row.path)}
                          role="treeitem"
                          aria-level={row.depth + 1}
                          aria-selected={active}
                          aria-expanded={
                            row.kind === "directory" ? row.expanded : undefined
                          }
                          style={{
                            position: "absolute",
                            top: index * ROW_HEIGHT,
                            left: 0,
                            right: 0,
                            height: ROW_HEIGHT,
                            paddingLeft: 4 + row.depth * 14,
                          }}
                          className={cx(
                            "flex cursor-default select-none items-center gap-1.5 rounded-md pr-2 text-[12px]",
                            active
                              ? "bg-selected text-ink"
                              : "text-ink-2 hover:bg-hover hover:text-ink",
                          )}
                          onClick={() => {
                            listRef.current?.focus();
                            requestSelect(row.path);
                          }}
                          onDoubleClick={() => {
                            if (row.kind === "directory") void toggle(row.path);
                          }}
                        >
                          {row.kind === "directory" ? (
                            <button
                              type="button"
                              tabIndex={-1}
                              aria-label={row.expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
                              className="flex h-4 w-4 flex-none items-center justify-center rounded text-ink-3 hover:text-ink"
                              onClick={(event) => {
                                event.stopPropagation();
                                void toggle(row.path);
                              }}
                            >
                              {row.expanded ? (
                                <ChevronDown size={11} strokeWidth={2} />
                              ) : (
                                <ChevronRight size={11} strokeWidth={2} />
                              )}
                            </button>
                          ) : (
                            <span className="w-4 flex-none" aria-hidden />
                          )}
                          {entryIcon(row)}
                          <span className="min-w-0 flex-1 truncate" title={row.path}>
                            {row.name}
                          </span>
                          {row.loading ? (
                            <span className="text-[10px] text-ink-3" aria-label="Loading">
                              …
                            </span>
                          ) : null}
                          {row.hidden ? (
                            <EyeOff size={10} strokeWidth={2} className="flex-none text-ink-3" aria-hidden />
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {selectedNode &&
          selectedEntry?.kind === "directory" &&
          selectedNode.nextCursor ? (
            <div className="flex flex-none justify-center px-3 py-1.5">
              <Button
                size="xs"
                variant="ghost"
                loading={selectedNode.loading}
                onClick={() => void loadMore(selectedEntry.path)}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>

        <section className="flex min-h-0 flex-1 flex-col" aria-label="File editor">
          <div className="flex flex-none items-center gap-1.5 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-[12px] font-medium text-ink">
                {selectedEntry ? selectedEntry.name : "No file selected"}
              </span>
              {dirty ? <Badge tone="warn">unsaved</Badge> : null}
              {doc?.binary ? <Badge tone="neutral">binary</Badge> : null}
              {doc?.truncated ? <Badge tone="warn">truncated</Badge> : null}
            </div>
            {selectedEntry ? (
              <div className="flex items-center gap-0.5">
                {selectedEntry.kind === "file" && !doc?.binary ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Save file"
                      title="Save file"
                      loading={saving}
                      disabled={!dirty || doc?.truncated === true}
                      onClick={() => void save()}
                    >
                      <Save size={13} strokeWidth={2} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Revert changes"
                      title="Revert changes"
                      disabled={!dirty}
                      onClick={() => setDraft(doc?.text ?? "")}
                    >
                      <RotateCcw size={13} strokeWidth={2} />
                    </Button>
                  </>
                ) : null}
                {selectedEntry.kind === "file" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Download file"
                    title="Download file"
                    onClick={() => void downloadSelected()}
                  >
                    <Download size={13} strokeWidth={2} />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Reveal in file manager"
                  title="Reveal in file manager"
                  onClick={() => void revealSelected()}
                >
                  <FolderOpen size={13} strokeWidth={2} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Rename entry"
                  title="Rename entry"
                  onClick={() => {
                    const row = visibleRows.find((item) => item.path === selectedPath);
                    if (row) openRename(row);
                  }}
                >
                  <Pencil size={13} strokeWidth={2} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete entry"
                  title="Delete entry"
                  onClick={() => setDeleteTarget(selectedEntry.path)}
                >
                  <Trash2 size={13} strokeWidth={2} />
                </Button>
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 px-3 pb-3">
            {!selectedEntry ? (
              <EmptyState
                title="Select a file"
                description="Choose a file in the tree to preview or edit it."
                icon={<FileIcon size={18} strokeWidth={1.8} />}
                className="h-full py-8"
              />
            ) : selectedEntry.kind === "directory" ? (
              <EmptyState
                title="Folder selected"
                description="Expand the folder to browse its contents, or create a file inside it."
                icon={<Folder size={18} strokeWidth={1.8} />}
                className="h-full py-8"
              />
            ) : selectedEntry.kind === "symlink" ? (
              <EmptyState
                title="Symbolic link"
                description="Links are shown but never followed by the file service. Open the target directly from an approved root."
                icon={<Link2 size={18} strokeWidth={1.8} />}
                className="h-full py-8"
              />
            ) : docLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-6" />
                <Skeleton className="h-40" />
              </div>
            ) : docError ? (
              <div className="flex flex-col gap-2">
                <InlineError message={docError} onDismiss={() => setDocError(null)} />
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  onClick={() => setReloadNonce((value) => value + 1)}
                >
                  <RotateCcw size={12} strokeWidth={2} />
                  Reload
                </Button>
              </div>
            ) : doc?.binary ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                {imageUrl ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-card bg-panel-2 p-2">
                    <img
                      src={imageUrl}
                      alt={`Preview of ${doc.path}`}
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>
                ) : (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-card bg-panel-2 p-4 text-center">
                    <Binary size={20} strokeWidth={1.8} className="text-ink-3" aria-hidden />
                    <p className="text-[12px] text-ink-2">Binary file · {doc.mime}</p>
                    <Button size="sm" variant="secondary" onClick={() => void downloadSelected()}>
                      <Download size={12} strokeWidth={2} />
                      Download
                    </Button>
                  </div>
                )}
                <p className="flex-none font-mono text-[10.5px] text-ink-3">
                  {formatBytes(doc.size)} · {doc.mime}
                </p>
              </div>
            ) : doc ? (
              <div className="flex h-full min-h-0 flex-col gap-1.5">
                {doc.truncated ? (
                  <div className="flex-none rounded-lg bg-warn/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-warn">
                    Preview limited to {doc.lineCount} lines. Editing is disabled so a
                    truncated buffer can never be saved over the file.
                  </div>
                ) : null}
                {docError ? (
                  <InlineError message={docError} onDismiss={() => setDocError(null)} />
                ) : null}
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      if (dirty && !doc.truncated) void save();
                    }
                  }}
                  readOnly={doc.truncated}
                  spellCheck={false}
                  aria-label={`Edit ${doc.path}`}
                  className="scroll-area min-h-0 flex-1 resize-none rounded-card border border-hairline bg-surface p-3 font-mono text-[12px] leading-5 text-ink outline-none focus-visible:shadow-focus"
                />
                <div className="flex flex-none items-center gap-3 font-mono text-[10.5px] text-ink-3">
                  <span>{countLines(draft)} lines</span>
                  <span>{formatBytes(new Blob([draft]).size)}</span>
                  <span>{doc.encoding ?? "utf-8"}</span>
                  <span className="ml-auto">{formatTime(doc.mtimeMs)}</span>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        title={dialogTitle}
        description={
          nameDialog?.mode === "rename"
            ? "Rename within the same folder."
            : "Created inside the selected folder."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setNameDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={nameSaving}
              disabled={!nameDialog?.value.trim()}
              onClick={() => void submitName()}
            >
              {nameDialog?.mode === "rename" ? "Rename" : "Create"}
            </Button>
          </>
        }
      >
        <Field label="Name" htmlFor="file-name-input">
          <Input
            id="file-name-input"
            autoFocus
            value={nameDialog?.value ?? ""}
            spellCheck={false}
            onChange={(event) =>
              setNameDialog((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitName();
              }
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={guard !== null}
        onOpenChange={(open) => {
          if (!open) setGuard(null);
        }}
        title="Unsaved changes"
        description={`${guardName} has changes that have not been saved.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => void handleGuard("cancel")}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => void handleGuard("discard")}>
              Discard
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void handleGuard("save")}
            >
              Save and continue
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Save before opening another file? Choosing Discard loses the current edits.
        </p>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete entry"
        description={deleteTarget ? baseName(deleteTarget) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteBusy} onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Only empty folders can be deleted. Files are removed immediately and are not
          moved to the operating system trash.
        </p>
        {dirty && deleteTarget === selectedPath ? (
          <p className="mt-2 text-[12px] text-warn">
            The selected file has unsaved changes; deleting it will discard them.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
