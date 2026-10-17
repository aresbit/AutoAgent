import type { ChangedFileView } from "@/api/client";
import type { Tone } from "@/cds";

export function fileStatusTone(status: ChangedFileView["status"]): Tone {
  switch (status) {
    case "added":
    case "copied":
      return "ok";
    case "deleted":
      return "bad";
    case "renamed":
    case "type_changed":
      return "warn";
    case "modified":
      return "info";
    default:
      return "neutral";
  }
}

export function fileStatusLabel(status: ChangedFileView["status"]): string {
  switch (status) {
    case "type_changed":
      return "type";
    default:
      return status;
  }
}

export type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

export function diffCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
