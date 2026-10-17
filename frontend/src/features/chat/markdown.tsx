import { Code2, Eye } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, CodeBlock } from "@/cds";

export function Markdown({ text }: { text: string }) {
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
            if (language === "html" || language === "artifact-html") {
              return <ArtifactPreview code={code} />;
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

function ArtifactPreview({ code }: { code: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="overflow-hidden rounded-xl bg-panel shadow-panel">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-3">
          Artifact
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={mode === "preview" ? "soft" : "ghost"}
            size="xs"
            onClick={() => setMode("preview")}
          >
            <Eye size={11} strokeWidth={2} />
            Preview
          </Button>
          <Button
            variant={mode === "source" ? "soft" : "ghost"}
            size="xs"
            onClick={() => setMode("source")}
          >
            <Code2 size={11} strokeWidth={2} />
            Source
          </Button>
        </div>
      </div>
      {mode === "preview" ? (
        <iframe
          title="Artifact preview"
          sandbox=""
          srcDoc={code}
          className="h-64 w-full bg-panel"
        />
      ) : (
        <div className="p-2">
          <CodeBlock code={code} language="html" maxHeight={320} />
        </div>
      )}
    </div>
  );
}
