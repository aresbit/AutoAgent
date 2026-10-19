import { AlertTriangle } from "lucide-react";
import { diffCounts, diffLineKind } from "@/features/workspace/logic";
import { cx } from "@/lib/cx";

/**
 * Unified artifact diff. Lines are classified with the same rules as the
 * workspace diff viewer so the two panels stay visually consistent.
 */
export function DiffViewer({
  patch,
  truncated = false,
  from,
  to,
}: {
  patch: string;
  truncated?: boolean;
  from?: string;
  to?: string;
}) {
  const counts = diffCounts(patch);
  const lines = patch.length === 0 ? [] : patch.split("\n");

  return (
    <div
      data-testid="artifact-diff"
      className="overflow-hidden rounded-card bg-code shadow-panel"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line/40 px-2.5 py-1.5">
        {from || to ? (
          <span className="t-code text-[10.5px] text-code-muted">
            {from ?? "?"} → {to ?? "?"}
          </span>
        ) : null}
        <span className="t-num text-[10.5px] text-ok">+{counts.additions}</span>
        <span className="t-num text-[10.5px] text-bad">-{counts.deletions}</span>
        <span className="ml-auto text-[10.5px] text-code-muted">
          unified diff
        </span>
      </div>

      {truncated ? (
        <p
          role="status"
          className="flex items-center gap-1.5 border-b border-line/40 px-2.5 py-1.5 text-[10.5px] text-warn"
        >
          <AlertTriangle size={11} strokeWidth={2} />
          The diff was truncated; only the first part is shown.
        </p>
      ) : null}

      {lines.length === 0 ? (
        <p className="px-2.5 py-3 text-[11.5px] text-code-muted">
          These versions have no textual differences.
        </p>
      ) : (
        <pre className="t-code scroll-area max-h-[420px] overflow-auto pb-2 text-[11px] leading-[1.55]">
          {lines.map((line, index) => {
            const kind = diffLineKind(line);
            return (
              <span
                key={index}
                data-kind={kind}
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
      )}
    </div>
  );
}
