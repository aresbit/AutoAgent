import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  Monitor,
  Moon,
  Pencil,
  Plus,
  Sparkles,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type SessionSummary } from "@/api/client";
import {
  Button,
  Dialog,
  Field,
  Input,
  Tooltip,
  isComposingEvent,
  useRovingFocus,
} from "@/cds";
import { useTheme } from "@/app/providers";
import { cx } from "@/lib/cx";
import { relativeTime } from "@/lib/format";

export function SessionsPanel({
  sessions,
  activeId,
  onSelect,
  onCreated,
  onNavigate,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onCreated: (id: string) => void;
  onNavigate?: () => void;
}) {
  const queryClient = useQueryClient();
  const roving = useRovingFocus(sessions.length, "vertical");
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const composing = useRef(false);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sessions"] });

  const createSession = useMutation({
    mutationFn: () => api.createSession(),
    onSuccess: async (session) => {
      await invalidate();
      onCreated(session.id);
      onNavigate?.();
    },
    onError: (error) => setActionError(messageOf(error, "The session could not be created.")),
  });

  const renameSession = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.renameSession(id, title),
    onSuccess: async () => {
      await invalidate();
      setRenaming(null);
    },
    onError: (error) => setActionError(messageOf(error, "The session could not be renamed.")),
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: async (_result, id) => {
      await invalidate();
      setDeleting(null);
      if (activeId === id) {
        const next = sessions.find((session) => session.id !== id);
        onSelect(next?.id ?? null);
      }
    },
    onError: (error) => setActionError(messageOf(error, "The session could not be deleted.")),
  });

  const branchSession = useMutation({
    mutationFn: (id: string) => api.branchSession(id),
    onSuccess: async (session) => {
      await invalidate();
      onCreated(session.id);
      onNavigate?.();
    },
    onError: (error) => setActionError(messageOf(error, "The session could not be branched.")),
  });

  const openRename = (session: SessionSummary) => {
    setTitleDraft(session.title);
    setRenaming(session);
  };

  const submitRename = (event?: FormEvent) => {
    event?.preventDefault();
    if (!renaming || !titleDraft.trim()) return;
    renameSession.mutate({ id: renaming.id, title: titleDraft.trim() });
  };

  const { theme, setTheme } = useTheme();
  const ThemeIcon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2.5 px-3 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-on-accent shadow-sm">
          <Sparkles size={14} strokeWidth={2.2} aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ink">
            AutoAgent
          </p>
          <p className="truncate text-[10.5px] text-ink-3">Local workspace</p>
        </div>
      </div>

      <div className="px-3 pb-3">
        <Button
          variant="primary"
          size="sm"
          className="w-full justify-center"
          onClick={() => createSession.mutate()}
          loading={createSession.isPending}
        >
          <Plus size={14} strokeWidth={2.2} />
          New session
        </Button>
      </div>

      <div className="flex items-center justify-between px-3 pb-1.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
          Sessions
        </p>
        <span className="t-num text-[10.5px] text-ink-3">{sessions.length}</span>
      </div>

      <nav aria-label="Sessions" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-area">
        {sessions.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-3">
            No sessions yet. Start one to begin.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session, index) => {
              const active = session.id === activeId;
              return (
                <li key={session.id} className="group relative">
                  <button
                    type="button"
                    {...roving.itemProps(index)}
                    onClick={() => {
                      onSelect(session.id);
                      onNavigate?.();
                    }}
                    aria-current={active ? "true" : undefined}
                    className={cx(
                      "w-full rounded-card px-2.5 py-2 pr-20 text-left transition-[background-color,box-shadow] duration-150 ease-out-expo focus-visible:outline-none focus-visible:shadow-focus",
                      active ? "bg-selected" : "hover:bg-hover",
                    )}
                  >
                    <span
                      className={cx(
                        "block truncate text-[12.5px] leading-5",
                        active ? "font-medium text-ink" : "text-ink-2",
                      )}
                    >
                      {session.title}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-3">
                      <span className="t-num">{session.messageCount}</span>
                      <span>{session.messageCount === 1 ? "message" : "messages"}</span>
                      <span aria-hidden>·</span>
                      <span className="t-num">{relativeTime(session.updatedAt)}</span>
                    </span>
                  </button>
                  <div className="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out-expo group-hover:opacity-100 group-focus-within:opacity-100">
                    <Tooltip content="Rename">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rename ${session.title}`}
                        onClick={() => openRename(session)}
                      >
                        <Pencil size={12.5} strokeWidth={2} />
                      </Button>
                    </Tooltip>
                    <Tooltip content="Branch">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Branch ${session.title}`}
                        disabled={branchSession.isPending}
                        onClick={() => branchSession.mutate(session.id)}
                      >
                        <GitBranch size={12.5} strokeWidth={2} />
                      </Button>
                    </Tooltip>
                    <Tooltip content="Delete">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${session.title}`}
                        onClick={() => setDeleting(session)}
                      >
                        <Trash2 size={12.5} strokeWidth={2} />
                      </Button>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {actionError ? (
        <div className="mx-3 mb-2 rounded-lg bg-bad/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-bad">
          {actionError}
        </div>
      ) : null}

      <div className="hairline-t flex items-center justify-between px-3 py-2">
        <span className="text-[10.5px] text-ink-3">Theme</span>
        <Tooltip content={`Theme: ${theme}`}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Switch theme (currently ${theme})`}
            onClick={() => setTheme(nextTheme)}
          >
            <ThemeIcon size={13.5} strokeWidth={2} />
          </Button>
        </Tooltip>
      </div>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Rename session"
        description="Use a short name that describes the conversation."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => submitRename()}
              loading={renameSession.isPending}
              disabled={!titleDraft.trim()}
            >
              Save
            </Button>
          </>
        }
      >
        <form onSubmit={submitRename}>
          <Field label="Title" htmlFor="rename-session-title">
            <Input
              id="rename-session-title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (isComposingEvent(event) || composing.current)) {
                  event.preventDefault();
                }
              }}
              autoFocus
            />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete session"
        description={
          deleting
            ? `“${deleting.title}” and its messages will be removed. This cannot be undone.`
            : ""
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => deleting && deleteSession.mutate(deleting.id)}
              loading={deleteSession.isPending}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
