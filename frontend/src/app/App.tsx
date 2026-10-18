import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  api,
  type BootstrapView,
  type SettingsPatch,
} from "@/api/client";
import { Button, ErrorState, QuietDots } from "@/cds";
import { useServerEvents } from "@/api/events";
import { Shell } from "./Shell";

export function App() {
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api.bootstrap(),
    staleTime: Infinity,
    retry: (count, error) =>
      error instanceof ApiError && error.retryable && count < 2,
  });

  if (bootstrap.isLoading) {
    return (
      <BootScreen
        onRetry={() => void bootstrap.refetch()}
        retrying={bootstrap.isFetching}
      />
    );
  }

  if (bootstrap.isError || !bootstrap.data) {
    const error = bootstrap.error;
    const unauthorized = error instanceof ApiError && error.status === 401;
    return (
      <BootScreen
        error={
          unauthorized
            ? "This launch link is no longer valid. Restart AutoAgent from the desktop app."
            : error instanceof Error
              ? error.message
              : "The local service could not be reached."
        }
        onRetry={() => void bootstrap.refetch()}
        retrying={bootstrap.isFetching}
      />
    );
  }

  return <Workspace bootstrap={bootstrap.data} />;
}

function Workspace({ bootstrap }: { bootstrap: BootstrapView }) {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState(bootstrap.settings);
  const [activeId, setActiveId] = useState<string | null>(
    bootstrap.sessions[0]?.id ?? null,
  );

  useServerEvents(activeId);

  const sessionsQuery = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.listSessions(),
    initialData: bootstrap.sessions,
  });

  const engineQuery = useQuery({
    queryKey: ["engine"],
    queryFn: () => api.engineStatus(),
    initialData: bootstrap.engine,
    refetchInterval: 5000,
  });

  const sessions = sessionsQuery.data ?? bootstrap.sessions;

  useEffect(() => {
    if (activeId && sessions.some((session) => session.id === activeId)) return;
    setActiveId(sessions[0]?.id ?? null);
  }, [activeId, sessions]);

  const saveSettings = useCallback(async (patch: SettingsPatch) => {
    const next = await api.updateSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const createSession = useMutation({
    mutationFn: () => api.createSession(),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setActiveId(session.id);
    },
  });

  return (
    <Shell
      sessions={sessions}
      activeId={activeId}
      onSelect={setActiveId}
      onCreated={setActiveId}
      onCreateSession={() => createSession.mutate()}
      settings={settings}
      onSaveSettings={saveSettings}
      providers={bootstrap.providers}
      engine={engineQuery.data}
      engineRefreshing={engineQuery.isFetching}
      onRefreshEngine={() => void engineQuery.refetch()}
      initialSkills={bootstrap.skills}
      initialMcpServers={bootstrap.mcpServers}
      initialArtifacts={bootstrap.artifacts}
      workspace={bootstrap.workspace}
    />
  );
}

function BootScreen({
  error,
  onRetry,
  retrying,
}: {
  error?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-card bg-accent text-on-accent shadow-panel">
          <Sparkles size={18} strokeWidth={2.2} aria-hidden />
        </div>
        {error ? (
          <ErrorState
            title="AutoAgent could not start"
            message={error}
            retry={onRetry}
            retrying={retrying}
          />
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
                AutoAgent
              </p>
              <p className="text-[12.5px] text-ink-2">
                Opening the local workspace
              </p>
            </div>
            <QuietDots label="Loading workspace" />
            <Button variant="ghost" size="xs" onClick={() => onRetry?.()}>
              Taking too long?
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
