/**
 * Tree state for the safe-file browser.
 *
 * Reference mapping: ``frontend/src/features/files/useFileTree.ts``.
 * The hook is intentionally free of React Query so it can be unit-tested with
 * a fake ``FileClient``.  Every network call is abortable; expansion triggers
 * a lazy listing and pagination appends through ``nextCursor``.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/errorMessage";
import type { EntryKind, FileClient, FileEntryView } from "./fileClient";

const ROOT_PATH = "";
const MAX_DEPTH = 64;

export interface TreeNode {
  entry: FileEntryView;
  /** ``null`` until the directory has been listed at least once. */
  children: string[] | null;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  nextCursor: string | null;
  total: number;
}

export interface VisibleRow {
  path: string;
  name: string;
  kind: EntryKind;
  depth: number;
  expanded: boolean;
  loading: boolean;
  hidden: boolean;
}

export interface UseFileTreeOptions {
  client: FileClient;
  root: string;
  hidden?: boolean;
  pageSize?: number;
}

export interface UseFileTreeResult {
  nodes: ReadonlyMap<string, TreeNode>;
  rows: VisibleRow[];
  selected: string | null;
  rootLoading: boolean;
  rootError: string | null;
  select: (path: string | null) => void;
  expand: (path: string) => Promise<void>;
  collapse: (path: string) => void;
  toggle: (path: string) => Promise<void>;
  refresh: (path?: string) => Promise<void>;
  loadMore: (path: string) => Promise<void>;
  reveal: (path: string) => Promise<void>;
}

function makeRootNode(root: string): TreeNode {
  return {
    entry: {
      name: root,
      path: ROOT_PATH,
      kind: "directory",
      size: 0,
      mtimeMs: 0,
      hidden: false,
      isSymlink: false,
    },
    children: null,
    expanded: true,
    loading: false,
    error: null,
    nextCursor: null,
    total: 0,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? ROOT_PATH : path.slice(0, index);
}

function join(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

function mergeListing(
  previous: ReadonlyMap<string, TreeNode>,
  parent: string,
  entries: readonly FileEntryView[],
  append: boolean,
  total: number,
  nextCursor: string | null,
): Map<string, TreeNode> {
  const next = new Map(previous);
  const parentNode = next.get(parent);
  if (!parentNode) return next;
  const incoming = entries.map((entry) => entry.path);
  const children = append
    ? Array.from(new Set([...(parentNode.children ?? []), ...incoming]))
    : incoming;

  for (const entry of entries) {
    const existing = next.get(entry.path);
    next.set(entry.path, {
      entry,
      children: existing?.children ?? (entry.kind === "directory" ? null : []),
      expanded: existing?.expanded ?? false,
      loading: existing?.loading ?? false,
      error: existing?.error ?? null,
      nextCursor: existing?.nextCursor ?? null,
      total: existing?.total ?? 0,
    });
  }
  next.set(parent, {
    ...parentNode,
    children,
    loading: false,
    error: null,
    nextCursor,
    total,
  });
  return next;
}

function flatten(
  nodes: ReadonlyMap<string, TreeNode>,
  parent: string,
  hidden: boolean,
  depth = 0,
): VisibleRow[] {
  if (depth > MAX_DEPTH) return [];
  const node = nodes.get(parent);
  if (!node?.children) return [];
  const rows: VisibleRow[] = [];
  for (const path of node.children) {
    const child = nodes.get(path);
    if (!child) continue;
    if (child.entry.hidden && !hidden) continue;
    rows.push({
      path: child.entry.path,
      name: child.entry.name,
      kind: child.entry.kind,
      depth,
      expanded: child.expanded,
      loading: child.loading,
      hidden: child.entry.hidden,
    });
    if (child.entry.kind === "directory" && child.expanded) {
      rows.push(...flatten(nodes, child.entry.path, hidden, depth + 1));
    }
  }
  return rows;
}

export function useFileTree(options: UseFileTreeOptions): UseFileTreeResult {
  const { client, root, hidden = false, pageSize = 200 } = options;
  const [nodes, setNodes] = useState<ReadonlyMap<string, TreeNode>>(
    () => new Map([[ROOT_PATH, makeRootNode(root)]]),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const nodesRef = useRef<ReadonlyMap<string, TreeNode>>(nodes);
  const controllers = useRef<Map<string, AbortController>>(new Map());
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const commit = useCallback((next: ReadonlyMap<string, TreeNode>) => {
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const updateNodes = useCallback(
    (updater: (previous: ReadonlyMap<string, TreeNode>) => Map<string, TreeNode>) => {
      commit(updater(nodesRef.current));
    },
    [commit],
  );

  const patchNode = useCallback(
    (path: string, patch: (node: TreeNode) => TreeNode) => {
      updateNodes((previous) => {
        const node = previous.get(path);
        if (!node) return new Map(previous);
        const next = new Map(previous);
        next.set(path, patch(node));
        return next;
      });
    },
    [updateNodes],
  );

  const loadDirectory = useCallback(
    async (
      path: string,
      mode: { force?: boolean; append?: boolean } = {},
    ): Promise<void> => {
      const node = nodesRef.current.get(path);
      if (!node) return;
      const append = mode.append === true;
      if (!append && node.children !== null && !mode.force) return;
      if (append && node.nextCursor === null) return;

      const pending = inFlight.current.get(path);
      if (pending) {
        if (!mode.force) {
          await pending;
          return;
        }
        controllers.current.get(path)?.abort();
      }

      controllers.current.get(path)?.abort();
      const controller = new AbortController();
      controllers.current.set(path, controller);
      patchNode(path, (current) => ({ ...current, loading: true, error: null }));

      const task = (async (): Promise<void> => {
        try {
          const response = await client.list(
            {
              root,
              path,
              hidden,
              limit: pageSize,
              cursor: append ? node.nextCursor : undefined,
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          updateNodes((previous) =>
            mergeListing(
              previous,
              path,
              response.entries,
              append,
              response.total,
              response.nextCursor,
            ),
          );
        } catch (error) {
          if (isAbort(error)) return;
          patchNode(path, (current) => ({
            ...current,
            error: errorMessage(error, "The folder could not be read."),
          }));
        } finally {
          if (controllers.current.get(path) === controller) {
            controllers.current.delete(path);
            patchNode(path, (current) => ({ ...current, loading: false }));
          }
        }
      })();
      inFlight.current.set(path, task);
      try {
        await task;
      } finally {
        if (inFlight.current.get(path) === task) inFlight.current.delete(path);
      }
    },
    [client, hidden, pageSize, patchNode, root, updateNodes],
  );

  const expand = useCallback(
    async (path: string): Promise<void> => {
      const node = nodesRef.current.get(path);
      if (!node || node.entry.kind !== "directory") return;
      if (!node.expanded) {
        patchNode(path, (current) => ({ ...current, expanded: true }));
      }
      if (node.children === null) await loadDirectory(path);
    },
    [loadDirectory, patchNode],
  );

  const collapse = useCallback(
    (path: string): void => {
      const node = nodesRef.current.get(path);
      if (!node || node.entry.kind !== "directory") return;
      patchNode(path, (current) => ({ ...current, expanded: false }));
    },
    [patchNode],
  );

  const toggle = useCallback(
    async (path: string): Promise<void> => {
      const node = nodesRef.current.get(path);
      if (!node || node.entry.kind !== "directory") return;
      if (node.expanded) collapse(path);
      else await expand(path);
    },
    [collapse, expand],
  );

  const loadMore = useCallback(
    async (path: string): Promise<void> => {
      await loadDirectory(path, { append: true });
    },
    [loadDirectory],
  );

  const refresh = useCallback(
    async (path: string = ROOT_PATH): Promise<void> => {
      await loadDirectory(path, { force: true });
      if (path !== ROOT_PATH) return;
      const expanded = Array.from(nodesRef.current.values())
        .filter(
          (node) =>
            node.entry.kind === "directory" &&
            node.entry.path !== ROOT_PATH &&
            node.expanded,
        )
        .map((node) => node.entry.path);
      await Promise.all(expanded.map((item) => loadDirectory(item, { force: true })));
    },
    [loadDirectory],
  );

  const reveal = useCallback(
    async (path: string): Promise<void> => {
      if (path === ROOT_PATH) {
        await loadDirectory(ROOT_PATH, { force: nodesRef.current.get(ROOT_PATH)?.children === null });
        setSelected(ROOT_PATH);
        return;
      }
      if (nodesRef.current.get(ROOT_PATH)?.children === null) {
        await loadDirectory(ROOT_PATH);
      }
      const segments = path.split("/");
      let current = ROOT_PATH;
      for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        const node = nodesRef.current.get(current);
        if (!node || node.entry.kind !== "directory") return;
        await expand(current);
      }
      const target = nodesRef.current.get(path);
      if (target?.entry.kind === "directory") await expand(path);
      setSelected(path);
    },
    [expand, loadDirectory],
  );

  useEffect(() => {
    const reset = new Map<string, TreeNode>([[ROOT_PATH, makeRootNode(root)]]);
    commit(reset);
    setSelected(null);
    void loadDirectory(ROOT_PATH, { force: true });
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    };
  }, [commit, hidden, loadDirectory, root]);

  const rows = useMemo(
    () => flatten(nodes, ROOT_PATH, hidden),
    [hidden, nodes],
  );
  const rootNode = nodes.get(ROOT_PATH);

  return {
    nodes,
    rows,
    selected,
    rootLoading: rootNode?.loading ?? false,
    rootError: rootNode?.error ?? null,
    select: setSelected,
    expand,
    collapse,
    toggle,
    refresh,
    loadMore,
    reveal,
  };
}

export { parentPath, join as joinPath };
