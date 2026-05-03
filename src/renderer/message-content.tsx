import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import mermaid from 'mermaid';

type JsonRecord = Record<string, unknown>;

interface ParsedArtifactDocument {
  title: string;
  description: string;
  html: string;
}

interface ArtifactReferencePayload {
  path?: string;
  title?: string;
  description?: string;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'code-stats'],
  attributes: {
    ...(defaultSchema.attributes || {}),
    a: [...((defaultSchema.attributes || {}).a || []), 'target', 'rel'],
    code: [...((defaultSchema.attributes || {}).code || []), 'className'],
    pre: [...((defaultSchema.attributes || {}).pre || []), 'className'],
    th: [...((defaultSchema.attributes || {}).th || []), 'align'],
    td: [...((defaultSchema.attributes || {}).td || []), 'align'],
    'code-stats': ['data-kind'],
  },
};

function safeJsonParse(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function collectMetrics(stats: JsonRecord): Array<{ label: string; value: string }> {
  const candidates: Array<[string, unknown, (value: unknown) => string | null]> = [
    ['Files', stats.filesChanged ?? stats.fileCount ?? stats.files, (value) => {
      const num = numberValue(value);
      return num == null ? null : String(num);
    }],
    ['Lines added', stats.linesAdded ?? stats.additions, (value) => {
      const num = numberValue(value);
      return num == null ? null : `+${num}`;
    }],
    ['Lines removed', stats.linesRemoved ?? stats.deletions, (value) => {
      const num = numberValue(value);
      return num == null ? null : `-${num}`;
    }],
    ['Commits', stats.commits, (value) => {
      const num = numberValue(value);
      return num == null ? null : String(num);
    }],
    ['Duration', stats.duration ?? stats.elapsed, (value) => stringValue(value)],
    ['Language', stats.language ?? stats.primaryLanguage, (value) => stringValue(value)],
  ];

  return candidates
    .map(([label, raw, formatter]) => {
      const value = formatter(raw);
      return value ? { label, value } : null;
    })
    .filter((item): item is { label: string; value: string } => Boolean(item));
}

function parseArtifactDocument(source: string): ParsedArtifactDocument {
  const raw = source.replace(/^\uFEFF/, '');
  const frontmatterMatch = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { title: 'Artifact', description: '', html: raw.trim() };
  }

  const metadata: Record<string, string> = {};
  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    metadata[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return {
    title: metadata.title?.trim() || 'Artifact',
    description: metadata.description?.trim() || '',
    html: frontmatterMatch[2].trim(),
  };
}

function parseArtifactReference(source: string): ArtifactReferencePayload | null {
  try {
    const parsed = JSON.parse(source) as ArtifactReferencePayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    const path = source.trim();
    return path ? { path } : null;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char));
}

function buildArtifactPreviewDocument(artifact: ParsedArtifactDocument, frameId: string): string {
  const isFullDocument = /<html[\s>]/i.test(artifact.html) || /<!doctype/i.test(artifact.html);
  const body = isFullDocument
    ? artifact.html
    : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeAttr(artifact.title)}</title>
  <style>
    :root {
      color-scheme: light dark;
      --color-background-primary: #ffffff;
      --color-background-secondary: #f8fafc;
      --color-background-tertiary: #eef2ff;
      --color-text-primary: #0f172a;
      --color-text-secondary: #475569;
      --color-text-tertiary: #64748b;
      --color-border-primary: rgba(100,116,139,0.35);
      --color-border-secondary: rgba(100,116,139,0.22);
      --color-border-tertiary: rgba(100,116,139,0.16);
      --color-border-info: #2563eb;
      --color-text-info: #1d4ed8;
      --color-background-info: #dbeafe;
      --font-sans: Inter, "Segoe UI", system-ui, sans-serif;
      --font-serif: "Iowan Old Style", Georgia, serif;
      --font-mono: "SFMono-Regular", Consolas, monospace;
      --border-radius-md: 8px;
      --border-radius-lg: 12px;
      --border-radius-xl: 16px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-background-primary: #0f172a;
        --color-background-secondary: #111827;
        --color-background-tertiary: #1e293b;
        --color-text-primary: #e2e8f0;
        --color-text-secondary: #cbd5e1;
        --color-text-tertiary: #94a3b8;
        --color-border-primary: rgba(148,163,184,0.35);
        --color-border-secondary: rgba(148,163,184,0.22);
        --color-border-tertiary: rgba(148,163,184,0.16);
        --color-border-info: #60a5fa;
        --color-text-info: #93c5fd;
        --color-background-info: rgba(37,99,235,0.16);
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: transparent; color: var(--color-text-primary); font-family: var(--font-sans); }
    body { padding: 12px; }
    a { color: var(--color-text-info); }
  </style>
</head>
<body>
${artifact.html}
</body>
</html>`;

  const resizeScript = `
<script>
(() => {
  const pending = new Map();
  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (!payload || payload.type !== 'autoagent-autowork-response' || payload.frameId !== '${frameId}') return;
    const resolver = pending.get(payload.requestId);
    if (!resolver) return;
    pending.delete(payload.requestId);
    if (payload.ok) resolver.resolve(payload.result);
    else resolver.reject(new Error(payload.error || 'Autowork bridge request failed'));
  });
  const request = (method, payload) => new Promise((resolve, reject) => {
    const requestId = Math.random().toString(36).slice(2);
    pending.set(requestId, { resolve, reject });
    parent.postMessage({ type: 'autoagent-autowork-request', frameId: '${frameId}', requestId, method, payload }, '*');
  });
  const bridge = {
    callMcpTool: (name, args) => request('callMcpTool', { name, args }),
    askClaude: (prompt, data) => request('askClaude', { prompt, data }),
    sample: (prompt, data) => request('askClaude', { prompt, data }),
    runScheduledTask: (taskId) => request('runScheduledTask', { taskId }),
    navigateHost: (direction) => request('navigateHost', { direction }),
    openExternalUrl: (url) => request('openExternalUrl', { url }),
  };
  window.autowork = bridge;
  window.cowork = bridge;
  const postSize = () => {
    const root = document.documentElement;
    const body = document.body;
    const height = Math.max(
      root ? root.scrollHeight : 0,
      root ? root.offsetHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    );
    parent.postMessage({ type: 'autoagent-artifact-height', frameId: '${frameId}', height }, '*');
  };
  const run = () => {
    postSize();
    requestAnimationFrame(postSize);
    setTimeout(postSize, 120);
    setTimeout(postSize, 600);
  };
  window.addEventListener('load', run);
  window.addEventListener('resize', postSize);
  new MutationObserver(postSize).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  run();
})();
</script>`;

  return /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${resizeScript}\n</body>`) : `${body}\n${resizeScript}`;
}

function CodeStatsBlock({ children }: { children?: React.ReactNode }) {
  const rawText = React.useMemo(() => React.Children.toArray(children).join('').trim(), [children]);
  const stats = React.useMemo(() => safeJsonParse(rawText), [rawText]);

  if (!stats) {
    return (
      <div className="code-stats-card">
        <strong>Code stats</strong>
        <pre>{rawText || 'No stats available'}</pre>
      </div>
    );
  }

  const title = stringValue(stats.title) || 'Code stats';
  const summary = stringValue(stats.summary);
  const metrics = collectMetrics(stats);

  return (
    <section className="code-stats-card">
      <div className="code-stats-head">
        <strong>{title}</strong>
        {summary ? <span>{summary}</span> : null}
      </div>
      {metrics.length ? (
        <div className="code-stats-grid">
          {metrics.map((metric) => (
            <div key={metric.label} className="code-stats-metric">
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
      <details>
        <summary>Raw payload</summary>
        <pre>{JSON.stringify(stats, null, 2)}</pre>
      </details>
    </section>
  );
}

function CodeBlock(props: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode; className?: string }) {
  const className = props.className || '';
  const language = className.startsWith('language-') ? className.slice('language-'.length) : '';
  const text = React.Children.toArray(props.children).join('');

  return (
    <div className="code-block">
      {language ? <div className="code-block-label">{language}</div> : null}
      <code className={className}>{text.replace(/\n$/, '')}</code>
    </div>
  );
}

function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = React.useState('');
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    const render = async () => {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const result = await mermaid.render(`autoagent-mermaid-${Math.random().toString(36).slice(2)}`, chart);
        if (!cancelled) {
          setSvg(result.svg);
          setError('');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg('');
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className="mermaid-card error">
        <strong>Mermaid render failed</strong>
        <pre>{error}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-card">Rendering Mermaid diagram...</div>;
  }

  return <div className="mermaid-card" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ArtifactBlock({
  source,
  onCreateArtifact,
}: {
  source: string;
  onCreateArtifact?: (input: { title?: string; description?: string; html: string }) => Promise<{ path?: string } | void>;
}) {
  const artifact = React.useMemo(() => parseArtifactDocument(source), [source]);
  const frameId = React.useId().replace(/:/g, '-');
  const srcDoc = React.useMemo(() => buildArtifactPreviewDocument(artifact, frameId), [artifact, frameId]);
  const [frameHeight, setFrameHeight] = React.useState(360);
  const [opening, setOpening] = React.useState(false);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; frameId?: string; height?: number; requestId?: string; method?: string; payload?: any } | null;
      if (payload?.type === 'autoagent-artifact-height' && payload.frameId === frameId) {
        const nextHeight = typeof payload.height === 'number' ? Math.max(180, Math.min(Math.ceil(payload.height) + 8, 1400)) : null;
        if (nextHeight) setFrameHeight(nextHeight);
        return;
      }
      if (payload?.type !== 'autoagent-autowork-request' || payload.frameId !== frameId) return;
      const source = event.source as Window | null;
      if (!source || !payload.requestId) return;
      (async () => {
        try {
          let result: unknown;
          if (payload.method === 'callMcpTool') result = await window.autoagent.autoworkCallMcpTool(payload.payload);
          else if (payload.method === 'askClaude') result = await window.autoagent.autoworkAskClaude(payload.payload);
          else if (payload.method === 'runScheduledTask') result = await window.autoagent.autoworkRunScheduledTask(payload.payload);
          else if (payload.method === 'navigateHost') result = await window.autoagent.autoworkNavigateHost(payload.payload);
          else if (payload.method === 'openExternalUrl') result = await window.autoagent.autoworkOpenExternalUrl(payload.payload);
          else throw new Error(`Unknown autowork method: ${payload.method}`);
          source.postMessage({ type: 'autoagent-autowork-response', frameId, requestId: payload.requestId, ok: true, result }, '*');
        } catch (error) {
          source.postMessage({ type: 'autoagent-autowork-response', frameId, requestId: payload.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, '*');
        }
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameId]);

  return (
    <div className="artifact-card">
      <div className="artifact-card-head">
        <strong>{artifact.title}</strong>
        <span>{artifact.description || 'Persistent HTML artifact'}</span>
      </div>
      <div className="artifact-preview-shell">
        <iframe
          title={artifact.title}
          className="artifact-preview-frame"
          sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
          srcDoc={srcDoc}
          style={{ height: `${frameHeight}px` }}
        />
      </div>
      <details className="artifact-source">
        <summary>View source</summary>
        <pre>{artifact.html}</pre>
      </details>
      <div className="artifact-card-actions">
        <button
          type="button"
          className="artifact-button"
          disabled={opening}
          onClick={async () => {
            if (!onCreateArtifact) return;
            setOpening(true);
            try {
              await onCreateArtifact(artifact);
            } finally {
              setOpening(false);
            }
          }}
        >
          {opening ? 'Opening...' : 'Open artifact'}
        </button>
      </div>
    </div>
  );
}

function ArtifactReferenceBlock({ source }: { source: string }) {
  const ref = React.useMemo(() => parseArtifactReference(source), [source]);
  const frameId = React.useId().replace(/:/g, '-');
  const [html, setHtml] = React.useState('');
  const [frameHeight, setFrameHeight] = React.useState(360);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!ref?.path) {
        setError('Artifact path is missing');
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        const result = (await window.autoagent.loadArtifactSource({ path: ref.path })) as { html?: string };
        if (cancelled) return;
        setHtml(result.html || '');
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setHtml('');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ref?.path]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { type?: string; frameId?: string; height?: number; requestId?: string; method?: string; payload?: any } | null;
      if (payload?.type === 'autoagent-artifact-height' && payload.frameId === frameId) {
        const nextHeight = typeof payload.height === 'number' ? Math.max(180, Math.min(Math.ceil(payload.height) + 8, 1400)) : null;
        if (nextHeight) setFrameHeight(nextHeight);
        return;
      }
      if (payload?.type !== 'autoagent-autowork-request' || payload.frameId !== frameId) return;
      const source = event.source as Window | null;
      if (!source || !payload.requestId) return;
      (async () => {
        try {
          let result: unknown;
          if (payload.method === 'callMcpTool') result = await window.autoagent.autoworkCallMcpTool(payload.payload);
          else if (payload.method === 'askClaude') result = await window.autoagent.autoworkAskClaude(payload.payload);
          else if (payload.method === 'runScheduledTask') result = await window.autoagent.autoworkRunScheduledTask(payload.payload);
          else if (payload.method === 'navigateHost') result = await window.autoagent.autoworkNavigateHost(payload.payload);
          else if (payload.method === 'openExternalUrl') result = await window.autoagent.autoworkOpenExternalUrl(payload.payload);
          else throw new Error(`Unknown autowork method: ${payload.method}`);
          source.postMessage({ type: 'autoagent-autowork-response', frameId, requestId: payload.requestId, ok: true, result }, '*');
        } catch (error) {
          source.postMessage({ type: 'autoagent-autowork-response', frameId, requestId: payload.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }, '*');
        }
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameId]);

  if (loading) {
    return <div className="artifact-card"><div className="artifact-card-head"><strong>{ref?.title || 'Artifact'}</strong><span>Loading artifact preview...</span></div></div>;
  }

  if (error || !html) {
    return <div className="artifact-card"><div className="artifact-card-head"><strong>{ref?.title || 'Artifact'}</strong><span>{error || 'Artifact source is empty'}</span></div></div>;
  }

  const srcDoc = buildArtifactPreviewDocument(
    {
      title: ref?.title || 'Artifact',
      description: ref?.description || '',
      html,
    },
    frameId,
  );

  return (
    <div className="artifact-card">
      <div className="artifact-card-head">
        <strong>{ref?.title || 'Artifact'}</strong>
        <span>{ref?.description || ref?.path || 'Persistent HTML artifact'}</span>
      </div>
      <div className="artifact-preview-shell">
        <iframe
          title={ref?.title || 'Artifact'}
          className="artifact-preview-frame"
          sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
          srcDoc={srcDoc}
          style={{ height: `${frameHeight}px` }}
        />
      </div>
    </div>
  );
}

function PreBlock({
  children,
  onCreateArtifact,
}: {
  children?: React.ReactNode;
  onCreateArtifact?: (input: { title?: string; description?: string; html: string }) => Promise<{ path?: string } | void>;
}) {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement(child)) return <pre>{children}</pre>;

  const props = child.props as { className?: string; children?: React.ReactNode };
  const className = typeof props.className === 'string' ? props.className : '';
  const language = className.startsWith('language-') ? className.slice('language-'.length) : '';
  const text = React.Children.toArray(props.children).join('').replace(/\n$/, '');

  if (language === 'mermaid') return <MermaidBlock chart={text} />;
  if (language === 'artifact-ref') return <ArtifactReferenceBlock source={text} />;
  if (language === 'artifact-html' || language === 'artifact') {
    return <ArtifactBlock source={text} onCreateArtifact={onCreateArtifact} />;
  }

  return <CodeBlock className={className}>{props.children}</CodeBlock>;
}

export function MessageContent({
  text,
  onOpenLink,
  onCreateArtifact,
}: {
  text: string;
  onOpenLink?: (url: string) => void;
  onCreateArtifact?: (input: { title?: string; description?: string; html: string }) => Promise<{ path?: string } | void>;
}) {
  return (
    <div className="rendered-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeRaw], [rehypeSanitize, sanitizeSchema]]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                if (!href) return;
                event.preventDefault();
                onOpenLink?.(href);
              }}
            >
              {children}
            </a>
          ),
          pre: ({ children }) => <PreBlock onCreateArtifact={onCreateArtifact}>{children}</PreBlock>,
          code(props) {
            const { className, children, ...rest } = props;
            return (
              <code {...rest} className={['inline-code', className].filter(Boolean).join(' ')}>
                {children}
              </code>
            );
          },
          'code-stats': ({ children }) => <CodeStatsBlock>{children}</CodeStatsBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
