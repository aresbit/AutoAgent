import { loadDesktopReplicaPromptParts } from './prompt-assets.js';

export type VisualizePlatform = 'mobile' | 'desktop' | 'unknown';
export type VisualizeModule =
  | 'diagram'
  | 'mockup'
  | 'interactive'
  | 'data_viz'
  | 'art'
  | 'chart'
  | 'elicitation';

export interface VisualizeReadMeArgs {
  modules?: VisualizeModule | VisualizeModule[];
  platform?: VisualizePlatform;
}

export interface VisualizeShowWidgetArgs {
  loading_messages?: string[];
  title?: string;
  widget_code?: string;
  description?: string;
  open?: boolean;
}

export interface VisualizeArtifactRecord {
  id: string;
  title: string;
  description: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface AutoworkInternalToolContext {
  createArtifact(input: { title?: string; description?: string; html: string }): Promise<VisualizeArtifactRecord>;
  openArtifact?(path: string, title?: string): Promise<void>;
}

export interface AutoworkInternalToolDefinition {
  server: 'visualize';
  name: 'read_me' | 'show_widget';
  description: string;
  inputSchema: Record<string, unknown>;
}

export const AUTOWORK_INTERNAL_MCP_TOOLS: AutoworkInternalToolDefinition[] = [
  {
    server: 'visualize',
    name: 'read_me',
    description: 'Returns the Imagine guidance needed before rendering a widget.',
    inputSchema: {
      type: 'object',
      properties: {
        modules: {
          oneOf: [
            { enum: ['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation'] },
            {
              type: 'array',
              items: { enum: ['diagram', 'mockup', 'interactive', 'data_viz', 'art', 'chart', 'elicitation'] },
            },
          ],
        },
        platform: { enum: ['mobile', 'desktop', 'unknown'] },
      },
    },
  },
  {
    server: 'visualize',
    name: 'show_widget',
    description: 'Renders SVG/HTML widget content as an Autowork artifact and refreshes the host UI.',
    inputSchema: {
      type: 'object',
      properties: {
        loading_messages: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' },
        },
        title: { type: 'string' },
        widget_code: { type: 'string' },
        description: { type: 'string' },
        open: { type: 'boolean' },
      },
      required: ['loading_messages', 'title', 'widget_code'],
    },
  },
];

const allowedModules = new Set<VisualizeModule>([
  'diagram',
  'mockup',
  'interactive',
  'data_viz',
  'art',
  'chart',
  'elicitation',
]);

function replaceCoworkTerms(value: string): string {
  return value.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork');
}

function toModuleList(input: VisualizeReadMeArgs['modules']): VisualizeModule[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  const filtered = values.filter((value): value is VisualizeModule => allowedModules.has(value as VisualizeModule));
  return [...new Set(filtered)];
}

function platformWidthNote(platform: VisualizePlatform): string {
  if (platform === 'mobile') return 'Target a compact mobile layout around 380px wide.';
  if (platform === 'desktop') return 'Target a desktop layout around 680px wide.';
  return 'Design responsively for both desktop and mobile host widths.';
}

function moduleSections(moduleName: VisualizeModule, platform: VisualizePlatform): string[] {
  const parts = loadDesktopReplicaPromptParts();
  const width = platformWidthNote(platform);
  switch (moduleName) {
    case 'diagram':
      return [
        `# Module: diagram\n${width}`,
        replaceCoworkTerms(parts.imaginePalette),
        replaceCoworkTerms(parts.imagineSvgGuide),
        replaceCoworkTerms(parts.imagineDiagramRules),
      ];
    case 'mockup':
      return [
        `# Module: mockup\n${width}`,
        replaceCoworkTerms(parts.imagineUiComponents),
        replaceCoworkTerms(parts.imaginePalette),
      ];
    case 'interactive':
      return [
        `# Module: interactive\n${width}`,
        replaceCoworkTerms(parts.imagineUiComponents),
        replaceCoworkTerms(parts.imaginePalette),
      ];
    case 'data_viz':
      return [
        `# Module: data_viz\n${width}`,
        replaceCoworkTerms(parts.imagineUiComponents),
        replaceCoworkTerms(parts.imaginePalette),
        replaceCoworkTerms(parts.imagineDataVizRules),
      ];
    case 'art':
      return [
        `# Module: art\n${width}`,
        replaceCoworkTerms(parts.imagineSvgGuide),
        replaceCoworkTerms(parts.imagineArtRules),
      ];
    case 'chart':
      return [
        `# Module: chart\n${width}`,
        replaceCoworkTerms(parts.imagineUiComponents),
        replaceCoworkTerms(parts.imaginePalette),
        replaceCoworkTerms(parts.imagineDataVizRules),
      ];
    case 'elicitation':
      return [
        `# Module: elicitation\n${width}`,
        replaceCoworkTerms(parts.imagineElicitation),
      ];
  }
}

function buildReadMe(modules: VisualizeModule[], platform: VisualizePlatform): string {
  const parts = loadDesktopReplicaPromptParts();
  const intro = [
    '# Visualize read_me',
    replaceCoworkTerms(parts.imagineBase.trim()),
    '',
    platformWidthNote(platform),
    '',
    modules.length
      ? `Loaded modules: ${modules.join(', ')}`
      : 'No module selected yet. Call read_me again with one or more modules: diagram, mockup, interactive, data_viz, art, chart, elicitation.',
  ].join('\n');
  const details = modules.flatMap((moduleName) => moduleSections(moduleName, platform));
  return [intro, ...details].filter(Boolean).join('\n\n');
}

function toTextResult(text: string, structuredContent: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

export async function maybeInvokeAutoworkInternalTool(
  serverHint: string | undefined,
  toolName: string,
  rawArgs: unknown,
  context: AutoworkInternalToolContext,
): Promise<unknown> {
  const isVisualizeTool = toolName === 'read_me' || toolName === 'show_widget';
  if (serverHint && serverHint !== 'visualize' && serverHint !== 'autowork') return undefined;
  if (!isVisualizeTool) return undefined;

  if (toolName === 'read_me') {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as VisualizeReadMeArgs;
    const modules = toModuleList(args.modules);
    const platform = args.platform || 'unknown';
    const text = buildReadMe(modules, platform);
    return toTextResult(text, {
      server: 'visualize',
      tool: 'read_me',
      modules,
      platform,
    });
  }

  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as VisualizeShowWidgetArgs;
  const loadingMessages = Array.isArray(args.loading_messages)
    ? args.loading_messages.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 4)
    : [];
  if (!loadingMessages.length) throw new Error('visualize/show_widget requires at least one loading_messages entry.');
  const title = (args.title || '').trim();
  if (!title) throw new Error('visualize/show_widget requires a title.');
  const widgetCode = (args.widget_code || '').trim();
  if (!widgetCode) throw new Error('visualize/show_widget requires widget_code.');

  const artifact = await context.createArtifact({
    title,
    description: (args.description || '').trim(),
    html: widgetCode,
  });
  if (args.open && context.openArtifact) await context.openArtifact(artifact.path, artifact.title);
  return toTextResult(
    `Rendered widget "${artifact.title}" as an Autowork artifact.`,
    {
      server: 'visualize',
      tool: 'show_widget',
      loading_messages: loadingMessages,
      artifact,
    },
  );
}
