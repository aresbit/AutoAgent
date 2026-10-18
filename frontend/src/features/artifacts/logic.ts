import type { ArtifactView } from "@/api/client";

export interface ChatArtifact {
  title: string;
  html: string;
}

export function sortArtifacts(artifacts: ArtifactView[]): ArtifactView[] {
  return [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function newestVersion(artifact: ArtifactView): number | null {
  if (artifact.versions.length === 0) return null;
  return Math.max(...artifact.versions);
}

/**
 * Version total for display. The backend's `versionCount` is authoritative;
 * the legacy `versions` array may only contain timestamps and can be shorter
 * (or absent) for artifacts that expose version refs instead.
 */
export function artifactVersionCount(artifact: ArtifactView): number {
  return typeof artifact.versionCount === "number" &&
    Number.isFinite(artifact.versionCount)
    ? Math.max(0, artifact.versionCount)
    : artifact.versions.length;
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

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Best-effort title from the artifact's own document, then its first heading. */
export function artifactTitle(html: string, fallback = "HTML artifact"): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const candidate = textOf(title ?? heading ?? "");
  if (!candidate) return fallback;
  return candidate.length > 80 ? `${candidate.slice(0, 79)}…` : candidate;
}

export function byteSize(text: string): number {
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortSha(sha256: string): string {
  const value = sha256.trim();
  if (!value) return "";
  return value.length > 8 ? value.slice(0, 8) : value;
}
