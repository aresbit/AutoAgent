import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSectionBody, extractFirstCodeBlock, findSection, parseMarkdownSections, parseMarkdownTable, type MarkdownSection } from './markdown-sections.js';
import { resolvePromptAssetsDir } from '../runtime-paths.js';

type AssetName =
  | 'desktop-system-prompts-extracted.md'
  | 'claude-desktop-artifacts-mechanism.md'
  | 'claude-desktop-ui-generation.md'
  | 'claude-code-internal-mcp-servers.md';

interface LoadedAsset {
  raw: string;
  sections: MarkdownSection[];
}

const cache = new Map<AssetName, LoadedAsset>();
let resolvedAssetsDir: string | null = null;

function resolveAssetsDir(): string {
  if (resolvedAssetsDir) return resolvedAssetsDir;
  resolvedAssetsDir = resolvePromptAssetsDir();
  return resolvedAssetsDir;
}

function loadAsset(name: AssetName): LoadedAsset {
  const cached = cache.get(name);
  if (cached) return cached;
  const raw = readFileSync(join(resolveAssetsDir(), name), 'utf8');
  const loaded = { raw, sections: parseMarkdownSections(raw) };
  cache.set(name, loaded);
  return loaded;
}

export interface PromptSourceIndexEntry {
  component: string;
  symbol: string;
  file: string;
  line: string;
}

export function getPromptSourceIndex(): PromptSourceIndexEntry[] {
  const asset = loadAsset('desktop-system-prompts-extracted.md');
  const section = findSection(asset.sections, ['七、关键源码索引']);
  if (!section) return [];
  return parseMarkdownTable(section.content).map((row) => ({
    component: row['组件'] || '',
    symbol: row['变量/函数名'] || '',
    file: row['文件'] || '',
    line: row['行号'] || '',
  }));
}

function getSection(name: AssetName, path: string[]): MarkdownSection {
  const asset = loadAsset(name);
  const section = findSection(asset.sections, path);
  if (!section) throw new Error(`Prompt asset section not found: ${name} -> ${path.join(' / ')}`);
  return section;
}

function getCodeBlock(name: AssetName, path: string[]): string {
  const code = extractFirstCodeBlock(getSection(name, path).content);
  if (!code) throw new Error(`Expected code block in prompt asset section: ${name} -> ${path.join(' / ')}`);
  return code;
}

function getCleanBody(name: AssetName, path: string[]): string {
  return cleanSectionBody(getSection(name, path).content);
}

export interface DesktopReplicaPromptParts {
  coworkSystemPrompt: string;
  artifactsSection: string;
  imagineBase: string;
  imaginePalette: string;
  imagineUiComponents: string;
  imagineElicitation: string;
  imagineSvgGuide: string;
  imagineDiagramRules: string;
  imagineDataVizRules: string;
  imagineArtRules: string;
  visualizeServer: string;
  uiGenerationNotes: string;
  artifactMechanismNotes: string;
  internalMcpNotes: string;
}

export function loadDesktopReplicaPromptParts(): DesktopReplicaPromptParts {
  return {
    coworkSystemPrompt: getCodeBlock('desktop-system-prompts-extracted.md', ['一、Cowork 基础系统提示 (`nkr` / `cowork_system_prompt`)']),
    artifactsSection: getCodeBlock('desktop-system-prompts-extracted.md', ['二、系统提示组装流程 (`Rbr()`)', '2.4 Artifacts 段 (`Sbr(e)`)']),
    imagineBase: getCodeBlock('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.1 基础设计系统 (`sJn`)']),
    imaginePalette: getCleanBody('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.2 颜色调色板 (`x5`)']),
    imagineUiComponents: getCleanBody('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.3 UI 组件规范 (`oJn(e)`)']),
    imagineElicitation: getCodeBlock('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.4 Elicitation 表单系统 (`aJn`)']),
    imagineSvgGuide: getCleanBody('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.5 SVG 教程 (`Xri(e)`)']),
    imagineDiagramRules: getCleanBody('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.6 图表规则 (`cJn(e)`)']),
    imagineDataVizRules: getCodeBlock('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.7 数据可视化规则 (`Cst`)']),
    imagineArtRules: getCodeBlock('desktop-system-prompts-extracted.md', ['四、Imagine — Visual Creation Suite', '4.8 艺术规则 (`gJn`)']),
    visualizeServer: getCleanBody('desktop-system-prompts-extracted.md', ['五、Visualize MCP 服务定义']),
    uiGenerationNotes: getCleanBody('claude-desktop-ui-generation.md', ['七、关键发现']),
    artifactMechanismNotes: getCleanBody('claude-desktop-artifacts-mechanism.md', ['十、关键结论']),
    internalMcpNotes: getCleanBody('claude-code-internal-mcp-servers.md', ['六、关键发现']),
  };
}
