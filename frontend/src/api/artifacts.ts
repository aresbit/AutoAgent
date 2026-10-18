import type { ArtifactVersionView } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Normalize the backend `ArtifactVersionsView` (and tolerate the legacy
 * timestamp-only metadata shape). The current version is inferred from the
 * newest entry unless the caller knows the artifact revision.
 */
export function normalizeArtifactVersions(
  payload: unknown,
  currentVersionId?: string,
): ArtifactVersionView[] {
  const record = asRecord(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.versions)
      ? (record?.versions as unknown[])
      : [];

  const versions = raw.flatMap((item): ArtifactVersionView[] => {
    if (typeof item === "number" && Number.isFinite(item)) {
      return [
        {
          versionId: String(item),
          createdAt: item,
          sha256: "",
          sizeBytes: null,
          current: false,
        },
      ];
    }
    const entry = asRecord(item);
    if (!entry) return [];
    const createdAt = firstNumber(entry, ["createdAt", "timestamp", "updatedAt"]);
    const versionId =
      firstString(entry, ["versionId", "version", "id"]) ||
      (createdAt === null ? "" : String(createdAt));
    if (!versionId || createdAt === null) return [];
    return [
      {
        versionId,
        createdAt,
        sha256: firstString(entry, ["sha256", "hash", "digest", "contentSha256"]),
        sizeBytes: firstNumber(entry, ["sizeBytes", "size", "bytes"]),
        current:
          currentVersionId !== undefined
            ? versionId === currentVersionId
            : entry.current === true || entry.isCurrent === true || entry.latest === true,
        source: firstString(entry, ["source"]) || undefined,
        immutable: entry.immutable === true,
      },
    ];
  });

  versions.sort((a, b) => b.createdAt - a.createdAt);
  const anyCurrent = versions.some((item) => item.current);
  if (!anyCurrent && versions.length > 0) versions[0] = { ...versions[0], current: true };
  return versions;
}

/** Timestamp-only fallback for an artifact whose versions endpoint is absent. */
export function fallbackArtifactVersions(versions: number[]): ArtifactVersionView[] {
  if (versions.length === 0) return [];
  const newest = Math.max(...versions);
  return [...versions]
    .sort((a, b) => b - a)
    .map((timestamp) => ({
      versionId: String(timestamp),
      createdAt: timestamp,
      sha256: "",
      sizeBytes: null,
      current: timestamp === newest,
    }));
}
