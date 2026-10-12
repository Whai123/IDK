import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActionError, WorkspaceEngine } from '../server/engine.ts';
import type { EngineAdapters } from '../server/engine.ts';
import { createWorkspaceServer } from '../server/index.ts';
import { inspectRepository } from '../server/inspector.ts';
import { checkProviders, runCommand, runProviderTask } from '../server/providers.ts';
import type { CommandRunner } from '../server/providers.ts';
import { WorkspaceStore } from '../server/store.ts';
import type { Task, WorkspaceState } from '../src/lib/types.ts';

export const PILOT_TITLE = 'Refresh provider status';
export const PILOT_MISSION = 'Let a founder refresh native provider installation and authentication status in Settings without restarting the app. Preserve sanitized account reporting and explicit opt-in for native execution.';
const SCOPE = `Add an explicit Refresh provider status action in Settings. It must refresh the native CLI installation/authentication checks, save the fresh statuses, and update the interface without restarting. Show useful pending/success/error feedback. The refresh action must never invoke a model, enable native execution, start queued work, reveal account details, or change the company mission. Keep the implementation small and consistent with existing actions and HTTP protections. Add meaningful checks that prove refreshed status is used and refresh cannot start a native task. Run relevant existing tests and the build; report actual commands and results. Stop and ask if product direction is needed.`;
const SETUP_AUTHORIZATION = `This explicit --run invocation authorizes only the Refresh provider status mission and an independent QA handoff. You may use the existing tools and install the exact locked project dependencies in the isolated worktree with npm ci --cache .cache/npm --no-audit --no-fund if needed. Do not add or upgrade dependencies, change the lockfile, install global tools, change accounts, read credentials, commit, merge, push, publish, or deploy. Use npm test and npm run build as appropriate. Browser checks require isolated state and available ports; do not stop another server or reuse a founder's workspace. QA may install locked dependencies and produce ignored test/build outputs, but must not edit product files. Missing runtime capability is a blocker, not permission to bypass sandbox controls.`;

export interface PilotReadiness {
  ready: boolean;
  repoPath: string;
  checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
}
export type PilotOutcome = 'ready_for_review' | 'needs_direction' | 'failed' | 'interrupted' | 'timed_out' | 'blocked';
interface PilotOptions {
  run?: boolean;
  repoPath: string;
  adapters?: EngineAdapters;
  runner?: CommandRunner;
  codexHome?: string;
  temporaryDirectory?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
  serveUi?: boolean;
  keepUiOpen?: boolean;
  timeoutMs?: number;
}
export type PilotResult = { kind: 'readiness'; readiness: PilotReadiness } | {
  kind: 'mission'; outcome: PilotOutcome; stateDirectory: string; engineeringTaskId: string;
  qaTaskId?: string; state: WorkspaceState; url?: string; close: () => Promise<void>;
};

export function parsePilotArgs(args: string[]): { run: boolean; help: boolean } {
  if (args.some((argument) => !['--run', '--help', '-h'].includes(argument))) throw new Error('Usage: npm run pilot [-- --run]. The default checks readiness without running a model.');
  return { run: args.includes('--run'), help: args.includes('--help') || args.includes('-h') };
}
async function writable(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory() && (await access(directory, constants.W_OK), true); } catch { return false; }
}
function adaptersFor(runner: CommandRunner): EngineAdapters {
  return { inspectRepository, checkProviders: () => checkProviders(runner), runProviderTask: (input) => runProviderTask({ ...input, commandRunner: runner, timeoutMs: 600_000 }) };
}

/** Native version/auth status and local filesystem/Git checks only. No prompts or credential reads. */
export async function checkPilotReadiness(options: PilotOptions): Promise<PilotReadiness> {
  const runner = options.runner ?? runCommand, adapters = options.adapters ?? adaptersFor(runner);
  const repoPath = await realpath(options.repoPath);
  const checks: PilotReadiness['checks'] = [];
  const add = (name: string, ok: boolean, detail: string, required = true) => { checks.push({ name, ok, detail, required }); };
  const version = process.versions.node.split('.').map(Number);
  add('Node.js', version[0] > 22 || version[0] === 22 && version[1] >= 18, 'Requires Node.js 22.18 or newer.');
  const git = async (args: string[]) => runner('git', args, { cwd: repoPath, timeoutMs: 8000, outputLimitBytes: 65_536 });
  const successful = (result: Awaited<ReturnType<CommandRunner>>) => result.exitCode === 0 && !result.timedOut && !result.truncated && !result.interrupted;
  try {
    const revision = await git(['rev-parse', '--verify', 'HEAD']);
    add('Committed repository', successful(revision), 'An existing Git commit is required for the isolated worktree.');
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    add('Clean checkout', successful(status) && status.stdout.length === 0, 'Save or move uncommitted changes before this trial. The launcher never commits them.');
    const ignored = await git(['check-ignore', '-q', '--', '.startup-os/local-pilot/probe']);
    add('Ignored pilot storage', successful(ignored), '.startup-os/local-pilot must be Git-ignored so pilot state stays outside the source baseline.');
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    add('Writable Git storage', successful(common) && await writable(resolve(repoPath, common.stdout.trim())), 'Git must be able to register a retained worktree.');
  } catch { add('Git checks', false, 'Git checks could not finish. Install Git and run this command inside the repository.'); }
  add('Writable checkout', await writable(repoPath), 'The launcher needs writable ignored local state storage.');
  add('Writable temporary storage', await writable(options.temporaryDirectory ?? tmpdir()), 'The native adapter creates retained task worktrees in the operating system temporary directory.');
  add('Writable Codex storage', await writable(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')), 'Codex needs writable native storage. Run codex login on this computer if that directory does not exist. No credential contents are read.');
  try {
    const codex = (await adapters.checkProviders()).find((provider) => provider.id === 'codex');
    add('Codex installed', codex?.installed === true, 'Install the native Codex CLI on this computer.');
    add('Codex signed in', codex?.authenticated === true, 'The sanitized native status check must confirm a signed-in account.');
  } catch { add('Codex status', false, 'Native installation/authentication status could not be confirmed.'); }
  const built = await access(join(repoPath, 'dist', 'index.html')).then(() => true, () => false);
  add('Built workspace', built, 'Optional: npm run build makes the full workspace available for later review. The pilot has its own read-only evidence viewer.', false);
  return { ready: checks.every((check) => !check.required || check.ok), repoPath, checks };
}

function qaFor(state: WorkspaceState, engineeringTaskId: string): Task | undefined {
  return state.tasks.find((task) => task.handoff === 'delivery' && task.dependsOn.length === 1 && task.dependsOn[0] === engineeringTaskId);
}
export function observePilotOutcome(state: WorkspaceState, engineeringTaskId: string): PilotOutcome | null {
  const engineering = state.tasks.find((task) => task.id === engineeringTaskId);
  if (!engineering) return 'blocked';
  const blocked = (task: Task): PilotOutcome | null => task.requiresDirection || task.status === 'waiting' ? 'needs_direction' : task.status === 'failed' ? 'failed' : ['paused', 'dismissed', 'done'].includes(task.status) ? 'interrupted' : null;
  const stopped = blocked(engineering); if (stopped) return stopped;
  const qa = qaFor(state, engineeringTaskId);
  if (qa) { const stoppedQA = blocked(qa); if (stoppedQA) return stoppedQA; }
  if (engineering.status === 'review') return !qa ? 'blocked' : qa.status === 'review' ? 'ready_for_review' : null;
  return null;
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function evidencePage(state: WorkspaceState, stateDirectory: string): string {
  const taskHtml = state.tasks.filter((task) => task.runType === 'cli').map((task) => `<section><h2>${escapeHtml(task.title)}</h2><p>Status: <strong>${escapeHtml(task.status)}</strong></p>${task.workspacePath ? `<p>Retained worktree: <code>${escapeHtml(task.workspacePath)}</code></p>` : ''}<details><summary>Recorded output</summary><pre>${escapeHtml(task.artifact || 'No output recorded yet.')}</pre></details>${task.evidence.map((entry) => `<details><summary>${escapeHtml(entry.label)} · ${escapeHtml(entry.source)}</summary><pre>${escapeHtml(entry.detail)}</pre></details>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>Local pilot · read-only</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#dce7e0;background:#17231d}section,aside{padding:20px;background:#23382c;border-radius:12px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}code{overflow-wrap:anywhere}summary{cursor:pointer;margin:10px 0}</style><h1>Local pilot · read-only</h1><aside><strong>${escapeHtml(PILOT_TITLE)}</strong><p>Native execution ${state.config.allowProviderRuns ? 'enabled for this bounded Engineering → QA trial' : 'disabled'}. This page refreshes every 5 seconds.</p><p>Outputs require founder review. A provider exit or agent report is not proof that checks passed. This viewer cannot accept, start, merge, or publish work.</p></aside>${taskHtml}${state.decisions.filter((decision) => decision.status === 'open').map((decision) => `<section><h2>Founder direction needed</h2><p>${escapeHtml(decision.context)}</p></section>`).join('')}<p>Saved state: <code>${escapeHtml(stateDirectory)}</code></p><p>Press Ctrl+C in the terminal to stop the viewer. Retained worktrees and recorded evidence are kept.</p></html>`;
}

/** Explicit run:true is the only path that enables providers or dispatches Start. */
export async function launchLocalPilot(options: PilotOptions): Promise<PilotResult> {
  const log = options.log ?? console.log;
  const runner = options.runner ?? runCommand, adapters = options.adapters ?? adaptersFor(runner);
  const readiness = await checkPilotReadiness({ ...options, adapters, runner });
  for (const check of readiness.checks) log(`${check.ok ? 'OK' : check.required ? 'BLOCKED' : 'OPTIONAL'} · ${check.name}: ${check.detail}`);
  log(`Mission: ${PILOT_TITLE}. Engineering → independent QA → founder review.`);
  log('Readiness checks do not prove native runtime initialization or provider network connectivity. No model was invoked by these checks.');
  if (!options.run) { log(readiness.ready ? 'Ready to attempt. Run npm run pilot -- --run to explicitly start this mission using your Codex quota.' : 'Resolve the blocked checks before attempting the mission.'); return { kind: 'readiness', readiness }; }
  if (!readiness.ready) throw new Error('Pilot readiness failed. No model was invoked.');
  if (options.signal?.aborted) throw new Error('Pilot cancelled before setup. No model was invoked.');
  const parentDirectory = join(readiness.repoPath, '.startup-os', 'local-pilot');
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await mkdtemp(join(parentDirectory, 'run-'));
  const allowedIds = new Set<string>(); let engineeringTaskId = '', qaAgentId = '';
  const boundedAdapters: EngineAdapters = {
    checkProviders: adapters.checkProviders,
    inspectRepository: async (path) => { const inspection = await adapters.inspectRepository(path); return { ...inspection, findings: [] }; },
    runProviderTask: async (input) => {
      const state = engine.getState(), qa = qaFor(state, engineeringTaskId);
      const engineering = state.tasks.find((task) => task.id === engineeringTaskId);
      const isEngineering = input.task.id === engineeringTaskId && input.agent.role === 'Product engineer';
      const isQA = input.task.id === qa?.id && qa.agentId === qaAgentId && input.agent.role === 'Quality engineer' && !!engineering?.workspacePath && input.upstreamWorkspacePath === engineering.workspacePath;
      if (input.provider !== 'codex' || !isEngineering && !isQA || allowedIds.has(input.task.id) || allowedIds.size >= 2) throw new Error('This local pilot permits exactly one Engineering job and its independent QA handoff.');
      allowedIds.add(input.task.id); return adapters.runProviderTask(input);
    },
  };
  const engine = await WorkspaceEngine.open(new WorkspaceStore(stateDirectory), boundedAdapters, { scheduler: false });
  let app: ReturnType<typeof createWorkspaceServer> | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    app?.closeStreams(); app?.server.close();
    await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: false, autoInspect: false, paused: true } }).catch(() => {});
    await engine.close();
  })();
  try {
    await engine.dispatch({ type: 'connect_repo', path: readiness.repoPath, mission: PILOT_MISSION });
    await engine.dispatch({ type: 'import_template', template: { schemaVersion: 1, name: 'Local Codex pilot', mission: PILOT_MISSION, agents: [
      { name: 'Engineering', role: 'Product engineer', departmentId: 'engineering', provider: 'codex', enabled: true },
      { name: 'QA', role: 'Quality engineer', departmentId: 'engineering', provider: 'codex', enabled: true },
    ] } });
    const agents = engine.getState().agents; qaAgentId = agents[1].id;
    await engine.dispatch({ type: 'send_message', text: SETUP_AUTHORIZATION });
    const created = await engine.dispatch({ type: 'create_task', title: PILOT_TITLE, description: SCOPE, departmentId: 'engineering', agentId: agents[0].id, priority: 'high' });
    engineeringTaskId = created.state.tasks.find((task) => task.title === PILOT_TITLE)!.id;
    let url: string | undefined;
    if (options.serveUi !== false) {
      const readOnlyEngine = new Proxy(engine, { get(target, property) { if (property === 'dispatch') return () => { throw new ActionError('This pilot viewer is read-only. Stop the pilot and open its saved workspace to review direction.', 403); }; const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; } });
      app = createWorkspaceServer(readOnlyEngine, { distDirectory: join(readiness.repoPath, 'dist') });
      const requestHandler = app.server.listeners('request')[0];
      app.server.removeAllListeners('request');
      app.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
        const address = app!.server.address(); const port = typeof address === 'object' && address ? address.port : 0;
        if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(request.headers.host ?? '')) { response.writeHead(403); response.end('Invalid local server host.'); return; }
        if (request.url?.startsWith('/api/')) { requestHandler.call(app!.server, request, response); return; }
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        response.end(request.method === 'HEAD' ? undefined : evidencePage(engine.getState(), stateDirectory));
      });
      await new Promise<void>((resolveListen, reject) => { app!.server.once('error', reject); app!.server.listen(0, '127.0.0.1', resolveListen); });
      const address = app.server.address();
      url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : ''}`;
      log(`Read-only evidence viewer: ${url}`);
    }
    log(`Isolated saved state: ${stateDirectory}`);
    let lastStatus = '', started = false;
    let startupPromise: Promise<void> = Promise.resolve();
    let stopPermissionPromise: Promise<void> = Promise.resolve();
    const outcome = await new Promise<PilotOutcome>((resolveOutcome, reject) => {
      let finished = false;
      const cleanup = () => { clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener('abort', onAbort); };
      const finish = (result: PilotOutcome) => {
        if (finished) return; finished = true; cleanup();
        // Enqueue this synchronously, including from the queued-state subscriber.
        // It must precede the engine's reserved runJob, which rechecks permissions.
        stopPermissionPromise = engine.dispatch({ type: 'set_config', config: { allowProviderRuns: false, autoInspect: false, paused: true } }).then(() => { resolveOutcome(result); }, reject);
      };
      const update = (state: WorkspaceState) => {
        const current = state.tasks.filter((task) => task.runType === 'cli').map((task) => `${task.title}: ${task.status}`).join(' | ');
        if (current !== lastStatus) { lastStatus = current; log(current); }
        if (started) { const result = observePilotOutcome(state, engineeringTaskId); if (result) finish(result); }
      };
      const unsubscribe = engine.subscribe(update);
      const onAbort = () => finish('interrupted');
      const timer = setTimeout(() => finish('timed_out'), options.timeoutMs ?? 25 * 60_000);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { finish('interrupted'); return; }
      startupPromise = (async () => {
        try {
          await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true, autoInspect: false, paused: false } });
          if (finished || options.signal?.aborted) { finish('interrupted'); return; }
          await engine.dispatch({ type: 'task_action', taskId: engineeringTaskId, action: 'start' });
          if (finished || options.signal?.aborted) { finish('interrupted'); return; }
          started = true; update(engine.getState());
        } catch (error) {
          if (finished) return; finished = true; cleanup();
          stopPermissionPromise = engine.dispatch({ type: 'set_config', config: { allowProviderRuns: false, autoInspect: false, paused: true } }).then(() => { reject(error); }, () => { reject(error); });
        }
      })();
    });
    await startupPromise;
    await stopPermissionPromise;
    if (['interrupted', 'timed_out'].includes(outcome)) await engine.close();
    const state = engine.getState(), qaTaskId = qaFor(state, engineeringTaskId)?.id;
    await writeFile(join(stateDirectory, 'pilot-result.json'), JSON.stringify({ outcome, engineeringTaskId, qaTaskId, stateDirectory, nativeExecutionDisabled: true, recordedAt: new Date().toISOString(), limitations: ['Provider outputs require founder review.', 'A provider exit is not proof that checks passed.', 'No deliverable was accepted, committed, merged, or published.'], tasks: state.tasks.filter((task) => task.runType === 'cli').map(({ id, title, status, workspacePath }) => ({ id, title, status, workspacePath })) }, null, 2) + '\n', { mode: 0o600 });
    log(`Pilot stopped: ${outcome}. Native execution is disabled. No work was accepted, committed, merged, or published.`);
    for (const task of state.tasks.filter((task) => task.workspacePath)) log(`${task.title} retained at ${task.workspacePath}`);
    log(`Summary: ${join(stateDirectory, 'pilot-result.json')}`);
    if (options.keepUiOpen !== true || options.signal?.aborted) await close();
    return { kind: 'mission', outcome, stateDirectory, engineeringTaskId, qaTaskId, state: engine.getState(), url, close };
  } catch (error) { await close(); throw error; }
}

async function main(): Promise<void> {
  const args = parsePilotArgs(process.argv.slice(2));
  if (args.help) { console.log('npm run pilot: non-billable readiness checks only.\nnpm run pilot -- --run: one real Codex Engineering → Codex QA mission, using your account quota.\nSee docs/LOCAL_PILOT.md.'); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const result = await launchLocalPilot({ run: args.run, repoPath: process.cwd(), signal: controller.signal, serveUi: true, keepUiOpen: true });
  if (result.kind === 'readiness') { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (!result.readiness.ready) process.exitCode = 1; return; }
  if (result.outcome !== 'ready_for_review') process.exitCode = 1;
  if (!controller.signal.aborted) {
    console.log('The read-only viewer remains open. Press Ctrl+C when finished reviewing.');
    await new Promise<void>((done) => { if (controller.signal.aborted) done(); else controller.signal.addEventListener('abort', () => done(), { once: true }); });
  }
  await result.close();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
