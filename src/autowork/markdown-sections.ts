export interface MarkdownSection {
  level: number;
  title: string;
  content: string;
  children: MarkdownSection[];
}

interface SectionNode extends MarkdownSection {
  parent?: SectionNode;
}

export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const root: SectionNode = { level: 0, title: '', content: '', children: [] };
  const stack: SectionNode[] = [root];
  let current: SectionNode = root;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      current.content += `${line}\n`;
      continue;
    }
    if (inFence) {
      current.content += `${line}\n`;
      continue;
    }
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      const level = match[1].length;
      const title = match[2].trim();
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1];
      const node: SectionNode = { level, title, content: '', children: [], parent };
      parent.children.push(node);
      stack.push(node);
      current = node;
      continue;
    }
    current.content += `${line}\n`;
  }

  const stripParent = (node: SectionNode): MarkdownSection => ({
    level: node.level,
    title: node.title,
    content: node.content.trim(),
    children: node.children.map(stripParent),
  });

  return root.children.map(stripParent);
}

function normalizeTitle(value: string): string {
  return value
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[()（）]/g, '')
    .trim()
    .toLowerCase();
}

export function findSection(sections: MarkdownSection[], path: string[]): MarkdownSection | null {
  const direct = findSectionFromSiblings(sections, path);
  if (direct) return direct;
  for (const section of sections) {
    const nested = findSection(section.children, path);
    if (nested) return nested;
  }
  return null;
}

function findSectionFromSiblings(sections: MarkdownSection[], path: string[]): MarkdownSection | null {
  let cursor: MarkdownSection | null = null;
  let siblings = sections;
  for (const segment of path) {
    const normalized = normalizeTitle(segment);
    cursor = siblings.find((section) => normalizeTitle(section.title) === normalized) || null;
    if (!cursor) return null;
    siblings = cursor.children;
  }
  return cursor;
}

export function extractFirstCodeBlock(markdown: string): string | null {
  const match = markdown.match(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

export function cleanSectionBody(markdown: string): string {
  return markdown
    .replace(/^\*\*源码位置：\*\*.*$/gm, '')
    .replace(/^\*\*关键证据：\*\*.*$/gm, '')
    .replace(/^> 来源：.*$/gm, '')
    .replace(/^> 提取日期：.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMarkdownTable(markdown: string): Array<Record<string, string>> {
  const lines = markdown.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const header = lines[0].split('|').slice(1, -1).map((cell) => cell.trim());
  const rows = lines.slice(2);
  return rows
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] || ''])));
}
