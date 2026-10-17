import type { SkillView } from "@/api/client";

export type SkillFilter = "all" | "enabled" | "system" | "project";

export function filterSkills(
  skills: SkillView[],
  query: string,
  filter: SkillFilter,
): SkillView[] {
  const needle = query.trim().toLowerCase();
  return skills
    .filter((skill) => {
      if (filter === "enabled" && !skill.enabled) return false;
      if ((filter === "system" || filter === "project") && skill.source !== filter) {
        return false;
      }
      if (!needle) return true;
      return (
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function applySkillToggle(
  skills: SkillView[],
  name: string,
  enabled: boolean,
): SkillView[] {
  return skills.map((skill) =>
    skill.name === name ? { ...skill, enabled } : skill,
  );
}

export function skillCounts(skills: SkillView[]): {
  total: number;
  enabled: number;
} {
  return {
    total: skills.length,
    enabled: skills.filter((skill) => skill.enabled).length,
  };
}
