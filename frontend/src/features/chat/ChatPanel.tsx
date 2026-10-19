import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  GitBranch,
  MessageSquare,
  PanelLeft,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  newTurnId,
  type EngineStatusView,
  type LiveTool,
  type MessageView,
  type SessionSummary,
  type TurnStreamEvent,
} from "@/api/client";
import {
  Badge,
  BreathingDot,
  Button,
  Composer,
  EmptyState,
  ErrorState,
  MessageBubble,
  Skeleton,
  ThinkingAccordion,
  ToolDecisionCard,
  Tooltip,
  useScrollFade,
  useScrollPinning,
} from "@/cds";
import type { ChatArtifact } from "@/features/artifacts/logic";
import {
  addPendingTurn,
  pendingTurnsForSession,
  removePendingTurn,
} from "./outbox";
import { Markdown } from "./markdown";

interface LiveTurn {
  turnId: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  usage: { inputTokens?: number; outputTokens?: number };
  status: "streaming" | "cancelling" | "error";
}

interface TurnFailure {
  message: string;
  code: string;
  retryable: boolean;
  text: string;
  turnId: string;
  reuseTurnId: boolean;
}

const SUGGESTIONS = [
  "Explain the turn stream contract",
  "Review the settings surface",
  "Show a small HTML artifact",
];

function outboxStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function ChatPanel({
  sessionId,
  summary,
  engine,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onCreateSession,
  onCreated,
  onOpenArtifact,
}: {
  sessionId: string | null;
  summary: SessionSummary | undefined;
  engine: EngineStatusView | undefined;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onCreateSession: () => void;
  onCreated: (id: string) => void;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
}) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [failure, setFailure] = useState<TurnFailure | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId as string),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });

  useEffect(() => {
    setMessages(sessionQuery.data?.messages ?? []);
  }, [sessionQuery.data]);

  useEffect(() => {
    setLive(null);
    setFailure(null);
    setComposerValue("");
  }, [sessionId]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
    },
    [sessionId],
  );

  useEffect(() => {
    if (!branchError) return;
    const timer = setTimeout(() => setBranchError(null), 5000);
    return () => clearTimeout(timer);
  }, [branchError]);

  const streaming = live !== null && live.status !== "error";

  const runTurn = useCallback(
    (
      rawText: string,
      options?: { reuseUserMessage?: boolean; turnId?: string; retry?: boolean },
    ) => {
      if (!sessionId) return;
      if (streaming && !options?.retry) return;
      const text = rawText.trim();
      if (!text) return;

      const turnId = options?.turnId ?? newTurnId();
      // Persist the intent before the request leaves the renderer. The backend
      // is idempotent by turn id, so a replay never duplicates the message.
      addPendingTurn(outboxStorage(), {
        turnId,
        sessionId,
        text,
        createdAt: Date.now(),
      });
      if (!options?.reuseUserMessage) {
        const userMessage: MessageView = {
          id: `local-${turnId}`,
          role: "user",
          text,
          createdAt: Date.now(),
          meta: null,
        };
        setMessages((current) => [...current, userMessage]);
      }
      setFailure(null);
      setBranchError(null);
      setLive({
        turnId,
        text: "",
        thinking: "",
        tools: [],
        usage: {},
        status: "streaming",
      });

      const controller = new AbortController();
      controllerRef.current = controller;
      let terminal = false;

      const onEvent = (event: TurnStreamEvent) => {
        if (event.type === "message.delta") {
          setLive((current) =>
            current
              ? {
                  ...current,
                  text: event.channel === "text" ? current.text + event.text : current.text,
                  thinking:
                    event.channel === "thinking"
                      ? current.thinking + event.text
                      : current.thinking,
                }
              : current,
          );
          return;
        }
        if (event.type === "message.completed") {
          setLive((current) => (current ? { ...current, text: event.text } : current));
          if (event.text.trim()) {
            setMessages((current) =>
              current.some((message) => message.id === event.messageId)
                ? current
                : [
                    ...current,
                    {
                      id: event.messageId,
                      role: "assistant",
                      text: event.text,
                      createdAt: event.ts,
                      meta: null,
                    },
                  ],
            );
          }
          return;
        }
        if (event.type === "tool.start") {
          setLive((current) =>
            current
              ? {
                  ...current,
                  tools: [...current.tools, { ...event.tool, status: "running" as const }],
                }
              : current,
          );
          return;
        }
        if (event.type === "tool.result") {
          setLive((current) =>
            current
              ? {
                  ...current,
                  tools: current.tools.map((tool) =>
                    tool.ref === event.tool.ref
                      ? {
                          ...tool,
                          status: event.tool.ok ? "ok" : "error",
                          result: event.text,
                        }
                      : tool,
                  ),
                }
              : current,
          );
          return;
        }
        if (event.type === "usage") {
          setLive((current) => (current ? { ...current, usage: event.usage } : current));
          return;
        }
        if (event.type === "turn.completed") {
          terminal = true;
          removePendingTurn(outboxStorage(), turnId);
          setLive(null);
          if (cancelTimer.current) clearTimeout(cancelTimer.current);
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          void queryClient.invalidateQueries({ queryKey: ["engine"] });
          return;
        }
        if (event.type === "error") {
          terminal = true;
          // The turn reached a terminal failed state; the user message is
          // already persisted, so replaying it on the next load is wrong.
          removePendingTurn(outboxStorage(), turnId);
          setLive((current) => (current ? { ...current, status: "error" } : current));
          setFailure({
            message: event.message,
            code: event.code,
            retryable: event.retryable,
            text,
            turnId,
            reuseTurnId: false,
          });
        }
      };

      api
        .streamTurn(turnId, { sessionId, text }, onEvent, controller.signal)
        .then(() => {
          if (controller.signal.aborted) return;
          if (!terminal) {
            setLive((current) =>
              current ? { ...current, status: "error" } : current,
            );
            setFailure({
              message: "The response stream ended before the turn completed.",
              code: "STREAM_INTERRUPTED",
              retryable: true,
              text,
              turnId,
              reuseTurnId: true,
            });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const retryable = error instanceof ApiError ? error.retryable : true;
          setLive((current) => (current ? { ...current, status: "error" } : current));
          setFailure({
            message:
              error instanceof Error && error.message
                ? error.message
                : "The turn could not be started.",
            code: error instanceof ApiError ? error.code : "NETWORK_ERROR",
            retryable,
            text,
            turnId,
            reuseTurnId: !(error instanceof ApiError) || error.status === 0 || retryable,
          });
        })
        .finally(() => {
          if (controllerRef.current === controller) controllerRef.current = null;
        });
    },
    [queryClient, sessionId, streaming],
  );

  const send = useCallback(() => {
    const text = composerValue;
    setComposerValue("");
    runTurn(text);
  }, [composerValue, runTurn]);

  // Reconcile an unfinished turn after a reload/crash. The same turn id is
  // reused, so the backend either attaches to the live turn or replays a
  // request that never reached it; a finished turn only clears the entry.
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;
  const reconciledTurns = useRef<Set<string>>(new Set());
  useEffect(() => {
    const storage = outboxStorage();
    if (!sessionId || !storage) return;
    const pending = pendingTurnsForSession(storage, sessionId);
    if (pending.length === 0) return;
    const entry = pending[pending.length - 1];
    if (reconciledTurns.current.has(entry.turnId)) return;
    reconciledTurns.current.add(entry.turnId);
    void (async () => {
      try {
        const status = await api.turnStatus(entry.turnId);
        if (status.state === "running") {
          runTurnRef.current(entry.text, {
            turnId: entry.turnId,
            reuseUserMessage: true,
            retry: true,
          });
        } else {
          removePendingTurn(storage, entry.turnId);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          runTurnRef.current(entry.text, {
            turnId: entry.turnId,
            reuseUserMessage: true,
            retry: true,
          });
        } else {
          // Leave the entry for the next load; do not spin on network errors.
          reconciledTurns.current.delete(entry.turnId);
        }
      }
    })();
  }, [sessionId]);

  const cancel = useCallback(() => {
    if (!live || live.status !== "streaming") return;
    const current = live;
    setLive((value) => (value ? { ...value, status: "cancelling" } : value));
    void api.cancelTurn(current.turnId).catch(() => {
      if (cancelTimer.current) clearTimeout(cancelTimer.current);
      controllerRef.current?.abort();
      setLive(null);
    });
    cancelTimer.current = setTimeout(() => {
      controllerRef.current?.abort();
      setLive(null);
      setFailure({
        message: "The turn did not stop in time.",
        code: "CANCEL_TIMEOUT",
        retryable: false,
        text: "",
        turnId: current.turnId,
        reuseTurnId: false,
      });
    }, 8000);
  }, [live]);

  const retry = useCallback(() => {
    if (!failure) return;
    if (!failure.retryable) {
      setFailure(null);
      return;
    }
    const pending = failure;
    setFailure(null);
    setLive(null);
    runTurn(pending.text, {
      reuseUserMessage: true,
      turnId: pending.reuseTurnId ? pending.turnId : undefined,
      retry: true,
    });
  }, [failure, runTurn]);

  const dismissFailure = useCallback(() => {
    setFailure(null);
    setLive((current) => (current?.status === "error" ? null : current));
  }, []);

  const branch = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session selected.");
      return api.branchSession(sessionId);
    },
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onCreated(session.id);
    },
    onError: (error) =>
      setBranchError(
        error instanceof Error ? error.message : "The session could not be branched.",
      ),
  });

  const trigger = `${messages.length}:${live?.text.length ?? 0}:${live?.thinking.length ?? 0}:${
    live?.tools.length ?? 0
  }:${live?.tools.map((tool) => tool.status).join("")}`;
  const pinning = useScrollPinning(trigger);

  useEffect(() => {
    pinning.reset();
    pinning.scrollToBottom(false);
    // Reset follow state when the conversation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const fadeRef = useScrollFade<HTMLDivElement>();
  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      pinning.ref.current = node;
      fadeRef.current = node;
    },
    [pinning.ref, fadeRef],
  );

  const hasConversation = messages.length > 0 || live !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="hairline-b flex h-12 shrink-0 items-center gap-1 px-2 sm:px-3">
        <Tooltip content={leftOpen ? "Hide sessions" : "Show sessions"}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={leftOpen ? "Hide sessions" : "Show sessions"}
            onClick={onToggleLeft}
          >
            <PanelLeft size={16} strokeWidth={1.9} />
          </Button>
        </Tooltip>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-[13px] font-medium text-ink">
            {summary?.title ?? "AutoAgent"}
          </p>
          <p className="hidden items-center gap-1.5 text-[10.5px] text-ink-3 sm:flex">
            {summary ? (
              <>
                <span className="t-num">{summary.messageCount}</span>
                <span>{summary.messageCount === 1 ? "message" : "messages"}</span>
              </>
            ) : (
              "Select or create a session"
            )}
          </p>
        </div>
        <EnginePill engine={engine} />
        <Tooltip content="Branch session">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Branch session"
            disabled={!sessionId || branch.isPending}
            onClick={() => branch.mutate()}
          >
            <GitBranch size={15} strokeWidth={1.9} />
          </Button>
        </Tooltip>
        <Tooltip content={rightOpen ? "Hide controls" : "Show controls"}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={rightOpen ? "Hide controls" : "Show controls"}
            onClick={onToggleRight}
          >
            <SlidersHorizontal size={15} strokeWidth={1.9} />
          </Button>
        </Tooltip>
      </header>

      {!sessionId ? (
        <EmptyState
          className="flex-1"
          icon={<MessageSquare size={19} strokeWidth={1.8} />}
          title="No conversation selected"
          description="Pick a session from the sidebar, or start a new one to send your first message."
          action={
            <Button variant="primary" size="sm" onClick={onCreateSession}>
              New session
            </Button>
          }
        />
      ) : sessionQuery.isLoading ? (
        <div className="flex flex-1 flex-col gap-4 p-5">
          <Skeleton className="h-16 w-2/3 self-end rounded-[18px]" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-1/2" />
        </div>
      ) : sessionQuery.isError ? (
        <ErrorState
          className="flex-1"
          title="This session could not be loaded"
          message={
            sessionQuery.error instanceof Error
              ? sessionQuery.error.message
              : "The session is unavailable."
          }
          retry={() => void sessionQuery.refetch()}
          retrying={sessionQuery.isFetching}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={setScrollNode}
            onScroll={pinning.onScroll}
            onWheel={pinning.markUserInput}
            onTouchMove={pinning.markUserInput}
            onKeyDown={(event) => {
              if (
                [
                  "ArrowUp",
                  "ArrowDown",
                  "PageUp",
                  "PageDown",
                  "Home",
                  "End",
                  " ",
                ].includes(event.key)
              ) {
                pinning.markUserInput();
              }
            }}
            tabIndex={0}
            role="region"
            aria-label="Conversation"
            className="scroll-area fade-mask-y min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:shadow-focus"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-1 py-6 sm:px-3">
              {!hasConversation ? (
                <div className="flex flex-col items-center gap-4 py-10">
                  <EmptyState
                    className="py-2"
                    icon={<MessageSquare size={19} strokeWidth={1.8} />}
                    title="Start where you are"
                    description="Ask about the workspace, sketch a change, or explore an idea. The assistant keeps the conversation in this session."
                  />
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <Button
                        key={suggestion}
                        variant="soft"
                        size="sm"
                        onClick={() => setComposerValue(suggestion)}
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}

              {messages.map((message) =>
                message.role === "tool" ? (
                  <ToolDecisionCard
                    key={message.id}
                    tool={{
                      ref: message.id,
                      name: "Tool",
                      status: "ok",
                      result: message.text,
                    }}
                  />
                ) : (
                  <MessageBubble
                    key={message.id}
                    role={message.role}
                    time={message.createdAt}
                  >
                    {message.role === "assistant" ? (
                      <Markdown text={message.text} onOpenArtifact={onOpenArtifact} />
                    ) : (
                      message.text
                    )}
                  </MessageBubble>
                ),
              )}

              {live ? (
                <MessageBubble
                  role="assistant"
                  time={undefined}
                  streaming={live.status === "streaming"}
                >
                  <div className="flex flex-col gap-3">
                    {live.thinking || live.status === "streaming" ? (
                      <ThinkingAccordion
                        text={live.thinking}
                        streaming={live.status === "streaming" && !live.text}
                      />
                    ) : null}
                    {live.tools.map((tool) => (
                      <ToolDecisionCard key={tool.ref} tool={tool} />
                    ))}
                    {live.text ? (
                      <Markdown text={live.text} onOpenArtifact={onOpenArtifact} />
                    ) : live.status === "streaming" ? (
                      <span className="shimmer-text text-[12.5px]">
                        Composing response
                      </span>
                    ) : null}
                    {live.usage.inputTokens || live.usage.outputTokens ? (
                      <p className="t-num flex items-center gap-2 text-[10.5px] text-ink-3">
                        {live.usage.inputTokens ? (
                          <span>{live.usage.inputTokens.toLocaleString()} in</span>
                        ) : null}
                        {live.usage.outputTokens ? (
                          <span>{live.usage.outputTokens.toLocaleString()} out</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                </MessageBubble>
              ) : null}
            </div>
          </div>

          {pinning.showJump ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto rounded-full shadow-popover"
                onClick={() => pinning.scrollToBottom(true)}
              >
                <ArrowDown size={13} strokeWidth={2} />
                Jump to latest
              </Button>
            </div>
          ) : null}

          <div className="sr-only" role="status" aria-live="polite">
            {live?.status === "cancelling"
              ? "Stopping the response."
              : live?.status === "streaming"
                ? "The assistant is responding."
                : ""}
          </div>

          {branchError ? (
            <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-bad/10 px-3 py-2 text-[11.5px] text-bad">
              <AlertCircle size={13} strokeWidth={2} />
              <span className="flex-1">{branchError}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss"
                onClick={() => setBranchError(null)}
              >
                <X size={12} />
              </Button>
            </div>
          ) : null}

          {failure ? (
            <div className="mx-3 mb-1 flex items-start gap-2 rounded-card bg-bad/10 px-3 py-2.5">
              <AlertCircle size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-bad" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-bad">{failure.message}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-2">
                  {failure.retryable
                    ? "You can retry this turn or send a new message."
                    : "This turn stopped. Sending a new message will start fresh."}
                </p>
              </div>
              {failure.retryable ? (
                <Button variant="secondary" size="xs" onClick={retry}>
                  <RotateCcw size={11} strokeWidth={2} />
                  Retry
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss error"
                onClick={dismissFailure}
              >
                <X size={13} />
              </Button>
            </div>
          ) : null}

          <Composer
            value={composerValue}
            onChange={setComposerValue}
            onSend={send}
            onCancel={cancel}
            streaming={streaming}
            cancelling={live?.status === "cancelling"}
            disabled={!sessionId}
            placeholder={
              live?.status === "cancelling" ? "Stopping…" : "Send a message…"
            }
          />
        </div>
      )}
    </div>
  );
}

function EnginePill({ engine }: { engine: EngineStatusView | undefined }) {
  if (!engine) {
    return (
      <Badge tone="neutral" className="mr-1 hidden sm:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-3" aria-hidden />
        Offline
      </Badge>
    );
  }
  const busy = engine.state === "busy" || engine.state === "starting";
  const label =
    engine.state === "busy"
      ? "Working"
      : engine.state === "starting"
        ? "Starting"
        : engine.state === "error"
          ? "Error"
          : "Idle";
  return (
    <Badge
      tone={engine.state === "error" ? "bad" : busy ? "accent" : "neutral"}
      className="mr-1 hidden sm:inline-flex"
    >
      {busy ? (
        <BreathingDot tone="accent" />
      ) : (
        <span
          className={
            engine.state === "error"
              ? "h-1.5 w-1.5 rounded-full bg-bad"
              : "h-1.5 w-1.5 rounded-full bg-ok"
          }
          aria-hidden
        />
      )}
      {label}
      {engine.activeTurns > 0 ? (
        <span className="t-num text-[10px] opacity-70">{engine.activeTurns}</span>
      ) : null}
    </Badge>
  );
}
