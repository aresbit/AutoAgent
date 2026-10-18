import { Code2, Eye, FileCode2, PanelRight } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, CodeBlock } from "@/cds";
import { ArtifactFrame } from "@/features/artifacts/ArtifactFrame";
import {
  artifactTitle,
  byteSize,
  formatBytes,
  type ChatArtifact,
} from "@/features/artifacts/logic";

export function Markdown({
  text,
  onOpenArtifact,
}: {
  text: string;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            const child = Children.toArray(children)[0];
            if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
              return <pre>{children}</pre>;
            }
            const language = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? "text";
            const code = String(child.props.children ?? "").replace(/\n$/, "");
            if (language === "artifact-html") {
              return <ArtifactCard html={code} onOpenArtifact={onOpenArtifact} />;
            }
            return <CodeBlock code={code} language={language} />;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="scroll-area overflow-x-auto">
                <table>{children}</table>
              </div>
            );
          },
          img({ src, alt }) {
            return <img src={src} alt={alt ?? ""} className="max-w-full rounded-lg" />;
          },
          input({ checked, ...props }) {
            return <input type="checkbox" checked={checked} disabled readOnly {...props} />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A chat artifact card. The HTML is never inserted into the chat DOM: the
 * optional inline preview goes through the sandboxed ArtifactFrame, and the
 * panel action hands the source to the artifacts panel.
 */
function ArtifactCard({
  html,
  onOpenArtifact,
}: {
  html: string;
  onOpenArtifact?: (artifact: ChatArtifact) => void;
}) {
  const [preview, setPreview] = useState(false);
  const title = artifactTitle(html);
  const size = formatBytes(byteSize(html));

  return (
    <div
      className="overflow-hidden rounded-xl bg-panel shadow-panel"
      data-testid="chat-artifact-card"
    >
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-panel-2 text-ink-2">
          <FileCode2 size={13} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-medium text-ink" title={title}>
            {title}
          </p>
          <p className="text-[10.5px] text-ink-3">
            <span className="uppercase tracking-[0.06em]">HTML artifact</span>
            <span className="t-num"> · {size}</span>
          </p>
        </div>
        <div className="flex flex-none items-center gap-1">
          <Button
            variant={preview ? "soft" : "ghost"}
            size="xs"
            aria-pressed={preview}
            onClick={() => setPreview((value) => !value)}
          >
            <Eye size={11} strokeWidth={2} />
            Preview
          </Button>
          {onOpenArtifact ? (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => onOpenArtifact({ title, html })}
            >
              <PanelRight size={11} strokeWidth={2} />
              Open panel
            </Button>
          ) : null}
        </div>
      </div>
      {preview ? (
        <div className="px-2 pb-2">
          <ArtifactFrame html={html} title={title} minHeight={200} maxHeight={360} />
        </div>
      ) : null}
      {preview ? (
        <p className="flex items-center gap-1.5 px-3 pb-2 text-[10.5px] text-ink-3">
          <Code2 size={10} strokeWidth={2} />
          Static preview — open panel for interactive.
        </p>
      ) : null}
    </div>
  );
}
