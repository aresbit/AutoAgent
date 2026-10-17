import type { ArtifactView } from "@/api/client";

export function sortArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newestVersion(artifact: ArtifactView): number | null {
  if (artifact.versions.length === 0) return null;
  return Math.max(...artifact.versions);
}

export function versionLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function displayTitle(artifact: ArtifactView): string {
  return artifact.title.trim() || "Untitled artifact";
}
