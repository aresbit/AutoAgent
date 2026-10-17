import { describe, expect, it } from "vitest";
import type { ArtifactView, McpServerInput, SkillView } from "@/api/types";
import {
  applySkillToggle,
  filterSkills,
  skillCounts,
} from "@/features/skills/logic";
import {
  formatPairs,
  parseArgs,
  parsePairs,
  resultText,
  targetFor,
} from "@/features/mcp/logic";
import {
  diffCounts,
  diffLineKind,
  fileStatusTone,
} from "@/features/workspace/logic";
import { newestVersion, sortArtifacts, versionLabel } from "@/features/artifacts/logic";

const skill = (
  name: string,
  source: "system" | "project",
  enabled: boolean,
  description = "",
): SkillView => ({ name, description, source, enabled });

describe("skill panel logic", () => {
  const skills = [
    skill("zeta", "system", false, "Search the web"),
    skill("alpha", "project", true, "Design review"),
    skill("beta", "system", true, "PDF tools"),
  ];

  it("filters by query, source and enabled state", () => {
    expect(filterSkills(skills, "pdf", "all").map((item) => item.name)).toEqual(["beta"]);
    expect(filterSkills(skills, "", "project").map((item) => item.name)).toEqual(["alpha"]);
    expect(filterSkills(skills, "", "enabled").map((item) => item.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("sorts enabled skills first and then by name", () => {
    expect(filterSkills(skills, "", "all").map((item) => item.name)).toEqual([
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  it("applies a toggle without mutating the input", () => {
    const next = applySkillToggle(skills, "zeta", true);
    expect(next.find((item) => item.name === "zeta")?.enabled).toBe(true);
    expect(skills.find((item) => item.name === "zeta")?.enabled).toBe(false);
    expect(next.find((item) => item.name === "alpha")).toBe(
      skills.find((item) => item.name === "alpha"),
    );
  });

  it("counts the catalog", () => {
    expect(skillCounts(skills)).toEqual({ total: 3, enabled: 2 });
  });
});

describe("MCP panel logic", () => {
  it("parses and formats KEY=value lines", () => {
    expect(
      parsePairs("A=1\n# comment\n\nB = two words\ninvalid\n=empty-key"),
    ).toEqual({ A: "1", B: "two words" });
    expect(formatPairs({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });

  it("validates JSON arguments", () => {
    expect(parseArgs("")).toEqual({ ok: true, value: {} });
    expect(parseArgs('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseArgs("[1,2]")).toEqual({
      ok: false,
      error: "Arguments must be a JSON object.",
    });
    expect(parseArgs("{")).toEqual({
      ok: false,
      error: "Arguments must be valid JSON.",
    });
  });

  it("derives targets per transport", () => {
    const base: McpServerInput = {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: {},
      url: null,
      headers: {},
      enabled: true,
      autoRun: false,
    };
    expect(targetFor(base)).toBe("npx -y server");
    expect(targetFor({ ...base, transport: "http", command: null, args: [], url: "https://x" })).toBe(
      "https://x",
    );
  });

  it("extracts text from a tool result", () => {
    expect(resultText({ content: [{ type: "text", text: "ok" }] })).toBe("ok");
    expect(resultText({ error: "boom" })).toBe("boom");
    expect(resultText({ isError: true })).toBe('{\n  "isError": true\n}');
  });
});

describe("workspace panel logic", () => {
  it("classifies diff lines", () => {
    expect(diffLineKind("+++ b/file")).toBe("meta");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("remove");
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind(" context")).toBe("context");
  });

  it("counts additions and deletions without file headers", () => {
    const patch = [
      "--- a/file",
      "+++ b/file",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "+extra",
    ].join("\n");
    expect(diffCounts(patch)).toEqual({ additions: 2, deletions: 1 });
  });

  it("maps file status to a tone", () => {
    expect(fileStatusTone("added")).toBe("ok");
    expect(fileStatusTone("deleted")).toBe("bad");
    expect(fileStatusTone("modified")).toBe("info");
    expect(fileStatusTone("unknown")).toBe("neutral");
  });
});

describe("artifact panel logic", () => {
  const artifact = (id: string, updatedAt: number, versions: number[]): ArtifactView => ({
    id,
    title: id,
    description: "",
    createdAt: updatedAt,
    updatedAt,
    lastOpenedAt: null,
    versions,
    contentUrl: `/api/artifacts/${id}/content`,
    thumbnailUrl: null,
  });

  it("sorts by most recently updated", () => {
    const sorted = sortArtifacts([
      artifact("old", 1, []),
      artifact("new", 3, []),
      artifact("middle", 2, []),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["new", "middle", "old"]);
  });

  it("finds the newest version and handles none", () => {
    expect(newestVersion(artifact("a", 1, [4, 9, 6]))).toBe(9);
    expect(newestVersion(artifact("a", 1, []))).toBeNull();
  });

  it("formats a version timestamp", () => {
    expect(versionLabel(0)).toMatch(/\d/);
  });
});
