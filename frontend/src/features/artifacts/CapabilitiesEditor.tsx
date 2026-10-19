import { useState } from "react";
import { api } from "@/api/client";
import type { ArtifactView } from "@/api/types";
import { Badge, Button, Input, SectionLabel } from "@/cds";
import { errorMessage } from "@/lib/errorMessage";

/**
 * Permanent grant path for an artifact's MCP tools.
 *
 * The bridge enforces a strict allowlist: an artifact may only call tools that
 * are declared here. "Always allow" in the consent dialog is a session-only
 * grant and intentionally does not rewrite this list.
 */
export function CapabilitiesEditor({
  artifact,
  onChange,
}: {
  artifact: ArtifactView;
  onChange: (next: ArtifactView) => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tools = artifact.mcpTools ?? [];

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.updateArtifactCapabilities(artifact.id, next));
    } catch (cause) {
      setError(errorMessage(cause, "The tool capabilities could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const name = draft.trim();
    if (!name || tools.includes(name)) return;
    setDraft("");
    void save([...tools, name]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel>Tool capabilities</SectionLabel>
      <p className="text-[10.5px] leading-relaxed text-ink-3">
        Only these MCP tools may be called by the artifact. Every call still asks
        for consent in the host.
      </p>
      <div className="flex flex-wrap gap-1">
        {tools.length === 0 ? (
          <span className="text-[10.5px] text-ink-3">No tools granted.</span>
        ) : (
          tools.map((tool) => (
            <Badge key={tool} tone="neutral">
              <span className="t-code text-[10.5px]">{tool}</span>
              <button
                type="button"
                aria-label={`Remove ${tool}`}
                disabled={saving}
                onClick={() => void save(tools.filter((item) => item !== tool))}
                className="ml-1 rounded-full px-0.5 text-ink-3 transition-colors hover:text-bad focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
              >
                ×
              </button>
            </Badge>
          ))
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="tool_name"
          disabled={saving}
          aria-label="Add a tool capability"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={saving || !draft.trim() || tools.includes(draft.trim())}
        >
          Add
        </Button>
      </div>
      {saving ? (
        <span className="text-[10.5px] text-ink-3">Saving capabilities…</span>
      ) : null}
      {error ? (
        <p role="alert" className="text-[10.5px] leading-relaxed text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
