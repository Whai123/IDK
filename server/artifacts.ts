import { lstat, open, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, isAbsolute, relative, resolve, win32 } from 'node:path';
import type { TaskFile, TaskFileResponse, TaskFilesResponse, WorkspaceState } from '../src/lib/types.ts';
import { runCommand } from './providers.ts';
import type { CommandRunner } from './providers.ts';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_BYTES = 256 * 1024;
const languages: Record<string, string> = { '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx', '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json', '.md': 'markdown', '.mdx': 'markdown', '.txt': 'text', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.svg': 'xml', '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.sh': 'shell', '.sql': 'sql', '.vue': 'vue', '.svelte': 'svelte', '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin', '.kts': 'kotlin', '.conf': 'text', '.cfg': 'text', '.ini': 'text' };

export class ArtifactError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'ArtifactError'; }
}

function safeRelativePath(path: string): void {
  if (!path || path.length > 4096 || /[\0\r\n\\]/.test(path) || isAbsolute(path) || win32.isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new ArtifactError('Use a relative changed-file path without traversal or special separators.', 403);
}

function protectedPath(path: string): boolean {
  const parts = path.toLowerCase().split('/');
  return parts.some(part => ['.git', '.ssh', '.aws', '.codex', '.claude', '.docker', '.npmrc', '.pypirc', '.netrc', 'auth.json', 'keys', 'keystore'].includes(part)
    || /^\.env(?:\.|$)/.test(part)
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(part)
    || /^id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|private[_-]?key|api[_-]?key)(?:$|[._-])/.test(part));
}

function contained(root: string, target: string): string {
  const path = relative(root, target);
  if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path)) throw new ArtifactError('The file is outside the retained task worktree.', 403);
  return path.replaceAll('\\', '/');
}

function language(path: string): string | null {
  const extension = extname(path).toLowerCase();
  if (languages[extension]) return languages[extension];
  return /(?:^|\/)(readme|license|licence|dockerfile|makefile|\.gitignore|\.gitattributes)$/i.test(path) ? 'text' : null;
}

async function git(runner: CommandRunner, cwd: string, args: string[], outputLimitBytes = MAX_LIST_BYTES) {
  let result;
  try { result = await runner('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeoutMs: 6000, outputLimitBytes }); }
  catch { throw new ArtifactError('Native Git inspection is unavailable on this server.', 503); }
  if (result.exitCode !== 0 || result.timedOut || result.interrupted) throw new ArtifactError('Could not inspect the retained Git worktree. Check that it still exists and belongs to the connected repository.', 409);
  return result;
}

async function taskWorkspace(state: WorkspaceState, taskId: string, runner: CommandRunner): Promise<string> {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) throw new ArtifactError('Unknown task in the active workspace.', 404);
  if (!task.workspacePath) throw new ArtifactError('This task has no retained native worktree. Its reports and attached previews remain available in the Workbench.', 409);
  if (!state.company.repoPath) throw new ArtifactError('Connect the repository before inspecting task files.', 409);
  let repo: string, workspace: string;
  try { repo = await realpath(state.company.repoPath); workspace = await realpath(task.workspacePath); }
  catch { throw new ArtifactError('The connected repository or retained task worktree is no longer available.', 409); }
  if (repo === workspace || !(await stat(workspace)).isDirectory()) throw new ArtifactError('Task files require a separate retained Git worktree.', 403);
  const repoRoot = await git(runner, repo, ['rev-parse', '--show-toplevel'], 8192);
  const workspaceRoot = await git(runner, workspace, ['rev-parse', '--show-toplevel'], 8192);
  const repoCommon = await git(runner, repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 8192);
  const workspaceCommon = await git(runner, workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 8192);
  if ([repoRoot, workspaceRoot, repoCommon, workspaceCommon].some(result => result.truncated)) throw new ArtifactError('Git worktree identity exceeded the inspection limit.', 409);
  try {
    if (await realpath(repoRoot.stdout.trim()) !== repo || await realpath(workspaceRoot.stdout.trim()) !== workspace || await realpath(repoCommon.stdout.trim()) !== await realpath(workspaceCommon.stdout.trim())) throw new ArtifactError('The task worktree does not belong to the connected repository.', 403);
  } catch (error) { if (error instanceof ArtifactError) throw error; throw new ArtifactError('Could not confirm the retained worktree identity.', 409); }
  const registered = await git(runner, repo, ['worktree', 'list', '--porcelain', '-z']);
  let registeredWorkspace = false;
  if (!registered.truncated) {
    for (const item of registered.stdout.split('\0')) {
      if (!item.startsWith('worktree ')) continue;
      try { if (await realpath(item.slice('worktree '.length)) === workspace) { registeredWorkspace = true; break; } }
      catch { /* Stale registered worktrees do not authorize a different directory. */ }
    }
  }
  if (!registeredWorkspace) throw new ArtifactError('The task workspace is not a registered retained worktree of this repository.', 403);
  return workspace;
}

async function canonicalFile(workspace: string, path: string): Promise<string> {
  safeRelativePath(path);
  if (protectedPath(path)) throw new ArtifactError('Credential and environment files cannot be previewed.', 403);
  let canonical: string;
  try { canonical = await realpath(resolve(workspace, path)); }
  catch { throw new ArtifactError('This changed file is no longer available in the worktree.', 404); }
  const actualRelative = contained(workspace, canonical);
  if (protectedPath(actualRelative)) throw new ArtifactError('Credential and environment targets cannot be previewed through aliases.', 403);
  return canonical;
}

async function inventory(workspace: string, runner: CommandRunner): Promise<{ files: TaskFile[]; truncated: boolean }> {
  const changes = await git(runner, workspace, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', 'HEAD', '--']);
  const untracked = await git(runner, workspace, ['ls-files', '--others', '--exclude-standard', '-z']);
  const candidates = new Map<string, TaskFile['status']>();
  const fields = changes.stdout.split('\0');
  if (changes.truncated || (changes.stdout && !changes.stdout.endsWith('\0'))) fields.pop();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const code = fields[index], path = fields[index + 1];
    if (path && ['A', 'D', 'M', 'T'].includes(code)) candidates.set(path, code === 'D' ? 'deleted' : code === 'A' ? 'added' : 'modified');
  }
  const untrackedFields = untracked.stdout.split('\0');
  if (untracked.truncated) untrackedFields.pop();
  for (const path of untrackedFields) if (path && !candidates.has(path)) candidates.set(path, 'added');
  const files: TaskFile[] = [];
  let truncated = !!changes.truncated || !!untracked.truncated;
  for (const [path, status] of candidates) {
    try { safeRelativePath(path); } catch { continue; }
    if (protectedPath(path)) continue;
    if (files.length >= MAX_FILES) { truncated = true; break; }
    let previewable = false;
    if (status !== 'deleted' && language(path)) {
      try {
        const canonical = await canonicalFile(workspace, path), info = await lstat(canonical);
        previewable = info.isFile() && info.nlink === 1 && info.size <= MAX_FILE_BYTES;
      } catch { /* Keep changed entries visible, but do not preview unsafe or missing targets. */ }
    }
    files.push({ path, status, previewable });
  }
  return { files, truncated };
}

export async function listTaskFiles(state: WorkspaceState, taskId: string, runner: CommandRunner = runCommand): Promise<TaskFilesResponse> {
  const workspace = await taskWorkspace(state, taskId, runner);
  return { taskId, ...await inventory(workspace, runner) };
}

/** Returns JSON text only; HTML is never served as an active server document. */
export async function readTaskFile(state: WorkspaceState, taskId: string, path: string, runner: CommandRunner = runCommand): Promise<TaskFileResponse> {
  safeRelativePath(path);
  if (protectedPath(path)) throw new ArtifactError('Credential and environment files cannot be previewed.', 403);
  const workspace = await taskWorkspace(state, taskId, runner), current = await inventory(workspace, runner);
  const entry = current.files.find(item => item.path === path);
  if (!entry) throw new ArtifactError('The requested file is not in this task’s bounded changed-file inventory.', 404);
  if (entry.status === 'deleted') throw new ArtifactError('This changed file was deleted.', 404);
  const fileLanguage = language(path);
  if (!fileLanguage) throw new ArtifactError('This file format does not have a text preview.', 415);
  const canonical = await canonicalFile(workspace, path);
  let handle;
  try { handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new ArtifactError('Could not safely open the changed file.', 409); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new ArtifactError('Only regular text files without hard-link aliases can be previewed.', 403);
    if (info.size > MAX_FILE_BYTES) throw new ArtifactError('This changed file exceeds the 256 KiB preview limit.', 413);
    // Linux descriptor identity closes a parent-symlink race without reading file contents.
    let openedPath: string;
    try { openedPath = process.platform === 'linux' ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(canonical); }
    catch { throw new ArtifactError('The changed file moved during inspection. Refresh the worktree inventory before previewing it.', 409); }
    if (protectedPath(contained(workspace, openedPath))) throw new ArtifactError('The opened target is a protected credential or environment file.', 403);
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new ArtifactError('This changed file exceeds the 256 KiB preview limit.', 413);
    const contentBytes = bytes.subarray(0, bytesRead);
    if (contentBytes.includes(0)) throw new ArtifactError('Binary files cannot be previewed as text.', 415);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes); }
    catch { throw new ArtifactError('This changed file is binary or is not valid UTF-8 text.', 415); }
    return { taskId, path, content, language: fileLanguage, truncated: false };
  } finally { await handle.close(); }
}
