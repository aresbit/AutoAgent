import { useQuery } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { api } from "@/api/client";
import type { ArtifactVersionView } from "@/api/types";
import { Select } from "@/cds";
import { cx } from "@/lib/cx";
import { ArtifactFrame } from "./ArtifactFrame";
import type { FrameRef } from "./bridge";
import { versionLabel } from "./logic";

const MIN_SPLIT = 20;
const MAX_SPLIT = 80;

export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return 50;
  return Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, percent));
}

/**
 * Transparent overlay shown while the divider is dragged. Without it the
 * iframe would capture the pointer once the cursor crosses its bounds, and
 * the drag would stall.
 */
export function SplitShield({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      data-testid="split-shield"
      aria-hidden
      className="absolute inset-0 z-30 cursor-col-resize"
    />
  );
}

function VersionSelect({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: string;
  versions: ArtifactVersionView[];
  onChange: (versionId: string) => void;
}) {
  return (
    <label className="flex w-full min-w-0 items-center gap-1.5">
      <span className="flex-none text-[10.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
        {label}
      </span>
      <Select
        aria-label={`${label} version`}
        value={value}
        className="h-7 min-w-0 text-[11px]"
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.versionId} value={version.versionId}>
            {version.versionId} · {versionLabel(version.createdAt)}
          </option>
        ))}
      </Select>
    </label>
  );
}

export interface ArtifactSplitPaneProps {
  artifactId: string;
  versions: ArtifactVersionView[];
  leftVersion: string;
  rightVersion: string;
  onLeftVersionChange: (versionId: string) => void;
  onRightVersionChange: (versionId: string) => void;
  /** Fallback srcdoc when a version frame token is unavailable (mock/dev). */
  fallbackHtml?: string;
  leftFrameRef?: FrameRef;
  rightFrameRef?: FrameRef;
}

export function ArtifactSplitPane({
  artifactId,
  versions,
  leftVersion,
  rightVersion,
  onLeftVersionChange,
  onRightVersionChange,
  fallbackHtml = "",
  leftFrameRef,
  rightFrameRef,
}: ArtifactSplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);

  const leftToken = useQuery({
    queryKey: ["artifact-frame-token", artifactId, leftVersion],
    queryFn: () => api.artifactFrameToken(artifactId, leftVersion),
    enabled: Boolean(artifactId && leftVersion),
    retry: false,
  });
  const rightToken = useQuery({
    queryKey: ["artifact-frame-token", artifactId, rightVersion],
    queryFn: () => api.artifactFrameToken(artifactId, rightVersion),
    enabled: Boolean(artifactId && rightVersion),
    retry: false,
  });

  const updateFromPointer = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setSplit(clampSplit(((clientX - rect.left) / rect.width) * 100));
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
    updateFromPointer(event.clientX);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => updateFromPointer(event.clientX);
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, updateFromPointer]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplit((value) => clampSplit(value - 2));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplit((value) => clampSplit(value + 2));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSplit(MIN_SPLIT);
    } else if (event.key === "End") {
      event.preventDefault();
      setSplit(MAX_SPLIT);
    }
  };

  const leftLabel =
    versions.find((item) => item.versionId === leftVersion)?.versionId ?? "older";
  const rightLabel =
    versions.find((item) => item.versionId === rightVersion)?.versionId ?? "newer";

  return (
    <div
      ref={containerRef}
      data-testid="artifact-split"
      className={cx(
        "relative flex min-h-[340px] items-stretch overflow-hidden rounded-card bg-panel-2",
        dragging && "select-none",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5 p-1.5" style={{ width: `${split}%` }}>
        <VersionSelect
          label="From"
          value={leftVersion}
          versions={versions}
          onChange={onLeftVersionChange}
        />
        <ArtifactFrame
          html={fallbackHtml}
          title={`${leftLabel} (left)`}
          frameUrl={leftToken.data?.url}
          frameRef={leftFrameRef}
          minHeight={300}
          maxHeight={360}
          className="flex-1"
        />
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize comparison panes"
        aria-valuemin={MIN_SPLIT}
        aria-valuemax={MAX_SPLIT}
        aria-valuenow={Math.round(split)}
        tabIndex={0}
        data-testid="split-divider"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cx(
          "z-10 flex w-1.5 flex-none cursor-col-resize items-center justify-center bg-line/60",
          "focus-visible:outline-none focus-visible:shadow-focus",
          dragging && "bg-accent/40",
        )}
      >
        <GripVertical size={10} strokeWidth={2} className="text-ink-3" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <VersionSelect
          label="To"
          value={rightVersion}
          versions={versions}
          onChange={onRightVersionChange}
        />
        <ArtifactFrame
          html={fallbackHtml}
          title={`${rightLabel} (right)`}
          frameUrl={rightToken.data?.url}
          frameRef={rightFrameRef}
          minHeight={300}
          maxHeight={360}
          className="flex-1"
        />
      </div>

      <SplitShield active={dragging} />
    </div>
  );
}
