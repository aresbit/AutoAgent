import { ShieldAlert } from "lucide-react";
import { Button, Dialog } from "@/cds";
import type { ConsentDecision, ParsedToolCall } from "./bridge";

function previewArguments(args: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(args, null, 2);
    if (!text || text === "{}") return "(no arguments)";
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
  } catch {
    return "(arguments could not be displayed)";
  }
}

export function ToolConsentDialog({
  request,
  allowExternal = false,
  busy = false,
  error = null,
  onDecision,
}: {
  request: ParsedToolCall | null;
  allowExternal?: boolean;
  busy?: boolean;
  error?: string | null;
  onDecision: (decision: ConsentDecision) => void;
}) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onDecision("deny");
      }}
      title="Approve tool call"
      description={
        request
          ? `The sandboxed artifact is requesting the "${request.name}" tool through the local backend.`
          : undefined
      }
      width={520}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDecision("deny")}
          >
            Deny
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onDecision("once")}
          >
            Allow once
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy}
            onClick={() => onDecision("always")}
          >
            Always allow this session
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-lg bg-warn/10 px-2.5 py-2">
          <ShieldAlert size={14} strokeWidth={2} className="mt-0.5 flex-none text-warn" />
          <p className="text-[11.5px] leading-relaxed text-ink-2">
            Only approve tools you trust. The artifact runs in an opaque-origin
            sandbox; this call is mediated by the host and may read data or make
            changes outside the frame.
            {allowExternal
              ? " External access was granted for this artifact."
              : " The artifact itself cannot reach the network."}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-ink-2">Tool</span>
          <code className="t-code rounded-md bg-panel-2 px-2 py-1.5 text-[11.5px] text-ink">
            {request?.name ?? ""}
          </code>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-ink-2">Arguments</span>
          <pre className="t-code scroll-area max-h-56 overflow-auto rounded-md bg-code px-2.5 py-2 text-[11px] leading-relaxed text-code-ink">
            {request ? previewArguments(request.args) : ""}
          </pre>
        </div>

        {error ? (
          <p role="alert" className="text-[11.5px] leading-relaxed text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
