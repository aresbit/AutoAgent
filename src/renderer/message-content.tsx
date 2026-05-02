import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import mermaid from 'mermaid';

type JsonRecord = Record<string, unknown>;

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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
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

function CodeStatsBlock({ children }: { children?: React.ReactNode }) {
  const rawText = useMemo(() => React.Children.toArray(children).join('').trim(), [children]);
  const stats = useMemo(() => safeJsonParse(rawText), [rawText]);

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

function PreBlock({
  children,
  onCreateArtifact,
}: {
  children?: React.ReactNode;
  onCreateArtifact?: (input: { title?: string; description?: string; html: string }) => Promise<{ path?: string } | void>;
}) {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement(child)) {
    return <pre>{children}</pre>;
  }

  const className = typeof child.props.className === 'string' ? child.props.className : '';
  const language = className.startsWith('language-') ? className.slice('language-'.length) : '';
  const text = React.Children.toArray(child.props.children).join('').replace(/\n$/, '');

  if (language === 'mermaid') return <MermaidBlock chart={text} />;
  if (language === 'artifact-html' || language === 'artifact') {
    return <ArtifactBlock source={text} onCreateArtifact={onCreateArtifact} />;
  }

  return <CodeBlock className={className}>{child.props.children}</CodeBlock>;
}

function parseArtifactDocument(source: string): { title: string; description: string; html: string } {
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

function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = React.useState<string>('');
  const [error, setError] = React.useState<string>('');

  React.useEffect(() => {
    let cancelled = false;
    const render = async () => {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const { svg } = await mermaid.render(`autoagent-mermaid-${Math.random().toString(36).slice(2)}`, chart);
        if (!cancelled) {
          setSvg(svg);
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
    return <div className="mermaid-card">Rendering Mermaid diagram…</div>;
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
  const [opening, setOpening] = React.useState(false);
  const artifact = React.useMemo(() => parseArtifactDocument(source), [source]);

  return (
    <div className="artifact-card">
      <div className="artifact-card-head">
        <strong>{artifact.title}</strong>
        <span>{artifact.description || 'Persistent HTML artifact'}</span>
      </div>
      <pre>{artifact.html}</pre>
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
          {opening ? 'Opening…' : 'Open artifact'}
        </button>
      </div>
    </div>
  );
}

export function MessageContent({
  text,
  onOpenLink,
  onCreateArtifact,
}: {
  text: string;
  onOpenLink?: (url: string) => void;
  onCreateArtifact?: (input: { title?: string; html: string }) => Promise<{ path?: string } | void>;
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
            return <code {...rest} className={['inline-code', className].filter(Boolean).join(' ')}>{children}</code>;
          },
          'code-stats': ({ children }) => <CodeStatsBlock>{children}</CodeStatsBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
