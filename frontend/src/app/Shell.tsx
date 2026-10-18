import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  Blocks,
  Boxes,
  FolderGit2,
  Puzzle,
  Settings2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ArtifactView,
  EngineStatusView,
  McpServerView,
  ProviderCatalogView,
  SessionSummary,
  SettingsPatch,
  SettingsView,
  SkillView,
  WorkspaceStatusView,
} from "@/api/client";
import {
  Button,
  SPRING_REVEAL,
  SPRING_SNAP,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  useIsNarrow,
  useSpring,
} from "@/cds";
import { EnginePanel, SettingsPanel } from "@/features/settings/SettingsPanel";
import { SkillsPanel } from "@/features/skills/SkillsPanel";
import { McpPanel } from "@/features/mcp/McpPanel";
import { WorkspacePanel } from "@/features/workspace/WorkspacePanel";
import { ArtifactsPanel } from "@/features/artifacts/ArtifactsPanel";
import type { ChatArtifact } from "@/features/artifacts/logic";
import { SessionsPanel } from "@/features/sessions/SessionsPanel";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { cx } from "@/lib/cx";
import {
  DEFAULT_LEFT,
  DEFAULT_RIGHT,
  MAX_LEFT,
  MAX_RIGHT,
  MIN_LEFT,
  MIN_RIGHT,
  clampLayout,
  clampWidth,
  keyboardStep,
} from "@/lib/layout";

export function Shell({
  sessions,
  activeId,
  onSelect,
  onCreated,
  onCreateSession,
  settings,
  onSaveSettings,
  providers,
  engine,
  engineRefreshing,
  onRefreshEngine,
  initialSkills,
  initialMcpServers,
  initialArtifacts,
  workspace,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
  onCreated: (id: string) => void;
  onCreateSession: () => void;
  settings: SettingsView;
  onSaveSettings: (patch: SettingsPatch) => Promise<SettingsView>;
  providers: ProviderCatalogView;
  engine: EngineStatusView | undefined;
  engineRefreshing: boolean;
  onRefreshEngine: () => void;
  initialSkills: SkillView[];
  initialMcpServers: McpServerView[];
  initialArtifacts: ArtifactView[];
  workspace: WorkspaceStatusView;
}) {
  const narrow = useIsNarrow();
  const [layout, setLayout] = useState(() => clampLayout(settings.layout));
  const [resizing, setResizing] = useState(false);
  const [mobileLeft, setMobileLeft] = useState(false);
  const [mobileRight, setMobileRight] = useState(false);
  const [tab, setTab] = useState("settings");
  const [artifactRequest, setArtifactRequest] = useState<ChatArtifact | null>(null);
  const widthTransition = useSpring(SPRING_SNAP);
  const overlayTransition = useSpring(SPRING_REVEAL);

  useEffect(() => {
    setLayout(clampLayout(settings.layout));
  }, [settings.layout]);

  useEffect(() => {
    if (resizing) return;
    if (sameLayout(layout, settings.layout)) return;
    const timer = setTimeout(() => {
      void onSaveSettings({ layout }).catch(() =>
        setLayout(clampLayout(settings.layout)),
      );
    }, 450);
    return () => clearTimeout(timer);
  }, [layout, onSaveSettings, resizing, settings.layout]);

  useEffect(() => {
    if (!narrow || (!mobileLeft && !mobileRight)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileLeft(false);
        setMobileRight(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileLeft, mobileRight, narrow]);

  const toggleLeft = useCallback(() => {
    if (narrow) {
      setMobileLeft((value) => !value);
      setMobileRight(false);
    } else {
      setLayout((current) => ({ ...current, leftOpen: !current.leftOpen }));
    }
  }, [narrow]);

  const toggleRight = useCallback(() => {
    if (narrow) {
      setMobileRight((value) => !value);
      setMobileLeft(false);
    } else {
      setLayout((current) => ({ ...current, rightOpen: !current.rightOpen }));
    }
  }, [narrow]);

  const setWidth = useCallback((side: "left" | "right", width: number) => {
    setLayout((current) =>
      side === "left"
        ? {
            ...current,
            leftWidth: clampWidth(width, MIN_LEFT, MAX_LEFT),
          }
        : {
            ...current,
            rightWidth: clampWidth(width, MIN_RIGHT, MAX_RIGHT),
          },
    );
  }, []);

  const activeSummary = sessions.find((session) => session.id === activeId);
  const leftVisible = narrow ? mobileLeft : layout.leftOpen;
  const rightVisible = narrow ? mobileRight : layout.rightOpen;
  const closeRight = useCallback(() => {
    if (narrow) setMobileRight(false);
    else setLayout((current) => ({ ...current, rightOpen: false }));
  }, [narrow]);

  const openArtifact = useCallback(
    (artifact: ChatArtifact) => {
      setArtifactRequest(artifact);
      setTab("artifacts");
      if (narrow) {
        setMobileLeft(false);
        setMobileRight(true);
      } else {
        setLayout((current) => ({ ...current, rightOpen: true }));
      }
    },
    [narrow],
  );

  const artifactRequestHandled = useCallback(() => setArtifactRequest(null), []);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg">
      <a
        href="#transcript"
        className="sr-only z-[60] rounded-md bg-popover px-3 py-2 text-[12px] text-ink shadow-popover focus:not-sr-only focus:absolute focus:left-2 focus:top-2"
      >
        Skip to conversation
      </a>

      {!narrow && layout.leftOpen ? (
        <>
          <motion.aside
            initial={false}
            animate={{ width: layout.leftWidth }}
            transition={resizing ? { duration: 0 } : widthTransition}
            className="material hairline-r flex-none overflow-hidden"
          >
            <SessionsPanel
              sessions={sessions}
              activeId={activeId}
              onSelect={onSelect}
              onCreated={onCreated}
            />
          </motion.aside>
          <SplitHandle
            side="left"
            value={layout.leftWidth}
            min={MIN_LEFT}
            max={MAX_LEFT}
            defaultValue={DEFAULT_LEFT}
            label="Resize session list"
            onChange={(width) => setWidth("left", width)}
            onDragChange={setResizing}
          />
        </>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatPanel
          sessionId={activeId}
          summary={activeSummary}
          engine={engine}
          leftOpen={leftVisible}
          rightOpen={rightVisible}
          onToggleLeft={toggleLeft}
          onToggleRight={toggleRight}
          onCreateSession={onCreateSession}
          onCreated={onCreated}
          onOpenArtifact={openArtifact}
        />
      </main>

      {!narrow && layout.rightOpen ? (
        <>
          <SplitHandle
            side="right"
            value={layout.rightWidth}
            min={MIN_RIGHT}
            max={MAX_RIGHT}
            defaultValue={DEFAULT_RIGHT}
            label="Resize controls"
            onChange={(width) => setWidth("right", width)}
            onDragChange={setResizing}
          />
          <motion.aside
            initial={false}
            animate={{ width: layout.rightWidth }}
            transition={resizing ? { duration: 0 } : widthTransition}
            className="material hairline-l flex-none overflow-hidden"
          >
            <RightPanel
              tab={tab}
              onTabChange={setTab}
              settings={settings}
              providers={providers}
              engine={engine}
              engineRefreshing={engineRefreshing}
              onRefreshEngine={onRefreshEngine}
              onSaveSettings={onSaveSettings}
              initialSkills={initialSkills}
              initialMcpServers={initialMcpServers}
              initialArtifacts={initialArtifacts}
              workspace={workspace}
              onClose={closeRight}
              artifactRequest={artifactRequest}
              onArtifactRequestHandled={artifactRequestHandled}
            />
          </motion.aside>
        </>
      ) : null}

      <AnimatePresence>
        {narrow && mobileLeft ? (
          <motion.div
            key="left-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-scrim"
            onClick={() => setMobileLeft(false)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {narrow && mobileLeft ? (
          <motion.aside
            key="left-panel"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={overlayTransition}
            className="material hairline-r fixed inset-y-0 left-0 z-50 w-[min(88vw,340px)]"
          >
            <SessionsPanel
              sessions={sessions}
              activeId={activeId}
              onSelect={onSelect}
              onCreated={onCreated}
              onNavigate={() => setMobileLeft(false)}
            />
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {narrow && mobileRight ? (
          <motion.div
            key="right-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-scrim"
            onClick={() => setMobileRight(false)}
          />
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {narrow && mobileRight ? (
          <motion.aside
            key="right-panel"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={overlayTransition}
            className="material hairline-l fixed inset-y-0 right-0 z-50 w-[min(92vw,400px)]"
          >
            <RightPanel
              tab={tab}
              onTabChange={setTab}
              settings={settings}
              providers={providers}
              engine={engine}
              engineRefreshing={engineRefreshing}
              onRefreshEngine={onRefreshEngine}
              onSaveSettings={onSaveSettings}
              initialSkills={initialSkills}
              initialMcpServers={initialMcpServers}
              initialArtifacts={initialArtifacts}
              workspace={workspace}
              onClose={closeRight}
              artifactRequest={artifactRequest}
              onArtifactRequestHandled={artifactRequestHandled}
            />
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function RightPanel({
  tab,
  onTabChange,
  settings,
  providers,
  engine,
  engineRefreshing,
  onRefreshEngine,
  onSaveSettings,
  initialSkills,
  initialMcpServers,
  initialArtifacts,
  workspace,
  onClose,
  artifactRequest,
  onArtifactRequestHandled,
}: {
  tab: string;
  onTabChange: (value: string) => void;
  settings: SettingsView;
  providers: ProviderCatalogView;
  engine: EngineStatusView | undefined;
  engineRefreshing: boolean;
  onRefreshEngine: () => void;
  onSaveSettings: (patch: SettingsPatch) => Promise<SettingsView>;
  initialSkills: SkillView[];
  initialMcpServers: McpServerView[];
  initialArtifacts: ArtifactView[];
  workspace: WorkspaceStatusView;
  onClose: () => void;
  artifactRequest: ChatArtifact | null;
  onArtifactRequestHandled: () => void;
}) {
  return (
    <Tabs value={tab} onValueChange={onTabChange} className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2 px-3 py-2.5 hairline-b">
        <TabsList
          label="Control panels"
          className="grid flex-1 grid-cols-3 gap-0.5 rounded-card p-0.5"
        >
          <TabsTrigger value="settings" className="justify-center px-1">
            <Settings2 size={12.5} strokeWidth={2} />
            Settings
          </TabsTrigger>
          <TabsTrigger value="engine" className="justify-center px-1">
            <Activity size={12.5} strokeWidth={2} />
            Engine
          </TabsTrigger>
          <TabsTrigger value="skills" className="justify-center px-1">
            <Puzzle size={12.5} strokeWidth={2} />
            Skills
          </TabsTrigger>
          <TabsTrigger value="mcp" className="justify-center px-1">
            <Blocks size={12.5} strokeWidth={2} />
            MCP
          </TabsTrigger>
          <TabsTrigger value="workspace" className="justify-center px-1">
            <FolderGit2 size={12.5} strokeWidth={2} />
            Workspace
          </TabsTrigger>
          <TabsTrigger value="artifacts" className="justify-center px-1">
            <Boxes size={12.5} strokeWidth={2} />
            Artifacts
          </TabsTrigger>
        </TabsList>
        <Tooltip content="Hide controls">
          <Button variant="ghost" size="icon-sm" aria-label="Hide controls" onClick={onClose}>
            <X size={14} strokeWidth={2} />
          </Button>
        </Tooltip>
      </div>
      <TabsContent
        value="settings"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <SettingsPanel settings={settings} providers={providers} onSave={onSaveSettings} />
      </TabsContent>
      <TabsContent
        value="engine"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <EnginePanel
          engine={engine}
          refreshing={engineRefreshing}
          onRefresh={onRefreshEngine}
        />
      </TabsContent>
      <TabsContent
        value="skills"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <SkillsPanel workDir={settings.cwd} initialSkills={initialSkills} />
      </TabsContent>
      <TabsContent
        value="mcp"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <McpPanel initialServers={initialMcpServers} />
      </TabsContent>
      <TabsContent
        value="workspace"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <WorkspacePanel initialStatus={workspace} />
      </TabsContent>
      <TabsContent
        value="artifacts"
        className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
      >
        <ArtifactsPanel
          initialArtifacts={initialArtifacts}
          request={artifactRequest}
          onRequestHandled={onArtifactRequestHandled}
        />
      </TabsContent>
    </Tabs>
  );
}

function SplitHandle({
  side,
  value,
  min,
  max,
  defaultValue,
  label,
  onChange,
  onDragChange,
}: {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  label: string;
  onChange: (width: number) => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const drag = useRef<{
    startX: number;
    startValue: number;
    active: boolean;
    pointerId: number;
    node: HTMLDivElement;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("select-none", "cursor-col-resize");
    return () => {
      document.body.classList.remove("select-none", "cursor-col-resize");
    };
  }, [dragging]);

  const finish = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    onDragChange(false);
    if (current) {
      try {
        current.node.releasePointerCapture(current.pointerId);
      } catch {
        // pointer capture may already be released
      }
    }
  }, [onDragChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const node = event.currentTarget;
    node.setPointerCapture(event.pointerId);
    drag.current = {
      startX: event.clientX,
      startValue: value,
      active: false,
      pointerId: event.pointerId,
      node,
    };
    const onEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !drag.current) return;
      onChange(drag.current.startValue);
      finish();
      window.removeEventListener("keydown", onEscape);
    };
    window.addEventListener("keydown", onEscape);
    const cleanup = () => {
      window.removeEventListener("keydown", onEscape);
      node.removeEventListener("pointerup", cleanup);
      node.removeEventListener("pointercancel", cleanup);
    };
    node.addEventListener("pointerup", cleanup);
    node.addEventListener("pointercancel", cleanup);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const delta = event.clientX - current.startX;
    if (!current.active) {
      if (Math.abs(delta) < 4) return;
      current.active = true;
      setDragging(true);
      onDragChange(true);
    }
    const raw = side === "left" ? current.startValue + delta : current.startValue - delta;
    onChange(clampWidth(raw, min, max));
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    finish();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = keyboardStep(window.innerWidth);
    let next: number | null = null;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "ArrowRight")
      next = value + (side === "left" ? step : -step);
    else if (event.key === "ArrowLeft")
      next = value + (side === "left" ? -step : step);
    if (next === null) return;
    event.preventDefault();
    onChange(clampWidth(next, min, max));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={onKeyDown}
      className={cx(
        "group relative w-2 flex-none cursor-col-resize touch-none focus-visible:outline-none focus-visible:shadow-focus",
        side === "left" ? "-ml-1" : "-mr-1",
      )}
    >
      <span
        className={cx(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 ease-out-expo",
          dragging ? "bg-accent" : "bg-line group-hover:bg-line-strong",
        )}
      />
      <span
        className={cx(
          "absolute left-1/2 top-1/2 h-7 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-line-strong transition-[opacity,transform] duration-150 ease-out-expo group-hover:opacity-100",
          dragging ? "scale-y-110 opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function sameLayout(
  a: { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number },
  b: { leftOpen: boolean; rightOpen: boolean; leftWidth: number; rightWidth: number },
): boolean {
  return (
    a.leftOpen === b.leftOpen &&
    a.rightOpen === b.rightOpen &&
    a.leftWidth === b.leftWidth &&
    a.rightWidth === b.rightWidth
  );
}
