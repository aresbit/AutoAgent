import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { ArtifactVersionView, ArtifactView } from "@/api/types";
import {
  normalizeArtifactVersions,
  fallbackArtifactVersions,
} from "@/api/artifacts";
import {
  ARTIFACT_CSP,
  ARTIFACT_SANDBOX,
  ArtifactFrame,
  artifactFrameHeight,
  buildArtifactDocument,
  injectArtifactCsp,
} from "@/features/artifacts/ArtifactFrame";
import { ArtifactsPanel } from "@/features/artifacts/ArtifactsPanel";
import { ArtifactVersionList } from "@/features/artifacts/VersionList";
import {
  artifactTitle,
  artifactVersionCount,
  byteSize,
  formatBytes,
  shortSha,
} from "@/features/artifacts/logic";
import { Markdown } from "@/features/chat/markdown";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact sandbox", () => {
  it("uses exactly allow-scripts and allow-forms", () => {
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts allow-forms");
    const markup = renderToStaticMarkup(
      <ArtifactFrame html="<p>hi</p>" title="Demo" />,
    );
    expect(markup).toContain('sandbox="allow-scripts allow-forms"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-top-navigation");
    expect(markup).not.toContain("allow-modals");
    expect(markup).not.toContain("allow-popups");
  });

  it("injects the strict CSP before author content, once", () => {
    expect(ARTIFACT_CSP).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; font-src data:; connect-src 'none'; " +
        "form-action 'none'; base-uri 'none'",
    );
    const source =
      '<!doctype html><html><head><title>x</title></head><body><script>fetch("/api/settings")</script></body></html>';
    const secured = injectArtifactCsp(source);
    expect(secured).toContain(ARTIFACT_CSP);
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(
      secured.indexOf("fetch("),
    );
    expect(secured.match(/Content-Security-Policy/g)).toHaveLength(1);

    // Artifact-authored markers must not be able to suppress injection.
    const spoofed = injectArtifactCsp(
      '<html><!-- data-autoagent-csp --><body><script>fetch("/api/events")</script></body></html>',
    );
    expect(spoofed.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it("adds the host resize reporter inside the body", () => {
    const doc = buildArtifactDocument("<html><body><p>hi</p></body></html>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("autoagent:artifact-resize");
    expect(doc.indexOf("autoagent:artifact-resize")).toBeLessThan(
      doc.indexOf("</body>"),
    );
  });

  it("surfaces an empty artifact as an error card with retry", () => {
    const markup = renderToStaticMarkup(<ArtifactFrame html="   " title="Empty" />);
    expect(markup).toContain("Artifact preview unavailable");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("<iframe");
  });

  it("renders a backend frame URL with src and keeps the tight sandbox", () => {
    const url = "/api/artifacts/a1/frame?token=short-lived";
    const markup = renderToStaticMarkup(
      <ArtifactFrame html="<p>ignored</p>" title="Remote" frameUrl={url} />,
    );
    expect(markup).toContain(`src="${url}"`);
    expect(markup).not.toContain("srcdoc");
    // The backend injects the reporter; the component must not duplicate it.
    expect(markup).not.toContain("autoagent:artifact-resize");
    expect(markup).toContain('sandbox="allow-scripts allow-forms"');
    expect(markup).not.toContain("allow-same-origin");
  });

  it("accepts resize messages only from the frame window", () => {
    const frameWindow = { id: "frame" } as unknown as MessageEventSource;
    const otherWindow = { id: "other" } as unknown as MessageEventSource;
    const frame = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;
    expect(
      artifactFrameHeight(
        { source: frameWindow, data: { type: "autoagent:artifact-resize", height: 240 } },
        frame,
        180,
        480,
      ),
    ).toBe(240);
    expect(
      artifactFrameHeight(
        { source: frameWindow, data: { type: "autoagent:artifact-resize", height: 40 } },
        frame,
        180,
        480,
      ),
    ).toBe(180);
    expect(
      artifactFrameHeight(
        { source: frameWindow, data: { type: "autoagent:artifact-resize", height: 9_000 } },
        frame,
        180,
        480,
      ),
    ).toBe(480);
    // A different window, a wrong type and a non-numeric height are ignored.
    expect(
      artifactFrameHeight(
        { source: otherWindow, data: { type: "autoagent:artifact-resize", height: 240 } },
        frame,
        180,
        480,
      ),
    ).toBeNull();
    expect(
      artifactFrameHeight(
        { source: frameWindow, data: { type: "something-else", height: 240 } },
        frame,
        180,
        480,
      ),
    ).toBeNull();
    expect(
      artifactFrameHeight(
        { source: frameWindow, data: { type: "autoagent:artifact-resize", height: "240" } },
        frame,
        180,
        480,
      ),
    ).toBeNull();
  });

  it("falls back to srcDoc when the frame token request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "FRAME_TOKEN_UNAVAILABLE", message: "No endpoint." },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const token = await api
      .artifactFrameToken("a1", "v2")
      .catch(() => undefined);
    const markup = renderToStaticMarkup(
      <ArtifactFrame html="<p>hi</p>" title="Fallback" frameUrl={token?.url} />,
    );
    expect(markup).toContain("srcDoc");
    expect(markup).not.toContain('src="/api/artifacts/a1/frame');
    expect(markup).toContain("autoagent:artifact-resize");
  });
});

describe("chat artifact card", () => {
  it("renders an artifact card and never raw HTML", () => {
    const text = [
      "Intro",
      "",
      "```artifact-html",
      "<!doctype html><html><head><title>Release notes</title></head><body><h1>Hi</h1></body></html>",
      "```",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <Markdown text={text} onOpenArtifact={() => undefined} />,
    );
    expect(markup).toContain('data-testid="chat-artifact-card"');
    expect(markup).toContain("Release notes");
    expect(markup).toContain("Open panel");
    expect(markup).toContain("Preview");
    expect(markup).not.toContain("<h1>Hi</h1>");
    expect(markup).not.toContain("<!doctype html>");
    // No frame until the user asks for a preview.
    expect(markup).not.toContain("<iframe");
  });

  it("treats other html fences as source only", () => {
    const markup = renderToStaticMarkup(
      <Markdown text={"```html\n<h1>raw</h1>\n```"} />,
    );
    expect(markup).not.toContain('data-testid="chat-artifact-card"');
    expect(markup).not.toContain("<iframe");
  });

  it("derives a title and size", () => {
    expect(artifactTitle("<title>  A &amp; B </title>")).toBe("A & B");
    expect(artifactTitle("<h1>Heading</h1>")).toBe("Heading");
    expect(artifactTitle("", "Fallback")).toBe("Fallback");
    expect(formatBytes(byteSize("abc"))).toBe("3 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("artifact version count", () => {
  const artifact: ArtifactView = {
    id: "a1",
    title: "Demo",
    description: "",
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: null,
    // Legacy timestamp list: only one entry even though three versions exist.
    versions: [1],
    contentUrl: "/api/artifacts/a1/content",
    thumbnailUrl: null,
    revision: "v3",
    versionCount: 3,
  };

  it("prefers the backend versionCount over the legacy timestamp list", () => {
    expect(artifactVersionCount(artifact)).toBe(3);
    expect(artifactVersionCount({ ...artifact, versionCount: undefined })).toBe(1);
  });

  it("shows versionCount in the panel badge", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ArtifactsPanel initialArtifacts={[artifact]} />
      </QueryClientProvider>,
    );
    expect(markup).toContain("3");
    expect(markup).toContain("versions");
  });
});

describe("artifact version list", () => {
  const versions: ArtifactVersionView[] = [
    {
      versionId: "v2",
      createdAt: 1_700_000_000_000,
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      sizeBytes: 10,
      current: true,
    },
    {
      versionId: "v1",
      createdAt: 1_699_000_000_000,
      sha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      sizeBytes: 8,
      current: false,
    },
  ];

  it("shows the current badge, short sha and restore action", () => {
    const markup = renderToStaticMarkup(
      <ArtifactVersionList
        versions={versions}
        canRestore
        onRestore={() => undefined}
      />,
    );
    expect(markup).toContain("current");
    expect(markup).toContain("abcdef01");
    expect(markup).toContain("12345678");
    expect(markup).toContain("Restore");
    expect(shortSha(versions[0].sha256)).toBe("abcdef01");
  });

  it("hides restore when the backend cannot restore", () => {
    const markup = renderToStaticMarkup(
      <ArtifactVersionList versions={versions} canRestore={false} />,
    );
    expect(markup).not.toContain("Restore");
  });

  it("normalizes backend and timestamp payloads", () => {
    const normalized = normalizeArtifactVersions(
      {
        versions: [
          {
            versionId: "v3",
            createdAt: 3,
            sha256: "ccc",
            sizeBytes: 4,
            source: "turn",
            immutable: true,
          },
          { versionId: "v2", createdAt: 2, sha256: "bbb" },
          1,
        ],
      },
      "v3",
    );
    expect(normalized.map((item) => item.versionId)).toEqual(["v3", "v2", "1"]);
    expect(normalized[0]).toMatchObject({ sha256: "ccc", current: true });
    expect(normalized[2]).toMatchObject({ sha256: "", current: false });

    const fallback = fallbackArtifactVersions([10, 30, 20]);
    expect(fallback.map((item) => item.createdAt)).toEqual([30, 20, 10]);
    expect(fallback.filter((item) => item.current)).toHaveLength(1);
  });
});
