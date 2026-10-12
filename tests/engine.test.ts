import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Task } from '../src/lib/types.ts';
import { WorkspaceEngine, validateAction, validateTemplate } from '../server/engine.ts';
import type { EngineAdapters } from '../server/engine.ts';
import { appendCheckpoint, createCheckpoint, HISTORY_BYTE_LIMIT, HISTORY_RETAINED_LIMIT, WorkspaceStore, freshWorkspace } from '../server/store.ts';
import type { HistoryEntry } from '../src/lib/types.ts';

const now = '2026-10-11T00:00:00.000Z';
function task(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: id, description: 'Perform one scoped task.', departmentId: 'marketing', agentId: 'agent-marketing', status: 'proposed', priority: 'medium', source: 'founder', runType: 'cli', missionRevision: 1, dependsOn: [], requiresDirection: false, evidence: [], artifact: '', createdAt: now, updatedAt: now, ...extra };
}
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for the engine.'); await new Promise<void>((resolve) => setImmediate(resolve)); }
}
async function fixture(t: TestContext, options: { tasks?: Task[]; run?: EngineAdapters['runProviderTask']; findings?: Awaited<ReturnType<EngineAdapters['inspectRepository']>>['findings'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'startup-engine-')); const repo = join(directory, 'repo'); await mkdir(repo);
  const store = new WorkspaceStore(join(directory, 'state')); const saved = freshWorkspace();
  saved.activeMode = 'live'; saved.live.company.repoPath = repo; saved.live.company.mission = 'Make one useful developer product.'; saved.live.tasks = options.tasks ?? [];
  await store.save(saved);
  let inspections = 0; const calls: Parameters<EngineAdapters['runProviderTask']>[0][] = [];
  const adapters: EngineAdapters = {
    checkProviders: async () => [{ id: 'claude', installed: true, authenticated: true, detail: 'Fake test provider', checkedAt: now }, { id: 'codex', installed: true, authenticated: true, detail: 'Fake test provider', checkedAt: now }],
    inspectRepository: async (path) => { inspections++; return { repoPath: path, summary: 'Observed metadata only; no scripts run.', findings: options.findings ?? [] }; },
    runProviderTask: async (input) => { calls.push(input); return options.run ? options.run(input) : { exitCode: 0, stdout: 'A draft, not a verified test result.', stderr: '', workspacePath: join(directory, 'retained') }; },
  };
  const engine = await WorkspaceEngine.open(store, adapters, { scheduler: false });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { engine, store, repo, adapters, calls, inspectionCount: () => inspections };
}

test('demo is a clearly sourced ten-role replay and never invokes a native provider', async (t) => {
  const { engine, calls } = await fixture(t);
  await engine.dispatch({ type: 'reset_demo' }); const state = engine.getState();
  assert.equal(state.agents.length, 10); assert.equal(state.agents.filter((agent) => agent.provider === 'claude').length, 5);
  assert.equal(state.agents.filter((agent) => agent.provider === 'codex').length, 5); assert.equal(state.departments.length, 7);
  assert.ok(state.agents.filter((agent) => agent.departmentId === 'marketing').length >= 3);
  await engine.dispatch({ type: 'run_demo_cycle' });
  assert.ok(engine.getState().tasks.every((item) => item.source === 'sample' && item.evidence.every((evidence) => evidence.source === 'sample')));
  assert.equal(calls.length, 0);
  await assert.rejects(engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }), /sample replay/);
});

test('a shared sample decision releases its channel task while QA dependencies remain blocked', async (t) => {
  const { engine } = await fixture(t); await engine.dispatch({ type: 'reset_demo' });
  await engine.dispatch({ type: 'resolve_decision', decisionId: 'demo-launch-channel', optionId: 'community' });
  const state = engine.getState(); assert.equal(state.tasks.find((item) => item.id === 'demo-channel')?.status, 'queued');
  assert.equal(state.tasks.find((item) => item.id === 'demo-email')?.requiresDirection, false);
  assert.equal(state.tasks.find((item) => item.id === 'demo-email')?.status, 'waiting');
  await engine.dispatch({ type: 'task_action', taskId: 'demo-engineering', action: 'pause' });
  await assert.rejects(engine.dispatch({ type: 'task_action', taskId: 'demo-engineering', action: 'accept' }), /awaiting review/);
  assert.ok(state.messages.some((message) => message.role === 'founder' && message.text.includes('Developer communities')));
});

test('mission revisions pause mission work and preserve independent audits until founder direction', async (t) => {
  const { engine } = await fixture(t, { tasks: [task('campaign'), task('audit', { runType: 'audit', status: 'queued', departmentId: 'operations' })] });
  await engine.dispatch({ type: 'set_mission', mission: 'Focus on documentation maintainers.' }); const state = engine.getState();
  assert.equal(state.company.missionRevision, 2); assert.equal(state.tasks[0].status, 'paused'); assert.equal(state.tasks[1].status, 'queued');
  assert.equal(state.decisions.length, 1); assert.deepEqual(state.decisions[0].taskIds, ['campaign']);
  await assert.rejects(engine.dispatch({ type: 'task_action', taskId: 'campaign', action: 'resume' }), /direction/);
  await engine.dispatch({ type: 'resolve_decision', decisionId: state.decisions[0].id, optionId: 'continue', answer: 'Explain the current docs workflow first.' });
  assert.equal(engine.getState().tasks[0].status, 'proposed'); assert.equal(engine.getState().tasks[0].missionRevision, 2);
});

test('demo reset and editing preserve separate live company, tasks and decisions', async (t) => {
  const { engine } = await fixture(t, { tasks: [task('live-plan')] });
  await engine.dispatch({ type: 'set_mission', mission: 'A deliberate live mission.' }); const live = engine.getState();
  await engine.dispatch({ type: 'reset_demo' }); await engine.dispatch({ type: 'rename_company', name: 'Sample sandbox' });
  await engine.dispatch({ type: 'set_mode', mode: 'live' }); const restored = engine.getState();
  assert.deepEqual(restored.company, live.company); assert.deepEqual(restored.tasks, live.tasks); assert.deepEqual(restored.decisions, live.decisions);
});

test('inspection direction is enforced and dismissed findings remain deduplicated after restart', async (t) => {
  const { engine, store, adapters, repo } = await fixture(t, { findings: [{ key: 'product-scope', title: 'Define intended users', description: 'The README provides no product direction.', departmentId: 'product', priority: 'high', requiresDirection: true, evidence: [{ label: 'README missing', detail: 'Observed file absence.', kind: 'file' }] }, { key: 'quickstart', title: 'Write quickstart', description: 'Setup docs are missing.', departmentId: 'support', priority: 'medium', evidence: [] }] });
  await engine.dispatch({ type: 'connect_repo', path: repo }); const state = engine.getState(); const directionTask = state.tasks.find((item) => item.title === 'Define intended users')!;
  assert.equal(directionTask.requiresDirection, true); assert.ok(state.decisions.some((decision) => decision.taskIds.includes(directionTask.id)));
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } });
  await assert.rejects(engine.dispatch({ type: 'task_action', taskId: directionTask.id, action: 'start' }), /current status|direction/);
  const dismiss = state.tasks.find((item) => item.title === 'Write quickstart')!; await engine.dispatch({ type: 'task_action', taskId: dismiss.id, action: 'dismiss' });
  await engine.dispatch({ type: 'inspect_repo' }); assert.equal(engine.getState().tasks.length, state.tasks.length);
  await engine.close(); const reopened = await WorkspaceEngine.open(store, adapters, { scheduler: false });
  await reopened.dispatch({ type: 'inspect_repo' }); assert.equal(reopened.getState().tasks.filter((item) => item.title === 'Write quickstart').length, 1);
  assert.equal(reopened.getState().tasks.find((item) => item.id === dismiss.id)?.status, 'dismissed'); await reopened.close();
});

test('template validation rejects credentials and invalid roles; export contains only portable team fields', async (t) => {
  const { engine } = await fixture(t); const template = engine.getTemplate();
  assert.deepEqual(Object.keys(template).sort(), ['agents', 'mission', 'name', 'schemaVersion']);
  assert.ok(template.agents.every((agent) => !('id' in agent))); assert.equal(validateTemplate(template).agents.length, 10);
  assert.throws(() => validateTemplate({ ...template, repoPath: '/private' }), /Unknown/);
  assert.throws(() => validateTemplate({ ...template, agents: [{ ...template.agents[0], provider: 'untrusted' }] }), /provider/);
  assert.throws(() => validateAction({ type: 'set_config', config: { allowProviderRuns: 'true' } }), /boolean/);
  await engine.dispatch({ type: 'import_template', template: { ...template, name: 'Portable company' } });
  assert.equal(engine.getState().company.name, 'Portable company'); assert.equal(engine.getState().config.allowProviderRuns, false);
  await engine.dispatch({ type: 'import_template', template: { ...template, mission: '' } });
  const unconfiguredTemplate = engine.getTemplate();
  assert.equal(validateTemplate(unconfiguredTemplate).mission, '');
  await engine.dispatch({ type: 'import_template', template: unconfiguredTemplate });
  await assert.rejects(engine.dispatch({ type: 'set_mission', mission: '' }), /nonempty/);
});

test('native jobs are opt-in, serialized, and failures preserve output instead of claiming review', async (t) => {
  let active = 0, maximum = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { engine, calls } = await fixture(t, { tasks: [task('one'), task('two')], run: async (input) => { active++; maximum = Math.max(maximum, active); if (input.task.id === 'one') await gate; active--; return input.task.id === 'one' ? { exitCode: 3, stdout: 'Partial draft preserved', stderr: 'Actual failed command' } : { exitCode: 0, stdout: 'Second draft', stderr: '' }; } });
  await assert.rejects(engine.dispatch({ type: 'task_action', taskId: 'one', action: 'start' }), /Enable native/);
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } });
  await engine.dispatch({ type: 'task_action', taskId: 'one', action: 'start' }); await waitFor(() => calls.length === 1);
  await engine.dispatch({ type: 'task_action', taskId: 'two', action: 'start' }); assert.equal(calls.length, 1);
  release(); await waitFor(() => engine.getState().tasks.every((item) => ['failed', 'review'].includes(item.status)));
  assert.equal(maximum, 1); assert.equal(engine.getState().tasks[0].status, 'failed'); assert.match(engine.getState().tasks[0].artifact, /Partial draft preserved/);
  assert.equal(engine.getState().tasks[1].status, 'review');
});

test('output-limit errors cannot become successful deliverables even with a zero exit code', async (t) => {
  const { engine } = await fixture(t, { tasks: [task('limited')], run: async () => ({ exitCode: 0, stdout: 'Incomplete output', stderr: '', error: 'Output was truncated.', truncated: true }) });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'limited', action: 'start' });
  await waitFor(() => engine.getState().tasks[0].status === 'failed'); assert.match(engine.getState().tasks[0].artifact, /truncated/);
});

test('queued execution rechecks permission when pause, disable, or demo switch wins the queue', async (t) => {
  const changes = [
    { type: 'set_config', config: { allowProviderRuns: false } },
    { type: 'set_config', config: { paused: true } },
    { type: 'set_mode', mode: 'demo' },
    { type: 'reset_demo' },
  ];
  for (const change of changes) {
    const { engine, calls } = await fixture(t, { tasks: [task('reserved')] });
    await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } });
    const start = engine.dispatch({ type: 'task_action', taskId: 'reserved', action: 'start' });
    const revoke = engine.dispatch(change);
    await Promise.all([start, revoke]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0, `No native run after ${JSON.stringify(change)}`);
    const saved = await engine.store.load();
    assert.equal(saved.live.tasks[0].status, 'queued');
  }
});

test('a reserved job cannot run with a role disabled before its preparation', async (t) => {
  const { engine, calls } = await fixture(t, { tasks: [task('reserved-role', { departmentId: 'sales', agentId: 'agent-sales' })] });
  const role = engine.getState().agents.find((agent) => agent.departmentId === 'sales')!;
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } });
  await Promise.all([
    engine.dispatch({ type: 'task_action', taskId: 'reserved-role', action: 'start' }),
    engine.dispatch({ type: 'update_agent', agentId: role.id, enabled: false }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0); assert.equal(engine.getState().tasks[0].status, 'queued');
});

test('mission interruption retains stale provider evidence without overwriting the paused task', async (t) => {
  let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
  const { engine, calls } = await fixture(t, { tasks: [task('in-flight')], run: async (input) => { await gate; return { exitCode: 0, stdout: 'Retained partial output', stderr: '', interrupted: input.signal.aborted, workspacePath: '/retained/test-worktree' }; } });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'in-flight', action: 'start' }); await waitFor(() => calls.length === 1);
  await engine.dispatch({ type: 'set_mission', mission: 'A materially different direction.' }); assert.equal(calls[0].signal.aborted, true);
  finish(); await waitFor(() => engine.getState().tasks[0].artifact.includes('Retained partial output'));
  assert.equal(engine.getState().tasks[0].status, 'paused'); assert.equal(engine.getState().tasks[0].workspacePath, '/retained/test-worktree'); assert.ok(engine.getState().decisions.some((decision) => decision.status === 'open'));
});

test('native direction requests persist; canonical answers survive chat and resume the same worktree', async (t) => {
  const { engine, calls } = await fixture(t, { tasks: [task('direction')], run: async (_input) => calls.length === 1 ? { exitCode: 0, stdout: 'Needs direction', stderr: '', workspacePath: '/retained/direction', directionRequest: { question: 'Which launch audience should this draft target?' } } : { exitCode: 0, stdout: 'Draft for the chosen audience', stderr: '', workspacePath: '/retained/direction', worktreeChanged: false } });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'direction', action: 'start' });
  await waitFor(() => engine.getState().tasks[0].status === 'waiting'); await engine.dispatch({ type: 'set_config', config: { paused: true } });
  const decision = engine.getState().decisions[0]; await engine.dispatch({ type: 'resolve_decision', decisionId: decision.id, answer: 'Documentation maintainers.' });
  for (let index = 0; index < 25; index++) await engine.dispatch({ type: 'send_message', text: `New context ${index}` });
  await engine.dispatch({ type: 'set_config', config: { paused: false } }); await waitFor(() => calls.length === 2);
  assert.equal(calls[1].upstreamWorkspacePath, '/retained/direction'); assert.ok(calls[1].decisions?.some((item) => item.answer === 'Documentation maintainers.'));
  await waitFor(() => engine.getState().tasks[0].status === 'review');
});

test('engineering delivery creates one QA handoff in its retained worktree before founder acceptance', async (t) => {
  const { engine, calls } = await fixture(t, { tasks: [task('implementation', { departmentId: 'engineering', agentId: 'agent-engineer' })], run: async () => ({ exitCode: 0, stdout: 'Provider output without verification claims', stderr: '', workspacePath: '/retained/implementation', worktreeChanged: false }) });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'implementation', action: 'start' });
  await waitFor(() => calls.length === 2 && engine.getState().tasks.every((item) => item.status === 'review'));
  const qa = engine.getState().tasks.find((item) => item.id !== 'implementation')!;
  assert.equal(qa.handoff, 'delivery'); assert.deepEqual(qa.dependsOn, ['implementation']); assert.equal(calls[1].upstreamWorkspacePath, '/retained/implementation');
  assert.ok(calls[1].messages.some((message) => message.taskId === 'implementation' && message.text.includes('Provider output')));
  assert.equal(engine.getState().tasks.length, 2); assert.equal(engine.getState().tasks[0].status, 'review');
  assert.equal(engine.getHistory().entries.filter((entry) => entry.kind === 'provider_completed').length, 2);
});

test('restart recovers running jobs as interrupted rather than retrying silently', async (t) => {
  const { engine } = await fixture(t, { tasks: [task('lost-job', { status: 'running', artifact: 'Previous partial work', workspacePath: '/retained/old' })] });
  assert.equal(engine.getState().tasks[0].status, 'paused'); assert.equal(engine.getState().runtime.status, 'interrupted');
  assert.match(engine.getState().runtime.error ?? '', /server stopped/); assert.equal(engine.getState().tasks[0].artifact, 'Previous partial work');
});

test('legacy state starts truthful history now; mission decisions produce immutable persisted checkpoints', async (t) => {
  const { engine, store, adapters } = await fixture(t, { tasks: [task('plan')] });
  const baseline = engine.getHistory().entries.find((entry) => entry.kind === 'baseline')!;
  assert.ok(baseline); assert.match(baseline.detail, /No earlier company history/); assert.equal(baseline.source, 'live');
  assert.equal('history' in engine.getState(), false); assert.equal('snapshot' in baseline, false);
  await engine.dispatch({ type: 'set_mission', mission: 'Make onboarding understandable.' });
  const revision = engine.getHistory().entries[0]; assert.equal(revision.kind, 'set_mission'); assert.deepEqual(revision.taskIds, ['plan']); assert.equal(revision.decisionIds.length, 1);
  const frozen = engine.getHistoryCheckpoint(revision.id); assert.equal(frozen.snapshot.tasks[0].status, 'paused'); assert.equal(frozen.missionRevision, 2);
  await engine.dispatch({ type: 'resolve_decision', decisionId: revision.decisionIds[0], optionId: 'continue' });
  assert.equal(engine.getState().tasks[0].status, 'proposed'); assert.equal(engine.getHistoryCheckpoint(revision.id).snapshot.tasks[0].status, 'paused');
  frozen.snapshot.company.mission = 'Caller mutation'; assert.equal(engine.getHistoryCheckpoint(revision.id).snapshot.company.mission, 'Make onboarding understandable.');
  await engine.close(); const restarted = await WorkspaceEngine.open(store, adapters, { scheduler: false });
  assert.equal(restarted.getHistoryCheckpoint(revision.id).snapshot.tasks[0].status, 'paused');
  await restarted.dispatch({ type: 'set_mode', mode: 'demo' });
  assert.ok(restarted.getHistory().entries.every((entry) => entry.source === 'sample'));
  assert.throws(() => restarted.getHistoryCheckpoint(revision.id), (error: unknown) => (error as { status: number }).status === 404);
  await restarted.close();
});

test('task authoring validates roles and dependencies and remains proposed after direction with native runs enabled', async (t) => {
  const { engine, calls, store, adapters } = await fixture(t, { tasks: [task('accepted-parent', { status: 'done' })] });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } });
  await assert.rejects(engine.dispatch({ type: 'create_task', title: 'Wrong owner', description: 'A scoped proposal.', departmentId: 'marketing', agentId: 'agent-qa' }), /teammate/);
  await assert.rejects(engine.dispatch({ type: 'create_task', title: 'Missing predecessor', description: 'A scoped proposal.', departmentId: 'marketing', dependsOn: ['missing'] }), /dependency/);
  assert.throws(() => validateAction({ type: 'create_task', title: 'Duplicate', description: 'A scoped proposal.', departmentId: 'marketing', dependsOn: ['accepted-parent', 'accepted-parent'] }), /unique/);
  await engine.dispatch({ type: 'create_task', title: 'Draft an onboarding campaign', description: 'Use the accepted brief, then ask the founder about the channel.', departmentId: 'marketing', dependsOn: ['accepted-parent'], requiresDirection: true });
  const created = engine.getState().tasks.at(-1)!; assert.equal(created.source, 'founder'); assert.equal(created.status, 'waiting'); assert.equal(created.stage, 'launch');
  const decision = engine.getState().decisions.find((entry) => entry.taskIds.includes(created.id))!;
  await engine.dispatch({ type: 'resolve_decision', decisionId: decision.id, answer: 'A short community walkthrough.' });
  assert.equal(engine.getState().tasks.at(-1)?.status, 'proposed'); assert.equal(calls.length, 0);
  assert.equal(engine.getHistory().entries.find((entry) => entry.kind === 'create_task')?.taskIds.includes(created.id), true);
  await engine.close(); const restarted = await WorkspaceEngine.open(store, adapters, { scheduler: false });
  await restarted.tick(); assert.equal(calls.length, 0); assert.equal(restarted.getState().tasks.at(-1)?.status, 'proposed'); await restarted.close();
});

test('HTML previews are provided records with size validation, clearing, and immutable historical content', async (t) => {
  const { engine, calls } = await fixture(t, { tasks: [task('preview')] });
  const html = '<!doctype html><button onclick="this.textContent=\'Changed\'">Sample interaction</button>';
  await engine.dispatch({ type: 'set_task_preview', taskId: 'preview', html });
  const checkpoint = engine.getHistory().entries[0];
  assert.equal(engine.getState().tasks[0].preview?.source, 'founder'); assert.equal(engine.getHistoryCheckpoint(checkpoint.id).snapshot.tasks[0].preview?.html, html);
  await assert.rejects(engine.dispatch({ type: 'set_task_preview', taskId: 'preview', html: '€'.repeat(30000) }), /64 KiB/);
  await assert.rejects(engine.dispatch({ type: 'set_task_preview', taskId: 'missing', html }), /Unknown task/);
  await engine.dispatch({ type: 'set_task_preview', taskId: 'preview', html: null }); assert.equal(engine.getState().tasks[0].preview, undefined);
  assert.equal(engine.getHistoryCheckpoint(checkpoint.id).snapshot.tasks[0].preview?.html, html); assert.equal(calls.length, 0);
  await engine.dispatch({ type: 'reset_demo' }); const sample = engine.getState();
  assert.equal(sample.tasks.find((entry) => entry.id === 'demo-engineering')?.preview?.source, 'sample');
  assert.deepEqual(sample.tasks.find((entry) => entry.id === 'demo-design')?.dependsOn, ['demo-positioning']);
  assert.equal(sample.tasks.find((entry) => entry.id === 'demo-qa')?.stage, 'verify');
});

test('history captures real provider start, failure output and recovery rather than fabricated completion', async (t) => {
  const { engine } = await fixture(t, { tasks: [task('job')], run: async () => ({ exitCode: 2, stdout: 'Actual partial draft', stderr: 'Actual failed check' }) });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'job', action: 'start' });
  await waitFor(() => engine.getState().tasks[0].status === 'failed');
  const entries = engine.getHistory().entries; const started = entries.find((entry) => entry.kind === 'provider_started')!; const failed = entries.find((entry) => entry.kind === 'provider_failed')!;
  assert.equal(engine.getHistoryCheckpoint(started.id).snapshot.tasks[0].status, 'running');
  const output = engine.getHistoryCheckpoint(failed.id).snapshot.tasks[0]; assert.equal(output.status, 'failed'); assert.match(output.artifact, /Actual partial draft/);
  assert.equal(entries.some((entry) => entry.kind === 'provider_completed'), false);
  const interrupted = await fixture(t, { tasks: [task('lost', { status: 'running' })] });
  const recovery = interrupted.engine.getHistory().entries.find((entry) => entry.kind === 'recovery')!;
  assert.equal(interrupted.engine.getHistoryCheckpoint(recovery.id).snapshot.tasks[0].status, 'paused');
  const baseline = interrupted.engine.getHistory().entries.find((entry) => entry.kind === 'baseline')!;
  assert.equal(interrupted.engine.getHistoryCheckpoint(baseline.id).snapshot.tasks[0].status, 'running');
});

test('history bounds retain newest snapshots, report dropped entries and clip output without changing current work', async (t) => {
  const { store } = await fixture(t); const data = freshWorkspace();
  const metadata = (id: string): HistoryEntry => ({ id, recordedAt: now, kind: 'test', title: 'Recorded mutation', detail: 'Test checkpoint.', source: 'live', taskIds: [], decisionIds: [], missionRevision: 1, limitations: [] });
  for (let index = 0; index < HISTORY_RETAINED_LIMIT + 5; index++) appendCheckpoint(data, 'live', createCheckpoint(data.live, metadata(`count-${index}`)));
  assert.equal(data.history!.live.checkpoints.length, HISTORY_RETAINED_LIMIT); assert.equal(data.history!.live.droppedCount, 5);
  assert.equal(data.history!.live.checkpoints[0].id, 'count-84');
  data.live.tasks = Array.from({ length: 70 }, (_, index) => task(`large-${index}`, { artifact: 'Large retained output '.repeat(5000) }));
  for (let index = 0; index < 20; index++) appendCheckpoint(data, 'live', createCheckpoint(data.live, metadata(`bytes-${index}`)));
  assert.ok(Buffer.byteLength(JSON.stringify(data.history!.live.checkpoints)) <= HISTORY_BYTE_LIMIT);
  assert.equal(data.history!.live.checkpoints[0].id, 'bytes-19'); assert.ok(data.history!.live.droppedCount > 5);
  const latest = data.history!.live.checkpoints[0]; assert.match(latest.snapshot.tasks[0].artifact, /Historical excerpt clipped/); assert.ok(latest.limitations.some((entry) => entry.includes('excerpts or omissions')));
  assert.equal(data.live.tasks[0].artifact.includes('Historical excerpt clipped'), false);
  await store.save(data); const restored = await store.load(); assert.equal(restored.history!.live.checkpoints[0].id, 'bytes-19'); assert.equal(restored.history!.live.droppedCount, data.history!.live.droppedCount);
});

test('shutdown checkpoints show interruption and retain late partial output without claiming completion', async (t) => {
  const { engine, calls, store } = await fixture(t, { tasks: [task('closing')], run: async (input) => {
    await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { exitCode: null, interrupted: true, stdout: 'Partial output retained during shutdown.', stderr: '', workspacePath: '/retained/shutdown' };
  } });
  await engine.dispatch({ type: 'set_config', config: { allowProviderRuns: true } }); await engine.dispatch({ type: 'task_action', taskId: 'closing', action: 'start' }); await waitFor(() => calls.length === 1);
  await engine.close();
  const history = engine.getHistory().entries; const closed = history.find((entry) => entry.kind === 'shutdown')!;
  assert.equal(engine.getHistoryCheckpoint(closed.id).snapshot.tasks[0].status, 'paused');
  const retained = history.find((entry) => entry.kind === 'provider_interrupted')!;
  assert.match(engine.getHistoryCheckpoint(retained.id).snapshot.tasks[0].artifact, /Partial output retained/);
  assert.equal(history.some((entry) => entry.kind === 'provider_completed'), false);
  assert.equal((await store.load()).live.tasks[0].status, 'paused');
  const length = history.length; await engine.close(); assert.equal(engine.getHistory().entries.length, length);
});
