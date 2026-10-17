import type {
  McpServerInput,
  McpToolInvokeResult,
  McpToolView,
  McpTransport,
} from "@/api/client";

export function parsePairs(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    result[key] = line.slice(index + 1).trim();
  }
  return result;
}

export function formatPairs(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseArgs(text: string): {
  ok: true;
  value: Record<string, unknown>;
} | {
  ok: false;
  error: string;
} {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Arguments must be a JSON object." };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Arguments must be valid JSON." };
  }
}

export function targetFor(input: McpServerInput): string {
  if (input.transport === "stdio") {
    return [input.command ?? "", ...input.args].filter(Boolean).join(" ");
  }
  return input.url ?? "";
}

export function resultText(result: McpToolInvokeResult): string {
  if (result.error) return result.error;
  const blocks = result.content ?? [];
  const text = blocks
    .filter((block) => typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  if (text) return text;
  return JSON.stringify(result, null, 2);
}

export function toolsOf(results: { name: string; tools: McpToolView[] }[], server: string): McpToolView[] {
  return results.find((result) => result.name === server)?.tools ?? [];
}

export function transportLabel(transport: McpTransport): string {
  if (transport === "stdio") return "stdio";
  if (transport === "http") return "HTTP";
  return "SSE";
}
