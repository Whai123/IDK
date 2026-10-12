import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Agent, Decision, Evidence, Message, ProviderId, ProviderStatus, Task } from '../src/lib/types.ts';

export interface CommandInput {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  interrupted?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
}

export type CommandRunner = (command: string, args: string[], options?: CommandInput) => Promise<CommandResult>;

/** Native processes only: no shell interpolation, bounded output, and cancellable process groups. */
export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) {
    resolve({ exitCode: null, stdout: '', stderr: '', interrupted: true });
    return;
  }
  const limit = options.outputLimitBytes ?? 4 * 1024 * 1024;
  const child = spawn(command, args, { cwd: options.cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, interrupted = false, timedOut = false, truncated = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (force = false) => {
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already exited. */ }
    } else { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
    if (!force && !killTimer) {
      killTimer = setTimeout(() => kill(true), 1000);
      killTimer.unref();
    }
  };
  const collect = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
    const available = Math.max(0, limit - bytes);
    const piece = chunk.subarray(0, available).toString('utf8');
    bytes += Math.min(chunk.length, available);
    if (channel === 'stdout') stdout += piece; else stderr += piece;
    if (chunk.length > available) { truncated = true; kill(); }
  };
  child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
  const abort = () => { interrupted = true; kill(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs ?? 120_000);
  timeout.unref();
  const cleanup = () => {
    clearTimeout(timeout);
    // Keep the final group kill scheduled after cancellation: descendants can outlive the CLI.
    if (killTimer && !interrupted && !timedOut && !truncated) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
  };
  child.on('error', error => { cleanup(); reject(error); });
  child.on('close', exitCode => { cleanup(); resolve({ exitCode, stdout, stderr, interrupted, timedOut, truncated }); });
  child.stdin.on('error', () => { /* The process may exit before consuming its prompt. */ });
  child.stdin.end(options.input ?? '');
});

function missingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function checkProvider(id: ProviderId, runner: CommandRunner): Promise<ProviderStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const version = await runner(id, ['--version'], { timeoutMs: 5000, outputLimitBytes: 8192 });
    if (version.exitCode !== 0) return { id, installed: true, authenticated: null, detail: 'CLI exists, but its version check failed. Check the installation on this server.', checkedAt };
  } catch (error) {
    return { id, installed: !missingExecutable(error), authenticated: null, detail: missingExecutable(error) ? 'CLI is not installed on this server.' : 'Could not inspect the CLI installation.', checkedAt };
  }
  try {
    const status = await runner(id, id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { timeoutMs: 8000, outputLimitBytes: 16_384 });
    if (status.timedOut || status.truncated || status.interrupted) return { id, installed: true, authenticated: null, detail: 'Native authentication status check did not finish.', checkedAt };
    let authenticated: boolean | null = null;
    if (id === 'codex') {
      const output = `${status.stdout}\n${status.stderr}`;
      if (/not logged in|not authenticated/i.test(output)) authenticated = false;
      else if (status.exitCode === 0 && /logged in/i.test(output)) authenticated = true;
    } else {
      try {
        const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authenticated?: unknown };
        if (typeof parsed.loggedIn === 'boolean') authenticated = parsed.loggedIn;
        else if (typeof parsed.authenticated === 'boolean') authenticated = parsed.authenticated;
        if (authenticated === true && status.exitCode !== 0) authenticated = null;
      } catch { /* Unsupported auth-status versions remain unknown. */ }
    }
    // Native status output can include account identifiers or key metadata. Never return it.
    return { id, installed: true, authenticated, detail: authenticated === true ? 'Native CLI reports an authenticated account on this server.' : authenticated === false ? 'Sign in using the native CLI on this server.' : 'CLI is installed; authentication could not be confirmed using its native status command.', checkedAt };
  } catch {
    return { id, installed: true, authenticated: null, detail: 'CLI is installed; native authentication status is unavailable.', checkedAt };
  }
}

export async function checkProviders(runner: CommandRunner = runCommand): Promise<ProviderStatus[]> {
  return Promise.all((['claude', 'codex'] as const).map(id => checkProvider(id, runner)));
}

export interface ProviderTaskInput {
  provider: ProviderId;
  repoPath: string;
  task: Pick<Task, 'id' | 'title' | 'description'>;
  agent: Pick<Agent, 'name' | 'role' | 'departmentId'>;
  mission: string;
  messages: Message[];
  decisions?: Array<Pick<Decision, 'id' | 'title' | 'answer' | 'departmentId' | 'taskIds' | 'answeredAt'>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
  commandRunner?: CommandRunner;
  /** Caller supplies only an accepted predecessor or a direction-resolved continuation, serially. */
  upstreamWorkspacePath?: string;
}

export interface ProviderTaskResult extends CommandResult {
  workspacePath?: string;
  evidence?: Evidence[];
  error?: string;
  directionRequest?: { question: string; options?: Array<{ id: string; label: string; description: string }>; recommendationId?: string };
  blockedReason?: string;
  /** Includes tracked diffs and untracked file metadata; true also means comparison was incomplete. */
  worktreeChanged?: boolean;
}

function evidence(label: string, detail: string, kind: Evidence['kind'], source: Evidence['source'] = 'observed'): Evidence {
  return { id: randomUUID(), label, detail, kind, source, recordedAt: new Date().toISOString() };
}

function promptFor(input: ProviderTaskInput): string {
  const context = input.messages.slice(-20).map(message => `${message.role}: ${message.text.slice(0, 2000)}`).join('\n');
  const resolved = (input.decisions ?? []).filter(decision => typeof decision.answer === 'string' && decision.answer.trim());
  const relevance = (decision: typeof resolved[number]) => decision.taskIds.includes(input.task.id) ? 3 : decision.departmentId === input.agent.departmentId ? 2 : decision.departmentId === 'product' ? 1 : 0;
  const ordered = resolved.slice().sort((left, right) => relevance(right) - relevance(left));
  const canonical: string[] = [];
  let remainingCharacters = 20_000;
  for (const decision of ordered) {
    const answer = decision.answer!;
    const entry = JSON.stringify({
      id: decision.id.slice(0, 100), title: decision.title.slice(0, 1000), department: decision.departmentId,
      answeredAt: decision.answeredAt,
      answer: answer.length > 4000 ? `${answer.slice(0, 4000)} [Answer excerpt truncated; ask for missing detail if it changes the direction.]` : answer,
    });
    if (entry.length + 1 > remainingCharacters) continue;
    canonical.push(entry);
    remainingCharacters -= entry.length + 1;
  }
  const decisionContext = canonical.length ? `${canonical.join('\n')}\nIncluded ${canonical.length} of ${resolved.length} resolved decisions in this bounded prompt; task-linked, current-department and product decisions take priority. Omitted decisions still exist outside this prompt; ask for missing direction rather than assuming no decision was made.` : '(No resolved founder decisions were supplied separately.)';
  return `You are ${input.agent.name}, acting as ${input.agent.role} in ${input.agent.departmentId}.
Company mission: ${input.mission.slice(0, 6000)}
Task: ${input.task.title.slice(0, 1000)}
Task scope: ${input.task.description.slice(0, 8000)}
Resolved founder decisions (canonical memory):
${decisionContext}
Recent founder and team conversation (bounded):
${context || '(No recent conversation supplied.)'}

Work only on this assigned task in the current isolated Git worktree. Follow repository instructions. Stay within the founder's recorded direction; if missing or conflicting direction prevents this task, explain the question instead of choosing a new product direction. Do not publish, contact customers, spend money, deploy, or alter accounts. Product and marketing work must be drafts grounded in available evidence, never invented customer research or metrics. Do not read credential files or expose secrets. Do not bypass permission or sandbox controls. Do not install dependencies without an explicitly recorded instruction permitting that installation. Prefer existing tools and provide any blocked setup commands for founder review. Do not commit or merge your changes. Describe the files changed, commands actually run and their results, and remaining limitations. An agent report alone is not proof that tests passed.

Your final assistant message must be a JSON object with this shape:
{"status":"completed"|"needs_direction"|"blocked","summary":"What you actually delivered or what prevents progress","question":"Only when founder direction is required","options":[{"id":"short-id","label":"Short option","description":"Tradeoff"}],"recommendationId":"An offered option id, if appropriate"}
For needs_direction, give one specific question and, when useful, 2-3 mutually exclusive options. For blocked, report the concrete missing capability or prerequisite. Omit question, options and recommendationId when they do not apply. Do not claim successful tests without having run them.`;
}

function finalReport(stdout: string, provider: ProviderId): { status: 'completed' | 'needs_direction' | 'blocked'; summary: string; directionRequest?: ProviderTaskResult['directionRequest']; invalidDirection?: boolean } | null {
  let assistantText: string | null = null;
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown; item?: { type?: string; text?: unknown } };
      if (provider === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') assistantText = event.item.text;
      if (provider === 'claude' && event.type === 'result' && event.is_error !== true && typeof event.result === 'string') assistantText = event.result;
    } catch { /* Only native assistant-message envelopes count as a final report. */ }
  }
  if (!assistantText) return null;
  try {
    const text = assistantText.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || !['completed', 'needs_direction', 'blocked'].includes(String(parsed.status))) return null;
    const validSummary = typeof parsed.summary === 'string' && !!parsed.summary.trim();
    if (!validSummary && parsed.status !== 'needs_direction') return null;
    const report: NonNullable<ReturnType<typeof finalReport>> = { status: parsed.status as 'completed' | 'needs_direction' | 'blocked', summary: validSummary ? (parsed.summary as string).slice(0, 8000) : '[No valid summary supplied.]' };
    if (report.status === 'needs_direction' && validSummary && typeof parsed.question === 'string' && parsed.question.trim() && parsed.question.length <= 2000) {
      const request: NonNullable<ProviderTaskResult['directionRequest']> = { question: parsed.question.trim() };
      if (Array.isArray(parsed.options) && parsed.options.length >= 2 && parsed.options.length <= 5) {
        const options = parsed.options as Array<Record<string, unknown>>;
        if (options.every(option => option && typeof option.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(option.id) && typeof option.label === 'string' && option.label.trim() && option.label.length <= 200 && typeof option.description === 'string' && option.description.length <= 1000) && new Set(options.map(option => option.id)).size === options.length) {
          request.options = options as Array<{ id: string; label: string; description: string }>;
          if (typeof parsed.recommendationId === 'string' && request.options.some(option => option.id === parsed.recommendationId)) request.recommendationId = parsed.recommendationId;
        }
      }
      report.directionRequest = request;
    } else if (report.status === 'needs_direction') report.invalidDirection = true;
    return report;
  } catch { return null; }
}

function commandEvidence(stdout: string): Evidence[] {
  const result: Evidence[] = [];
  for (const line of stdout.split('\n')) {
    if (result.length >= 50) break;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; command?: unknown; exit_code?: unknown; aggregated_output?: unknown } };
      if (event.type !== 'item.completed' || event.item?.type !== 'command_execution' || typeof event.item.exit_code !== 'number') continue;
      const command = typeof event.item.command === 'string' ? event.item.command.slice(0, 2000) : 'Native CLI command';
      const output = typeof event.item.aggregated_output === 'string' ? event.item.aggregated_output.slice(0, 8000) : '';
      result.push(evidence(`Command exited ${event.item.exit_code}`, `${command}\nExit code: ${event.item.exit_code}\n${output}`, 'command'));
    } catch { /* Non-JSON and incomplete events are only retained as agent output. */ }
  }
  return result;
}

async function snapshotWorkspace(path: string, runner: CommandRunner, existingDiff?: CommandResult, existingUntracked?: CommandResult): Promise<string | null> {
  try {
    const options = { cwd: path, timeoutMs: 8000, outputLimitBytes: 1024 * 1024 };
    const diff = existingDiff ?? await runner('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], options);
    const untracked = existingUntracked ?? await runner('git', ['ls-files', '--others', '--exclude-standard', '-z'], { ...options, outputLimitBytes: 65_536 });
    if ([diff, untracked].some(result => result.exitCode !== 0 || result.truncated || result.timedOut || result.interrupted)) return null;
    const names = untracked.stdout.split('\0').filter(Boolean).sort();
    if (names.length > 200) return null;
    const signature = createHash('sha256').update(diff.stdout).update('\0');
    for (const name of names) {
      const filePath = resolve(path, name);
      const rel = relative(path, filePath);
      if (name.length > 4096 || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return null;
      // Metadata comparison avoids reading arbitrary untracked file or credential contents.
      const info = await lstat(filePath, { bigint: true });
      signature.update([name, info.mode, info.size, info.ino, info.dev, info.mtimeNs, info.ctimeNs].map(String).join('\0')).update('\0');
    }
    return signature.digest('hex');
  } catch { return null; }
}

/** Creates a retained, detached worktree; the original checkout is never used for agent edits. */
export async function runProviderTask(input: ProviderTaskInput): Promise<ProviderTaskResult> {
  const runner = input.commandRunner ?? runCommand;
  const records: Evidence[] = [];
  let workspacePath: string | undefined;
  const failure = (error: string): ProviderTaskResult => ({ exitCode: null, stdout: '', stderr: '', error, workspacePath, evidence: records, worktreeChanged: workspacePath ? true : undefined, interrupted: input.signal?.aborted ?? false });
  try {
    if (input.provider !== 'claude' && input.provider !== 'codex') return failure('Unsupported provider.');
    if (input.signal?.aborted) return failure('Task interrupted before launch.');
    const auth = await checkProvider(input.provider, runner);
    if (!auth.installed || auth.authenticated !== true) return failure(auth.detail);
    const gitOptions = { cwd: input.repoPath, timeoutMs: 8000, outputLimitBytes: 65_536, signal: input.signal };
    const revision = await runner('git', ['rev-parse', '--verify', 'HEAD'], gitOptions);
    if (revision.exitCode !== 0) return failure('This repository needs an initial commit before an isolated agent worktree can be created.');
    const status = await runner('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], gitOptions);
    if (status.exitCode !== 0 || status.truncated) return failure('Could not confirm the repository state. Inspect Git status before starting a provider task.');
    if (status.stdout.length) return failure('Commit or move uncommitted changes first. Provider tasks start from a clean committed repository so their isolated worktree contains your current work.');
    let baseRevision = revision.stdout.trim();
    if (input.upstreamWorkspacePath) {
      const candidateWorkspace = await realpath(input.upstreamWorkspacePath);
      if (candidateWorkspace === await realpath(input.repoPath)) return failure('The original checkout cannot be used as an inherited task workspace.');
      const originalCommon = await runner('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], gitOptions);
      const upstreamOptions = { ...gitOptions, cwd: candidateWorkspace };
      const upstreamCommon = await runner('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], upstreamOptions);
      const upstreamRoot = await runner('git', ['rev-parse', '--show-toplevel'], upstreamOptions);
      if (originalCommon.exitCode !== 0 || upstreamCommon.exitCode !== 0 || upstreamRoot.exitCode !== 0 || await realpath(originalCommon.stdout.trim()) !== await realpath(upstreamCommon.stdout.trim()) || await realpath(upstreamRoot.stdout.trim()) !== candidateWorkspace) return failure('The inherited workspace is not a worktree of the connected repository.');
      const upstreamRevision = await runner('git', ['rev-parse', '--verify', 'HEAD'], upstreamOptions);
      if (upstreamRevision.exitCode !== 0) return failure('The inherited workspace has no valid committed base revision.');
      baseRevision = upstreamRevision.stdout.trim();
      workspacePath = candidateWorkspace;
      records.push(evidence('Inherited accepted task workspace', `Continuing in ${workspacePath}. Changes include accepted predecessor work or a direction-resolved continuation; final diff is cumulative against HEAD. No changes are merged into the original checkout.`, 'command'));
    } else {
      const directory = await mkdtemp(join(tmpdir(), 'startup-team-task-'));
      const createdWorkspace: string = join(directory, 'workspace');
      workspacePath = createdWorkspace;
      const added = await runner('git', ['-c', 'core.hooksPath=' + join(directory, 'disabled-hooks'), 'worktree', 'add', '--detach', createdWorkspace, 'HEAD'], gitOptions);
      if (added.exitCode !== 0) return failure('Git could not create an isolated worktree. Check worktree permissions and repository configuration.');
    }
    records.push(evidence('Isolated task revision', `Base revision: ${baseRevision}\nWorktree: ${workspacePath}`, 'command'));
    const before = await snapshotWorkspace(workspacePath!, runner);
    const args = input.provider === 'codex'
      ? ['exec', '--json', '--sandbox', 'workspace-write', '--color', 'never', '-']
      : ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    const result = await runner(input.provider, args, {
      cwd: workspacePath, input: promptFor(input), signal: input.signal,
      timeoutMs: Math.min(Math.max(input.timeoutMs ?? 300_000, 1000), 3_600_000),
      outputLimitBytes: Math.min(Math.max(input.outputLimitBytes ?? 4 * 1024 * 1024, 1024), 8 * 1024 * 1024),
    });
    records.push(evidence('Native provider process', `${input.provider} exited ${result.exitCode ?? 'without an exit code'}${result.interrupted ? '; interrupted' : ''}${result.timedOut ? '; timed out' : ''}${result.truncated ? '; output limit reached' : ''}. This records the provider process, not successful tests.`, 'command'));
    records.push(...commandEvidence(result.stdout));
    const report = finalReport(result.stdout, input.provider);
    if (report) records.push(evidence('Agent final report', `${report.status}: ${report.summary}`, 'report', 'agent'));
    // Inspect changes even after an interrupted provider run, retaining partial work for review.
    const diff = await runner('git', ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { cwd: workspacePath, timeoutMs: 8000, outputLimitBytes: 1024 * 1024 });
    if (diff.exitCode === 0) records.push(evidence('Tracked file diff', diff.stdout ? `${diff.stdout}${diff.truncated ? '\n[Diff truncated; inspect the retained worktree.]' : ''}` : 'No tracked file changes.', 'diff'));
    else records.push(evidence('Diff inspection failed', `git diff exited ${diff.exitCode ?? 'without an exit code'}. Inspect the retained worktree.`, 'command'));
    const untracked = await runner('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: workspacePath, timeoutMs: 8000, outputLimitBytes: 65_536 });
    if (untracked.exitCode === 0 && untracked.stdout) records.push(evidence('New files in retained worktree', `${untracked.stdout.split('\0').filter(Boolean).slice(0, 100).join('\n')}${untracked.truncated ? '\n[File listing truncated.]' : ''}\nNew file contents remain in the worktree; tracked diff does not include them.`, 'file'));
    const after = await snapshotWorkspace(workspacePath!, runner, diff, untracked);
    const comparisonIncomplete = before === null || after === null;
    const worktreeChanged = comparisonIncomplete || before !== after;
    records.push(evidence('Task workspace comparison', comparisonIncomplete ? 'Before/after Git diff or untracked-file metadata comparison was incomplete. Treat the workspace as changed and require renewed review.' : worktreeChanged ? 'The tracked diff or untracked-file metadata changed during this task. Re-review inherited delivery work before acceptance.' : 'The tracked diff and untracked-file metadata were unchanged during this task. This does not prove tests passed and excludes Git-ignored files.', 'command'));
    return {
      ...result, workspacePath, evidence: records, directionRequest: report?.directionRequest, worktreeChanged,
      blockedReason: report?.invalidDirection ? 'Malformed founder direction request: a valid question and summary are required before continuing.' : report?.status === 'blocked' ? report.summary : undefined,
      error: result.timedOut ? 'Provider task reached its time limit; partial work was retained.' : result.truncated ? 'Provider output reached its limit; partial work was retained.' : result.exitCode !== 0 && !result.interrupted ? 'Provider task did not exit successfully. Review its output and retained worktree.' : report?.invalidDirection ? 'Agent requested founder direction without a valid question and summary. Review its report before restarting the task.' : undefined,
    };
  } catch (error) {
    return failure(missingExecutable(error) ? 'A required native CLI is unavailable on this server.' : 'Task runner failed. Any created worktree was retained for inspection.');
  }
}
