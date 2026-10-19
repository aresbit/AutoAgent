import { AlertTriangle, Code2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FrameRef } from "./bridge";
import { Button } from "@/cds";
import { cx } from "@/lib/cx";

/**
 * The only sandbox flags an artifact may have. `allow-same-origin`,
 * top-navigation, modals and popups are deliberately absent: with
 * `allow-scripts` the frame runs in an opaque origin and cannot reach the
 * host document, storage, cookies or the local API.
 */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms";

export const ARTIFACT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; font-src data:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

const CSP_META = `<meta data-autoagent-csp="1" http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

const RESIZE_SCRIPT =
  "<script data-autoagent-resize>(function(){" +
  "function post(){try{var d=document.documentElement;var b=document.body;" +
  'var h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0);' +
  'parent.postMessage({type:"autoagent:artifact-resize",height:h},"*");}catch(e){}}' +
  "function start(){post();" +
  'if(typeof ResizeObserver!=="undefined"){var ro=new ResizeObserver(post);' +
  "if(document.documentElement)ro.observe(document.documentElement);" +
  "if(document.body)ro.observe(document.body);}" +
  'window.addEventListener("load",post);setTimeout(post,0);setTimeout(post,150);}' +
  'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start);}else{start();}' +
  "})();</script>";

/**
 * Insert the strict CSP before any author markup so no artifact script can
 * run (or load a resource) before the policy is in effect.
 */
export function injectArtifactCsp(html: string): string {
  if (!html.trim()) return html;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
  }
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return `${html.slice(0, at)}${CSP_META}${html.slice(at)}`;
  }
  return `${CSP_META}${html}`;
}

/** Build the srcDoc: CSP first, then the host-owned resize reporter. */
export function buildArtifactDocument(html: string): string {
  const secured = injectArtifactCsp(html);
  if (!secured.trim()) return secured;
  const bodyClose = /<\/body\s*>/i.exec(secured);
  if (bodyClose) {
    return `${secured.slice(0, bodyClose.index)}${RESIZE_SCRIPT}${secured.slice(bodyClose.index)}`;
  }
  return `${secured}${RESIZE_SCRIPT}`;
}

/**
 * Clamp a resize report from the artifact frame. Only messages posted by the
 * frame's own window are accepted, and only the documented resize type.
 */
export function artifactFrameHeight(
  event: Pick<MessageEvent, "source" | "data"> | null | undefined,
  frame: Pick<HTMLIFrameElement, "contentWindow"> | null | undefined,
  minHeight: number,
  maxHeight: number,
): number | null {
  if (!event || !frame || event.source !== frame.contentWindow) return null;
  const data = event.data as { type?: unknown; height?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== "autoagent:artifact-resize") {
    return null;
  }
  if (typeof data.height !== "number" || !Number.isFinite(data.height)) return null;
  return Math.max(minHeight, Math.min(maxHeight, Math.ceil(data.height)));
}

export interface ArtifactFrameProps {
  html: string;
  title: string;
  className?: string;
  minHeight?: number;
  maxHeight?: number;
  /**
   * Backend-served frame document with its own CSP and injected resize
   * reporter. When absent (mock/dev), the frame falls back to `srcDoc`.
   */
  frameUrl?: string;
  /** Switch the surrounding viewer to its source tab. */
  onShowSource?: () => void;
  /** Expose the live iframe so the host bridge can validate message sources. */
  frameRef?: FrameRef;
}

export function ArtifactFrame({
  html,
  title,
  className,
  minHeight = 180,
  maxHeight = 480,
  frameUrl,
  onShowSource,
  frameRef: externalFrameRef,
}: ArtifactFrameProps) {
  const internalFrameRef = useRef<HTMLIFrameElement | null>(null);
  const frameRef = externalFrameRef ?? internalFrameRef;
  const [height, setHeight] = useState(minHeight);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [nonce, setNonce] = useState(0);

  const remote = Boolean(frameUrl);
  const srcDoc = useMemo(
    () => (remote ? "" : buildArtifactDocument(html)),
    [html, nonce, remote],
  );
  const empty = !remote && html.trim().length === 0;

  useEffect(() => {
    setLoaded(false);
    setErrored(empty);
    setHeight(minHeight);
  }, [frameUrl, srcDoc, empty, minHeight]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = artifactFrameHeight(event, frameRef.current, minHeight, maxHeight);
      if (next !== null) setHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [minHeight, maxHeight]);


  const retry = useCallback(() => {
    setErrored(false);
    setLoaded(false);
    setHeight(minHeight);
    setNonce((value) => value + 1);
  }, [minHeight]);

  if (empty || errored) {
    return (
      <div
        role="alert"
        className={cx(
          "flex flex-col items-center justify-center gap-2 rounded-card bg-panel-2 px-4 py-6 text-center",
          className,
        )}
      >
        <AlertTriangle size={16} strokeWidth={1.9} className="text-warn" />
        <p className="text-[12px] font-medium text-ink">Artifact preview unavailable</p>
        <p className="max-w-[38ch] text-[11px] leading-relaxed text-ink-3">
          {empty
            ? "This artifact has no content to render."
            : "The sandboxed preview could not be loaded."}
        </p>
        <div className="mt-1 flex items-center gap-1.5">
          <Button variant="secondary" size="xs" onClick={retry}>
            <RefreshCw size={11} strokeWidth={2} />
            Retry
          </Button>
          {onShowSource ? (
            <Button variant="ghost" size="xs" onClick={onShowSource}>
              <Code2 size={11} strokeWidth={2} />
              Source
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cx("relative overflow-hidden rounded-card bg-panel", className)}>
      {!loaded ? (
        <div className="absolute inset-x-0 top-0 z-10 flex h-7 items-center gap-1.5 bg-panel/90 px-2.5 text-[10.5px] text-ink-3">
          <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden />
          Loading sandboxed preview
        </div>
      ) : null}
      <iframe
        key={`${nonce}:${frameUrl ?? "srcdoc"}`}
        ref={frameRef}
        title={`${title} (sandboxed artifact)`}
        sandbox={ARTIFACT_SANDBOX}
        referrerPolicy="no-referrer"
        src={remote ? frameUrl : undefined}
        srcDoc={remote ? undefined : srcDoc}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        style={{ height }}
        className="block w-full border-0 bg-white"
      />
    </div>
  );
}
