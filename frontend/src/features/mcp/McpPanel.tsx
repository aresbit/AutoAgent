import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blocks,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Server,
  Trash2,
  Pencil,
  Check,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  api,
  type McpDiscoveryResult,
  type McpServerInput,
  type McpServerView,
  type McpToolInvokeResult,
  type McpTransport,
} from "@/api/client";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SectionLabel,
  Select,
  Skeleton,
  Textarea,
  isComposingEvent,
} from "@/cds";
import { InlineError, PanelHeader, PanelScroll } from "@/features/panels/Chrome";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import { truncate } from "@/lib/format";
import {
  formatPairs,
  parseArgs,
  parsePairs,
  resultText,
  toolsOf,
  transportLabel,
} from "./logic";

interface McpDraft {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  enabled: boolean;
  autoRun: boolean;
}

function emptyDraft(): McpDraft {
  return {
    name: "",
    transport: "stdio",
    command: "",
    argsText: "",
    envText: "",
    url: "",
    headersText: "",
    enabled: true,
    autoRun: false,
  };
}

function draftFrom(server: McpServerView | null): McpDraft {
  if (!server) return emptyDraft();
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? (server.transport === "stdio" ? server.target : ""),
    argsText: (server.args ?? []).join("\n"),
    envText: formatPairs(server.env ?? {}),
    url: server.url ?? (server.transport === "stdio" ? "" : server.target),
    headersText: formatPairs(server.headers ?? {}),
    enabled: server.enabled,
    autoRun: server.autoRun,
  };
}

export function McpPanel({ initialServers = [] }: { initialServers?: McpServerView[] }) {
  const queryClient = useQueryClient();
  const queryKey = ["mcp"] as const;
  const serversQuery = useQuery({
    queryKey,
    queryFn: () => api.mcpServers(),
    initialData: initialServers,
  });
  const servers = serversQuery.data;
  const [actionError, setActionError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<McpServerView | null>(null);
  const [invokeOpen, setInvokeOpen] = useState(false);
  const [invokeServer, setInvokeServer] = useState("");
  const [invokeTool, setInvokeTool] = useState("");
  const [invokeArgs, setInvokeArgs] = useState("{}");
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [result, setResult] = useState<McpToolInvokeResult | null>(null);
  const [resultTool, setResultTool] = useState("");
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const composing = useRef(false);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 6000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const toggle = useMutation({
    mutationFn: (server: McpServerView) =>
      server.enabled ? api.disableMcpServer(server.name) : api.enableMcpServer(server.name),
    onMutate: async (server) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<McpServerView[]>(queryKey);
      queryClient.setQueryData<McpServerView[]>(queryKey, (current) =>
        current?.map((item) =>
          item.id === server.id ? { ...item, enabled: !item.enabled } : item,
        ),
      );
      return { previous };
    },
    onSuccess: (next) => {
      queryClient.setQueryData<McpServerView[]>(queryKey, (current) =>
        current?.map((item) => (item.id === next.id ? next : item)),
      );
    },
    onError: (error, _server, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      setActionError(errorMessage(error, "The MCP server could not be updated."));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const save = useMutation({
    mutationFn: ({ path, input }: { path: string; input: McpServerInput }) =>
      api.upsertMcpServer(path, input),
    onSuccess: (next) => {
      queryClient.setQueryData<McpServerView[]>(queryKey, (current) => {
        if (!current) return [next];
        const index = current.findIndex(
          (item) => item.id === next.id || item.name === next.name,
        );
        if (index === -1) return [...current, next];
        return current.map((item, position) => (position === index ? next : item));
      });
      setEditorOpen(false);
      setEditing(null);
      setEditorError(null);
    },
    onError: (error) => {
      const message = errorMessage(error, "The MCP server could not be saved.");
      setEditorError(message);
      setActionError(message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (server: McpServerView) => api.deleteMcpServer(server.name),
    onSuccess: (_result, server) => {
      queryClient.setQueryData<McpServerView[]>(queryKey, (current) =>
        current?.filter((item) => item.id !== server.id) ?? [],
      );
      setDeleting(null);
    },
    onError: (error) => setActionError(errorMessage(error, "The MCP server could not be removed.")),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const discover = useMutation({
    mutationFn: () => api.discoverMcp({ enabledOnly: false }),
    onSuccess: (data) => {
      queryClient.setQueryData<McpServerView[]>(queryKey, (current) =>
        current?.map((server) => {
          const found = data.results.find(
            (item) => item.name === server.name || item.id === server.id,
          );
          return found && found.status !== "error"
            ? { ...server, toolCount: found.tools.length }
            : server;
        }),
      );
    },
    onError: (error) => setActionError(errorMessage(error, "MCP discovery failed.")),
  });

  const invoke = useMutation({
    mutationFn: (input: { server: string; tool: string; args: Record<string, unknown> }) =>
      api.invokeTool({
        server: input.server || null,
        tool: input.tool,
        args: input.args,
      }),
    onSuccess: (data, input) => {
      setResult(data);
      setResultTool(input.tool);
      setInvokeError(null);
    },
    onError: (error) => {
      setResult(null);
      setInvokeError(errorMessage(error, "The tool call failed."));
    },
  });

  const submitInvoke = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseArgs(invokeArgs);
    if (!parsed.ok) {
      setInvokeError(parsed.error);
      return;
    }
    if (!invokeTool.trim()) {
      setInvokeError("Choose a tool to invoke.");
      return;
    }
    setInvokeError(null);
    invoke.mutate({
      server: invokeServer,
      tool: invokeTool.trim(),
      args: parsed.value,
    });
  };

  const openCreate = () => {
    setEditing(null);
    setEditorError(null);
    setEditorOpen(true);
  };

  const openEdit = (server: McpServerView) => {
    setEditing(server);
    setEditorError(null);
    setEditorOpen(true);
  };

  const openInvoke = (server?: McpServerView, tool?: string) => {
    setInvokeServer(server?.name ?? servers[0]?.name ?? "");
    setInvokeTool(tool ?? "");
    setInvokeArgs("{}");
    setInvokeError(null);
    setInvokeOpen(true);
  };

  const discoveredResults: McpDiscoveryResult[] = discover.data?.results ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        icon={<Blocks size={14} strokeWidth={2} />}
        title="MCP"
        meta={`${servers.filter((server) => server.enabled).length}/${servers.length}`}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh MCP servers"
              onClick={() => void serversQuery.refetch()}
              loading={serversQuery.isFetching}
            >
              <RefreshCw size={13} strokeWidth={2} />
            </Button>
            <Button
              variant={discoverOpen ? "soft" : "ghost"}
              size="icon-sm"
              aria-label="Discover MCP tools"
              aria-pressed={discoverOpen}
              onClick={() => {
                if (!discoverOpen && !discover.data) discover.mutate();
                setDiscoverOpen((value) => !value);
              }}
              loading={discover.isPending}
            >
              <Radar size={13} strokeWidth={2} />
            </Button>
            <Button
              variant="soft"
              size="icon-sm"
              aria-label="Add MCP server"
              onClick={openCreate}
            >
              <Plus size={13} strokeWidth={2} />
            </Button>
          </>
        }
      />
      <PanelScroll>
        <div className="flex flex-col gap-3">
          {actionError ? (
            <InlineError message={actionError} onDismiss={() => setActionError(null)} />
          ) : null}

          {discoverOpen ? (
            <div className="flex flex-col gap-2 rounded-card bg-surface p-3 animate-fade-up">
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>Discovered tools</SectionLabel>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => discover.mutate()}
                  loading={discover.isPending}
                >
                  Scan servers
                </Button>
              </div>
              {discover.isPending ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
              ) : discoveredResults.length === 0 ? (
                <p className="px-1 py-1 text-[11.5px] text-ink-3">
                  Connect to enabled servers to list their tools.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {discoveredResults.map((entry) => (
                    <li key={entry.id} className="rounded-lg px-1.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                          {entry.name}
                        </span>
                        <Badge tone={entry.status === "error" ? "bad" : "ok"}>
                          {entry.status}
                        </Badge>
                        <span className="t-num text-[10.5px] text-ink-3">
                          {entry.durationMs}ms
                        </span>
                      </div>
                      {entry.error ? (
                        <p className="mt-1 text-[11px] text-bad">{entry.error}</p>
                      ) : entry.tools.length === 0 ? (
                        <p className="mt-1 text-[11px] text-ink-3">No tools reported.</p>
                      ) : (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {entry.tools.map((tool) => (
                            <button
                              key={tool.name}
                              type="button"
                              title={tool.description}
                              onClick={() => openInvoke(undefined, tool.name)}
                              className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2 transition-colors duration-150 ease-out-expo hover:bg-selected hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                            >
                              {tool.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {result ? (
            <div className="flex flex-col gap-2 rounded-card bg-code p-3 shadow-panel animate-fade-up">
              <div className="flex items-center gap-2">
                <Badge tone={result.isError ? "bad" : "ok"} dot>
                  {resultTool}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Dismiss tool result"
                  className="ml-auto text-code-muted hover:bg-code-hover hover:text-code-ink"
                  onClick={() => setResult(null)}
                >
                  <Check size={13} strokeWidth={2.2} />
                </Button>
              </div>
              <pre className="t-code scroll-area max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-code-ink">
                {resultText(result)}
              </pre>
            </div>
          ) : null}

          {serversQuery.isError ? (
            <ErrorState
              title="MCP servers unavailable"
              message={errorMessage(serversQuery.error, "The server list could not be read.")}
              retry={() => void serversQuery.refetch()}
              retrying={serversQuery.isFetching}
            />
          ) : serversQuery.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : servers.length === 0 ? (
            <EmptyState
              icon={<Server size={18} strokeWidth={1.8} />}
              title="No MCP servers"
              description="Add a stdio command or an HTTP/SSE endpoint to expose tools."
              action={
                <Button size="sm" variant="secondary" onClick={openCreate}>
                  <Plus size={13} strokeWidth={2} />
                  Add server
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col">
              {servers.map((server) => {
                const pending = toggle.isPending && toggle.variables?.id === server.id;
                return (
                  <li
                    key={server.id}
                    className="flex items-start gap-2 rounded-lg px-1.5 py-2 transition-colors duration-150 ease-out-expo hover:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-[12.5px] font-medium text-ink">
                          {server.name}
                        </p>
                        <Badge tone="neutral">{transportLabel(server.transport)}</Badge>
                        {server.autoRun ? <Badge tone="info">auto</Badge> : null}
                        {server.toolCount !== null ? (
                          <span className="t-num text-[10.5px] text-ink-3">
                            {server.toolCount} tools
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3"
                        title={server.target}
                      >
                        {truncate(server.target, 64)}
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Invoke a tool on ${server.name}`}
                        onClick={() => openInvoke(server)}
                      >
                        <Play size={12} strokeWidth={2} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${server.name}`}
                        onClick={() => openEdit(server)}
                      >
                        <Pencil size={12} strokeWidth={2} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${server.name}`}
                        className="hover:text-bad"
                        onClick={() => setDeleting(server)}
                      >
                        <Trash2 size={12} strokeWidth={2} />
                      </Button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={server.enabled}
                        aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.name}`}
                        disabled={pending}
                        onClick={() => toggle.mutate(server)}
                        className={cx(
                          "relative ml-0.5 h-5 w-9 flex-none rounded-full transition-[background-color,opacity] duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50",
                          server.enabled ? "bg-accent" : "bg-line-strong",
                        )}
                      >
                        <span
                          className={cx(
                            "absolute top-0.5 h-4 w-4 rounded-full bg-panel shadow-thumb transition-[left] duration-200 ease-out-expo",
                            server.enabled ? "left-[18px]" : "left-0.5",
                          )}
                        />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PanelScroll>

      <McpEditor
        open={editorOpen}
        server={editing}
        saving={save.isPending}
        saveError={editorError}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) {
            setEditing(null);
            setEditorError(null);
          }
        }}
        onSave={(path, input) => save.mutate({ path, input })}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Remove MCP server"
        description={
          deleting
            ? `Remove “${deleting.name}”? Its tools will no longer be available to turns.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting)}
            >
              Remove
            </Button>
          </>
        }
      />

      <Dialog
        open={invokeOpen}
        onOpenChange={setInvokeOpen}
        title="Invoke tool"
        description="Calls the tool through the local MCP service. Arguments are sent as JSON."
        width={520}
      >
        <form className="flex flex-col gap-3" onSubmit={submitInvoke}>
          <Field label="Server" htmlFor="mcp-invoke-server">
            <Select
              id="mcp-invoke-server"
              value={invokeServer}
              onChange={(event) => setInvokeServer(event.target.value)}
            >
              <option value="">Any enabled server</option>
              {servers.map((server) => (
                <option key={server.id} value={server.name}>
                  {server.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Tool"
            htmlFor="mcp-invoke-tool"
            hint={
              toolsOf(discoveredResults, invokeServer).length
                ? "Suggestions come from the last discovery scan."
                : undefined
            }
          >
            <Input
              id="mcp-invoke-tool"
              value={invokeTool}
              placeholder="tool_name"
              className="font-mono"
              autoComplete="off"
              onChange={(event) => setInvokeTool(event.target.value)}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === "Enter" && (isComposingEvent(event) || composing.current)) {
                  event.preventDefault();
                }
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
            />
          </Field>
          {toolsOf(discoveredResults, invokeServer).length ? (
            <div className="flex flex-wrap gap-1">
              {toolsOf(discoveredResults, invokeServer)
                .slice(0, 8)
                .map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => setInvokeTool(tool.name)}
                    className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2 transition-colors duration-150 ease-out-expo hover:bg-selected hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    {tool.name}
                  </button>
                ))}
            </div>
          ) : null}
          <Field label="Arguments (JSON)" htmlFor="mcp-invoke-args" error={invokeError}>
            <Textarea
              id="mcp-invoke-args"
              value={invokeArgs}
              spellCheck={false}
              className="font-mono text-[11.5px]"
              onChange={(event) => setInvokeArgs(event.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setInvokeOpen(false)}>
              Close
            </Button>
            <Button type="submit" size="sm" loading={invoke.isPending}>
              <Play size={12} strokeWidth={2} />
              Invoke
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function McpEditor({
  open,
  server,
  saving,
  saveError,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  server: McpServerView | null;
  saving: boolean;
  saveError: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (path: string, input: McpServerInput) => void;
}) {
  const [draft, setDraft] = useState<McpDraft>(() => draftFrom(server));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(server));
    setError(null);
  }, [open, server]);

  const patch = (values: Partial<McpDraft>) =>
    setDraft((current) => ({ ...current, ...values }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setError("A server name is required.");
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      setError("Use letters, numbers, dots, dashes or underscores.");
      return;
    }
    if (draft.transport === "stdio" && !draft.command.trim()) {
      setError("A command is required for stdio servers.");
      return;
    }
    if (draft.transport !== "stdio" && !draft.url.trim()) {
      setError("A URL is required for HTTP and SSE servers.");
      return;
    }
    setError(null);
    const input: McpServerInput = {
      name,
      transport: draft.transport,
      command: draft.transport === "stdio" ? draft.command.trim() : null,
      args:
        draft.transport === "stdio"
          ? draft.argsText
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean)
          : [],
      env: parsePairs(draft.envText),
      url: draft.transport === "stdio" ? null : draft.url.trim(),
      headers: parsePairs(draft.headersText),
      enabled: draft.enabled,
      autoRun: draft.autoRun,
    };
    onSave(server?.name ?? name, input);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={server ? `Edit ${server.name}` : "Add MCP server"}
      description="The backend owns connection pooling and JSON-RPC framing."
      width={540}
    >
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor="mcp-name">
            <Input
              id="mcp-name"
              value={draft.name}
              autoComplete="off"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field label="Transport" htmlFor="mcp-transport">
            <Select
              id="mcp-transport"
              value={draft.transport}
              onChange={(event) => patch({ transport: event.target.value as McpTransport })}
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </Select>
          </Field>
        </div>

        {draft.transport === "stdio" ? (
          <>
            <Field label="Command" htmlFor="mcp-command">
              <Input
                id="mcp-command"
                value={draft.command}
                placeholder="npx"
                className="font-mono text-[11.5px]"
                autoComplete="off"
                onChange={(event) => patch({ command: event.target.value })}
              />
            </Field>
            <Field label="Arguments" htmlFor="mcp-args" hint="One argument per line.">
              <Textarea
                id="mcp-args"
                value={draft.argsText}
                spellCheck={false}
                className="font-mono text-[11.5px]"
                onChange={(event) => patch({ argsText: event.target.value })}
              />
            </Field>
          </>
        ) : (
          <Field label="URL" htmlFor="mcp-url">
            <Input
              id="mcp-url"
              value={draft.url}
              placeholder="https://example.com/mcp"
              className="font-mono text-[11.5px]"
              autoComplete="off"
              onChange={(event) => patch({ url: event.target.value })}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Environment" htmlFor="mcp-env" hint="One KEY=value per line.">
            <Textarea
              id="mcp-env"
              value={draft.envText}
              spellCheck={false}
              className="min-h-[64px] font-mono text-[11.5px]"
              onChange={(event) => patch({ envText: event.target.value })}
            />
          </Field>
          <Field label="Headers" htmlFor="mcp-headers" hint="One KEY=value per line.">
            <Textarea
              id="mcp-headers"
              value={draft.headersText}
              spellCheck={false}
              className="min-h-[64px] font-mono text-[11.5px]"
              onChange={(event) => patch({ headersText: event.target.value })}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-[12px] text-ink-2">
            <input
              type="checkbox"
              checked={draft.autoRun}
              onChange={(event) => patch({ autoRun: event.target.checked })}
            />
            Auto-run
          </label>
        </div>

        {error ? (
          <p className="text-[11.5px] text-bad" role="alert">
            {error}
          </p>
        ) : saveError ? (
          <p className="text-[11.5px] text-bad" role="alert">
            {saveError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
