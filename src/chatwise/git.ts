import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface GitBranchInfo {
  name: string;
  isRemote: boolean;
}

export interface GitDiffFile {
  path: string;
  headPath?: string;
  currentPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type_changed' | 'unknown';
  additions: number;
  deletions: number;
}

export async function runProcess(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (data) => stdout.push(Buffer.from(data)));
    child.stderr.on('data', (data) => stderr.push(Buffer.from(data)));
    child.on('error', (error) => resolve({ stdout: '', stderr: error.message, code: 127 }));
    child.on('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
      }),
    );
  });
}

export function workDirFrom(input?: { cwd?: string; workDir?: string; workDirectory?: string }): string | undefined {
  return input?.workDir || input?.workDirectory || input?.cwd;
}

export async function isGitRepository(workDir?: string): Promise<boolean> {
  if (!workDir) return false;
  const result = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], workDir);
  return result.code === 0 && result.stdout.trim() === 'true';
}

export async function getGitDefaultBranch(input?: { cwd?: string; workDir?: string }): Promise<string | null> {
  const workDir = workDirFrom(input);
  const remote = await runProcess('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], workDir);
  if (remote.code === 0 && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, '');
  const local = await runProcess('git', ['branch', '--show-current'], workDir);
  return local.stdout.trim() || null;
}

export async function getGitBranches(input?: { cwd?: string; workDir?: string }): Promise<GitBranchInfo[]> {
  const workDir = workDirFrom(input);
  const result = await runProcess('git', ['branch', '--all', '--format=%(refname:short)'], workDir);
  if (result.code !== 0) return [];
  const seen = new Set<string>();
  const branches: GitBranchInfo[] = [];
  for (const raw of result.stdout.split('\n')) {
    const name = raw.trim().replace(/^origin\/HEAD -> /, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    branches.push({ name, isRemote: name.includes('/') });
  }
  return branches;
}

export async function switchGitBranch(input: { cwd?: string; workDir?: string; branch: string }) {
  const workDir = workDirFrom(input);
  const result = await runProcess('git', ['switch', input.branch], workDir);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `failed to switch branch ${input.branch}`);
  return { ok: true, branch: input.branch };
}

export async function getGitDiffStat(input?: { cwd?: string; workDir?: string; base?: string }) {
  const workDir = workDirFrom(input);
  if (!(await isGitRepository(workDir))) return { isGitRepo: false, additions: 0, deletions: 0, changedFiles: 0 };
  const files = await getGitDiffFiles(input);
  return {
    isGitRepo: true,
    additions: files.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: files.files.length,
  };
}

export async function getGitDiffFiles(input?: { cwd?: string; workDir?: string; base?: string }) {
  const workDir = workDirFrom(input);
  if (!(await isGitRepository(workDir))) return { isGitRepo: false, files: [] as GitDiffFile[] };

  const diffTarget = input?.base ? [input.base] : [];
  const [statusResult, numstatResult] = await Promise.all([
    runProcess('git', ['diff', '--name-status', '--find-renames', ...diffTarget], workDir),
    runProcess('git', ['diff', '--numstat', '--find-renames', ...diffTarget], workDir),
  ]);
  const counts = parseNumstat(numstatResult.stdout);
  const files = statusResult.stdout
    .split('\n')
    .filter(Boolean)
    .map((line): GitDiffFile => {
      const [rawStatus, firstPath, secondPath] = line.split('\t');
      const status = normalizeStatus(rawStatus);
      const currentPath = secondPath || firstPath;
      const headPath = secondPath ? firstPath : firstPath;
      const key = currentPath || headPath;
      const count = counts.get(key) || { additions: 0, deletions: 0 };
      return {
        path: key,
        headPath,
        currentPath: status === 'deleted' ? undefined : currentPath,
        status,
        additions: count.additions,
        deletions: count.deletions,
      };
    });
  return { isGitRepo: true, files };
}

export async function getGitDiffFileContent(input: {
  cwd?: string;
  workDir?: string;
  filePath: string;
  headPath?: string;
  currentPath?: string;
}) {
  const workDir = workDirFrom(input);
  const headPath = input.headPath || input.filePath;
  const currentPath = input.currentPath || input.filePath;
  const patch = await runProcess('git', ['diff', '--', input.filePath], workDir);
  const original = await runProcess('git', ['show', `HEAD:${headPath}`], workDir);
  let currentContent: string | null = null;
  try {
    currentContent = await readFile(join(workDir || process.cwd(), currentPath), 'utf8');
  } catch {
    currentContent = null;
  }
  return {
    patchContent: patch.stdout,
    originalContent: original.code === 0 ? original.stdout : null,
    currentContent,
  };
}

function normalizeStatus(status: string): GitDiffFile['status'] {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'deleted';
  if (status.startsWith('R')) return 'renamed';
  if (status.startsWith('C')) return 'copied';
  if (status.startsWith('T')) return 'type_changed';
  if (status.startsWith('M')) return 'modified';
  return 'unknown';
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [added, deleted, firstPath, secondPath] = line.split('\t');
    const path = secondPath || firstPath;
    map.set(path, {
      additions: Number(added) || 0,
      deletions: Number(deleted) || 0,
    });
  }
  return map;
}
