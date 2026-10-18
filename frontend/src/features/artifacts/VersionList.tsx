import { RotateCcw } from "lucide-react";
import type { ArtifactVersionView } from "@/api/types";
import { Badge, Button } from "@/cds";
import { versionLabel, shortSha } from "./logic";

export function ArtifactVersionList({
  versions,
  canRestore = false,
  restoringVersion = null,
  onRestore,
}: {
  versions: ArtifactVersionView[];
  canRestore?: boolean;
  restoringVersion?: string | null;
  onRestore?: (versionId: string) => void;
}) {
  if (versions.length === 0) {
    return <p className="text-[11px] text-ink-3">No versions recorded.</p>;
  }

  return (
    <ul aria-label="Artifact versions" className="flex flex-col gap-1">
      {versions.map((item) => (
        <li
          key={item.versionId}
          className="flex min-w-0 items-center gap-2 rounded-md bg-panel-2 px-2 py-1.5"
        >
          <span className="t-num min-w-0 flex-1 truncate text-[11.5px] text-ink">
            {versionLabel(item.createdAt)}
          </span>
          {item.sha256 ? (
            <code
              className="t-code flex-none text-[10.5px] text-ink-3"
              title={`sha256 ${item.sha256}`}
            >
              {shortSha(item.sha256)}
            </code>
          ) : null}
          {item.current ? <Badge tone="accent">current</Badge> : null}
          {!item.current && canRestore && onRestore ? (
            <Button
              variant="ghost"
              size="xs"
              aria-label={`Restore version ${versionLabel(item.createdAt)}`}
              loading={restoringVersion === item.versionId}
              onClick={() => onRestore(item.versionId)}
            >
              <RotateCcw size={10} strokeWidth={2} />
              Restore
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
