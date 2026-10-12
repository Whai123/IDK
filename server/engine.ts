import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { ActionResponse, Agent, Decision, DepartmentId, Evidence, HistoryCheckpoint, HistoryEntry, HistoryResponse, Message, ProviderStatus, RuntimeConfig, Task, TaskStatus, TeamTemplate, WorkspaceAction, WorkspaceState } from '../src/lib/types.ts';
import { createState, departments, inferTaskStage } from './seed.ts';
import { appendCheckpoint, createCheckpoint, HISTORY_RETAINED_LIMIT, WorkspaceStore } from './store.ts';
import type { PersistedWorkspace } from './store.ts';

type Finding = { key: string; title: string; description: string; departmentId: DepartmentId; priority: Task['priority']; requiresDirection?: boolean; evidence: { label: string; detail: string; kind: Evidence['kind'] }[]; artifact?: string };
type Inspection = { repoPath?: string; summary: string; findings: Finding[] };
type ProviderResult = { exitCode: number | null; stdout: string; stderr: string; workspacePath?: string; interrupted?: boolean; timedOut?: boolean; truncated?: boolean; worktreeChanged?: boolean; evidence?: Evidence[]; error?: string; directionRequest?: { question: string; options?: { id: string; label: string; description: string }[]; recommendationId?: string }; blockedReason?: string };
export interface EngineAdapters {
  inspectRepository(path: string): Promise<Inspection>;
  checkProviders(): Promise<ProviderStatus[]>;
  runProviderTask(input: { provider: Agent['provider']; repoPath: string; upstreamWorkspacePath?: string; decisions?: Pick<Decision, 'id' | 'title' | 'answer' | 'departmentId' | 'taskIds' | 'answeredAt'>[]; task: Pick<Task, 'id' | 'title' | 'description'>; agent: Pick<Agent, 'name' | 'role' | 'departmentId'>; mission: string; messages: Message[]; signal: AbortSignal }): Promise<ProviderResult>;
}
export class ActionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const departmentIds = new Set(departments.map((department) => department.id));
const providers = new Set(['claude', 'codex']);
const terminal = new Set<TaskStatus>(['done', 'dismissed', 'review', 'failed']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ActionError('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 4000, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || value.includes('\0')) throw new ActionError(`${label} must be ${allowEmpty ? '' : 'nonempty '}text, at most ${max} characters.`);
  return value.trim();
}
function choice<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) throw new ActionError(`Invalid ${label}.`);
  return value as T;
}
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new ActionError(`${label} must be a boolean.`); return value; }
function keys(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ActionError('Unknown action fields.'); }

export function validateTemplate(input: unknown): TeamTemplate {
  const template = object(input); keys(template, ['schemaVersion', 'name', 'mission', 'agents']);
  if (template.schemaVersion !== 1) throw new ActionError('Unsupported team template version.');
  if (!Array.isArray(template.agents) || template.agents.length < 1 || template.agents.length > 100) throw new ActionError('A team template needs between 1 and 100 roles.');
  return { schemaVersion: 1, name: string(template.name, 'Company name', 80), mission: string(template.mission, 'Mission', 4000, true), agents: template.agents.map((input) => {
    const agent = object(input); keys(agent, ['name', 'role', 'departmentId', 'provider', 'enabled']);
    return { name: string(agent.name, 'Agent name', 80), role: string(agent.role, 'Agent role', 1000), departmentId: choice(agent.departmentId, departmentIds, 'department'), provider: choice(agent.provider, providers, 'provider') as Agent['provider'], enabled: bool(agent.enabled, 'enabled') };
  }) };
}

export function validateAction(input: unknown): WorkspaceAction {
  const a = object(input);
  switch (a.type) {
    case 'set_mission': keys(a, ['type', 'mission']); return { type: a.type, mission: string(a.mission, 'Mission') };
    case 'rename_company': keys(a, ['type', 'name']); return { type: a.type, name: string(a.name, 'Company name', 80) };
    case 'connect_repo': keys(a, ['type', 'path', 'mission']); return { type: a.type, path: string(a.path, 'Repository path', 4096), ...(a.mission === undefined ? {} : { mission: string(a.mission, 'Mission') }) };
    case 'set_mode': keys(a, ['type', 'mode']); return { type: a.type, mode: choice(a.mode, new Set(['demo', 'live']), 'mode') };
    case 'reset_demo': case 'inspect_repo': case 'run_demo_cycle': keys(a, ['type']); return { type: a.type };
    case 'set_config': {
      keys(a, ['type', 'config']); const config = object(a.config); keys(config, ['paused', 'autoInspect', 'allowProviderRuns', 'cycleSeconds']);
      const result: Partial<RuntimeConfig> = {};
      for (const key of ['paused', 'autoInspect', 'allowProviderRuns'] as const) if (config[key] !== undefined) result[key] = bool(config[key], key);
      if (config.cycleSeconds !== undefined) { if (!Number.isInteger(config.cycleSeconds) || (config.cycleSeconds as number) < 10 || (config.cycleSeconds as number) > 86400) throw new ActionError('cycleSeconds must be an integer between 10 and 86400.'); result.cycleSeconds = config.cycleSeconds as number; }
      return { type: a.type, config: result };
    }
    case 'resolve_decision': keys(a, ['type', 'decisionId', 'optionId', 'answer']); if (a.optionId === undefined && a.answer === undefined) throw new ActionError('Choose an option or provide an answer.'); return { type: a.type, decisionId: string(a.decisionId, 'Decision ID', 200), ...(a.optionId === undefined ? {} : { optionId: string(a.optionId, 'Option ID', 200) }), ...(a.answer === undefined ? {} : { answer: string(a.answer, 'Answer') }) };
    case 'task_action': keys(a, ['type', 'taskId', 'action']); return { type: a.type, taskId: string(a.taskId, 'Task ID', 200), action: choice(a.action, new Set(['start', 'pause', 'resume', 'dismiss', 'accept']), 'task action') };
    case 'create_task': {
      keys(a, ['type', 'title', 'description', 'departmentId', 'agentId', 'priority', 'dependsOn', 'requiresDirection']);
      let dependsOn: string[] | undefined;
      if (a.dependsOn !== undefined) { if (!Array.isArray(a.dependsOn) || a.dependsOn.length > 100) throw new ActionError('dependsOn must contain at most 100 task IDs.'); dependsOn = a.dependsOn.map((id) => string(id, 'Dependency ID', 200)); if (new Set(dependsOn).size !== dependsOn.length) throw new ActionError('Dependencies must be unique.'); }
      return { type: a.type, title: string(a.title, 'Task title', 160), description: string(a.description, 'Task description', 8000), departmentId: choice(a.departmentId, departmentIds, 'department'), ...(a.agentId === undefined ? {} : { agentId: string(a.agentId, 'Agent ID', 200) }), ...(a.priority === undefined ? {} : { priority: choice(a.priority, new Set(['high', 'medium', 'low'] as const), 'priority') }), ...(dependsOn === undefined ? {} : { dependsOn }), ...(a.requiresDirection === undefined ? {} : { requiresDirection: bool(a.requiresDirection, 'requiresDirection') }) };
    }
    case 'set_task_preview': {
      keys(a, ['type', 'taskId', 'html']);
      const html = a.html === null ? null : string(a.html, 'HTML preview', 65536, true);
      if (html !== null && Buffer.byteLength(html, 'utf8') > 65536) throw new ActionError('HTML preview must be at most 64 KiB.');
      return { type: a.type, taskId: string(a.taskId, 'Task ID', 200), html };
    }
    case 'send_message': keys(a, ['type', 'text']); return { type: a.type, text: string(a.text, 'Message', 8000) };
    case 'add_agent': keys(a, ['type', 'name', 'role', 'departmentId', 'provider']); return { type: a.type, name: string(a.name, 'Agent name', 80), role: string(a.role, 'Role', 1000), departmentId: choice(a.departmentId, departmentIds, 'department'), provider: choice(a.provider, providers, 'provider') as Agent['provider'] };
    case 'update_agent': {
      keys(a, ['type', 'agentId', 'name', 'role', 'provider', 'enabled']);
      return { type: a.type, agentId: string(a.agentId, 'Agent ID', 200), ...(a.name === undefined ? {} : { name: string(a.name, 'Agent name', 80) }), ...(a.role === undefined ? {} : { role: string(a.role, 'Role', 1000) }), ...(a.provider === undefined ? {} : { provider: choice(a.provider, providers, 'provider') as Agent['provider'] }), ...(a.enabled === undefined ? {} : { enabled: bool(a.enabled, 'enabled') }) };
    }
    case 'import_template': keys(a, ['type', 'template']); return { type: a.type, template: validateTemplate(a.template) };
    default: throw new ActionError('Unknown workspace action.');
  }
}

export class WorkspaceEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(state: WorkspaceState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private job: { taskId: string; controller: AbortController; invalidated: boolean; promise: Promise<void> | null } | null = null;
  private persisted: Record<'demo' | 'live', WorkspaceState>;
  private constructor(private data: PersistedWorkspace, readonly store: WorkspaceStore, private adapters: EngineAdapters, private now: () => Date) { this.persisted = { demo: structuredClone(data.demo), live: structuredClone(data.live) }; }

  static async open(store: WorkspaceStore, adapters: EngineAdapters, options: { now?: () => Date; scheduler?: boolean } = {}): Promise<WorkspaceEngine> {
    const engine = new WorkspaceEngine(await store.load(), store, adapters, options.now ?? (() => new Date()));
    for (const mode of ['demo', 'live'] as const) {
      const state = engine.data[mode];
      for (const task of state.tasks) task.stage ??= inferTaskStage(task, state.agents.find((agent) => agent.id === task.agentId)?.role);
      if (!engine.data.history?.[mode]?.checkpoints.length) engine.record(mode, 'baseline', 'Checkpoint recording started', 'The current saved state was captured when this server opened. No earlier company history has been reconstructed.', ['This baseline records the state available at load time; seeded sample statuses are illustrative, not past executions. Older tasks may have inferred stage labels.']);
    }
    const live = engine.data.live;
    const running = live.tasks.filter((task) => task.status === 'running');
    if (running.length) {
      for (const task of running) { task.status = 'paused'; task.updatedAt = engine.time(); engine.data.pausedFrom[task.id] = 'queued'; }
      live.runtime.status = 'interrupted'; live.runtime.error = 'The server stopped during a job. Its task is paused; inspect retained evidence before resuming.'; live.runtime.activeTaskId = null;
      engine.activity(live, 'Interrupted work recovered', live.runtime.error);
    }
    live.providers = await adapters.checkProviders();
    engine.data.demo.providers = structuredClone(live.providers);
    engine.refresh(live);
    await engine.persist(running.length ? 'recovery' : 'workspace_opened', running.length ? 'Interrupted work recovered' : 'Workspace opened', running.length ? live.runtime.error! : 'Provider availability was checked; no provider job was invoked.');
    if (options.scheduler !== false) engine.timer = setInterval(() => { void engine.tick(); }, 1000);
    return engine;
  }
  private time(): string { return this.now().toISOString(); }
  getState(): WorkspaceState { return structuredClone(this.data[this.data.activeMode]); }
  getHistory(): HistoryResponse {
    const history = this.data.history?.[this.data.activeMode];
    return { entries: (history?.checkpoints ?? []).map(({ snapshot: _snapshot, ...entry }) => structuredClone(entry)), retainedLimit: HISTORY_RETAINED_LIMIT, droppedCount: history?.droppedCount ?? 0 };
  }
  getHistoryCheckpoint(id: string): HistoryCheckpoint {
    const checkpoint = this.data.history?.[this.data.activeMode].checkpoints.find((entry) => entry.id === id);
    if (!checkpoint) throw new ActionError('Unknown history checkpoint.', 404);
    return structuredClone(checkpoint);
  }
  private record(mode: 'demo' | 'live', kind: string, title: string, detail: string, limitations: string[] = []): void {
    const state = this.data[mode], previous = this.persisted[mode];
    const changedIds = <T extends { id: string }>(current: T[], old: T[]): string[] => { const prior = new Map(old.map((item) => [item.id, JSON.stringify(item)])), present = new Set(current.map((item) => item.id)); return [...current.filter((item) => prior.get(item.id) !== JSON.stringify(item)).map((item) => item.id), ...old.filter((item) => !present.has(item.id)).map((item) => item.id)]; };
    const entry: HistoryEntry = { id: randomUUID(), recordedAt: this.time(), kind, title, detail: detail.slice(0, 4000), source: mode === 'demo' ? 'sample' : 'live', taskIds: changedIds(state.tasks, previous.tasks), decisionIds: changedIds(state.decisions, previous.decisions), missionRevision: state.company.missionRevision, limitations: [...limitations, 'A recorded workspace checkpoint is not a Git snapshot, a rollback, or proof that tests passed.'] };
    appendCheckpoint(this.data, mode, createCheckpoint(state, entry));
  }
  private async persist(kind: string, title: string, detail: string, forceModes: ('demo' | 'live')[] = []): Promise<void> {
    const before = structuredClone(this.data.history);
    for (const mode of ['demo', 'live'] as const) if (forceModes.includes(mode) || JSON.stringify(this.persisted[mode]) !== JSON.stringify(this.data[mode])) this.record(mode, kind, title, detail);
    try { await this.store.save(this.data); }
    catch (error) { this.data.history = before; throw error; }
    this.persisted = { demo: structuredClone(this.data.demo), live: structuredClone(this.data.live) };
  }
  getTemplate(): TeamTemplate {
    const state = this.data[this.data.activeMode];
    return { schemaVersion: 1, name: state.company.name, mission: state.company.mission, agents: state.agents.map(({ id: _id, ...agent }) => structuredClone(agent)) };
  }
  subscribe(listener: (state: WorkspaceState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(): void { const state = this.getState(); for (const listener of this.listeners) { try { listener(state); } catch { /* A disconnected subscriber cannot fail a saved action. */ } } }
  private locked<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result; }
  private activity(state: WorkspaceState, title: string, detail: string, departmentId: DepartmentId | null = null): void { state.activity.unshift({ id: randomUUID(), title, detail, departmentId, source: state.mode === 'demo' ? 'sample' : 'live', createdAt: this.time() }); state.activity = state.activity.slice(0, 250); }
  private message(state: WorkspaceState, text: string, role: Message['role'] = 'system', author = 'Workspace'): void { state.messages.push({ id: randomUUID(), author, role, text, taskId: null, source: state.mode === 'demo' ? 'sample' : 'live', createdAt: this.time() }); }
  private dependenciesDone(state: WorkspaceState, task: Task): boolean {
    return task.dependsOn.every((id) => state.tasks.some((parent) => parent.id === id && (task.handoff === 'delivery' ? ['review', 'done'].includes(parent.status) && !!parent.workspacePath : parent.status === 'done')));
  }
  private directionOpen(state: WorkspaceState, task: Task): boolean { return state.decisions.some((decision) => decision.status === 'open' && decision.taskIds.includes(task.id)); }
  private taskMatchesRepo(state: WorkspaceState, task: Task): boolean {
    const entry = Object.entries(this.data.findingTaskIds).find(([, id]) => id === task.id);
    return !entry || entry[0].startsWith(`${state.company.repoPath}\0`);
  }
  private ask(state: WorkspaceState, task: Task, title: string, context: string, options = [{ id: 'continue', label: 'Continue with my direction', description: 'Your answer is shared with subsequent jobs.' }], recommendationId: string | null = null): void {
    if (this.directionOpen(state, task)) return;
    task.requiresDirection = true;
    state.decisions.unshift({ id: randomUUID(), title, context, departmentId: task.departmentId, options, recommendationId, taskIds: [task.id], status: 'open', answer: null, source: state.mode === 'demo' ? 'sample' : task.source === 'repo' ? 'repo' : 'founder', createdAt: this.time(), answeredAt: null });
  }
  private release(state: WorkspaceState): void {
    for (const task of state.tasks) {
      task.requiresDirection = this.directionOpen(state, task);
      if (task.status === 'waiting' && !task.requiresDirection && this.dependenciesDone(state, task)) { task.status = this.data.unstartedTaskIds?.includes(task.id) ? 'proposed' : 'queued'; task.updatedAt = this.time(); }
    }
  }
  private refresh(state: WorkspaceState): void {
    const running = state.tasks.find((task) => task.status === 'running');
    state.runtime.activeTaskId = running?.id ?? null;
    if (state.config.paused) state.runtime.status = 'paused';
    else if (running) state.runtime.status = 'working';
    else if (state.runtime.error && state.runtime.status === 'interrupted') state.runtime.status = 'interrupted';
    else if (state.mode === 'live' && state.config.autoInspect && state.company.repoPath) state.runtime.status = 'scheduled';
    else state.runtime.status = 'waiting';
    if (state.mode === 'live' && !state.config.paused && state.config.autoInspect && state.company.repoPath) state.runtime.nextCycleAt ??= new Date(this.now().getTime() + state.config.cycleSeconds * 1000).toISOString();
    else state.runtime.nextCycleAt = null;
  }
  private abortTask(taskId: string): void { if (this.job?.taskId === taskId) { this.job.invalidated = true; this.job.controller.abort(); } }

  private mission(state: WorkspaceState, mission: string): void {
    if (state.company.mission === mission) return;
    state.company.mission = mission; state.company.missionRevision++;
    const affected = state.tasks.filter((task) => !terminal.has(task.status) && task.runType !== 'audit' && !(task.source === 'sample' && ['support', 'operations'].includes(task.departmentId)));
    for (const task of affected) {
      if (task.status !== 'paused') this.data.pausedFrom[task.id] = task.status === 'running' ? 'queued' : task.status;
      this.abortTask(task.id); task.status = 'paused'; task.requiresDirection = true; task.updatedAt = this.time();
    }
    if (affected.length) state.decisions.unshift({ id: randomUUID(), title: 'Confirm the team’s direction after the mission change', context: `Mission revision ${state.company.missionRevision}: ${mission}\n${affected.length} unfinished mission-dependent tasks are paused. Audit work remains independent. Explain how existing plans should relate to the new mission; no replacement plan has been generated.`, departmentId: 'product', options: [
      { id: 'continue', label: 'Continue the existing plans', description: 'Release existing tasks with the updated mission and your shared explanation.' },
      { id: 'revise', label: 'Revise before continuing', description: 'Add the required changes in your answer; the team receives them when tasks resume.' },
    ], recommendationId: null, taskIds: affected.map((task) => task.id), status: 'open', answer: null, source: state.mode === 'demo' ? 'sample' : 'founder', createdAt: this.time(), answeredAt: null });
    this.message(state, `Founder updated the mission (revision ${state.company.missionRevision}): ${mission}`, 'founder', 'Founder');
    this.activity(state, 'Mission updated', affected.length ? `${affected.length} tasks paused for a shared direction decision. Independent audits continue.` : 'New direction saved. Existing completed work was not rewritten.');
  }

  private async inspect(state: WorkspaceState, inspection?: Inspection): Promise<void> {
    if (!state.company.repoPath) throw new ActionError('Connect a local repository first.', 409);
    const result = inspection ?? await this.adapters.inspectRepository(state.company.repoPath);
    const now = this.time();
    for (const finding of result.findings) {
      const key = `${state.company.repoPath}\0${finding.key}`;
      if (this.data.findingTaskIds[key] || this.data.dismissedFindingKeys.includes(key)) continue;
      const id = randomUUID(); this.data.findingTaskIds[key] = id;
      const agent = state.agents.find((role) => role.enabled && role.departmentId === finding.departmentId);
      const task: Task = { id, title: finding.title, description: finding.description, departmentId: finding.departmentId, stage: inferTaskStage(finding, agent?.role), agentId: agent?.id ?? null, status: finding.requiresDirection ? 'waiting' : 'proposed', priority: finding.priority, source: 'repo', runType: 'cli', missionRevision: state.company.missionRevision, dependsOn: [], requiresDirection: !!finding.requiresDirection,
        evidence: finding.evidence.map((evidence) => ({ ...evidence, id: randomUUID(), source: 'observed', recordedAt: now })), artifact: finding.artifact ?? '', createdAt: now, updatedAt: now };
      state.tasks.push(task);
      if (finding.requiresDirection) this.ask(state, task, `Direction needed: ${finding.title}`, finding.description);
    }
    const auditKey = `${state.company.repoPath}\0workspace-audit`;
    let audit = state.tasks.find((task) => task.id === this.data.findingTaskIds[auditKey]);
    const evidence: Evidence[] = result.findings.flatMap((finding) => finding.evidence).slice(0, 30).map((item) => ({ ...item, id: randomUUID(), source: 'observed', recordedAt: now }));
    if (!audit) {
      audit = { id: randomUUID(), title: 'Review repository inspection', description: 'A read-only inspection of repository files and setup signals. This is not a test run or a provider-generated implementation.', departmentId: 'operations', stage: 'operations', agentId: state.agents.find((agent) => agent.enabled && agent.departmentId === 'operations')?.id ?? null, status: 'review', priority: 'low', source: 'repo', runType: 'audit', missionRevision: state.company.missionRevision, dependsOn: [], requiresDirection: false, evidence, artifact: result.summary, createdAt: now, updatedAt: now };
      this.data.findingTaskIds[auditKey] = audit.id; state.tasks.push(audit);
    } else if (!['dismissed', 'done'].includes(audit.status)) { audit.artifact = result.summary; audit.evidence = evidence; audit.updatedAt = now; }
    state.runtime.lastCycleAt = now; state.runtime.nextCycleAt = new Date(this.now().getTime() + state.config.cycleSeconds * 1000).toISOString(); state.runtime.error = null;
    this.activity(state, 'Repository inspected', `${result.summary}\nExisting and dismissed proposals are not duplicated.`, 'operations');
  }

  private createQA(state: WorkspaceState, parent: Task): void {
    if (parent.departmentId !== 'engineering' || parent.handoff === 'delivery' || !parent.workspacePath) return;
    const key = `${state.company.repoPath}\0qa:${parent.id}`;
    if (this.data.findingTaskIds[key]) return;
    const agent = state.agents.find((candidate) => candidate.enabled && candidate.departmentId === 'engineering' && /quality|\bqa\b|test/i.test(candidate.role));
    if (!agent) return;
    const now = this.time(); const id = randomUUID(); this.data.findingTaskIds[key] = id;
    state.tasks.push({ id, title: `Verify: ${parent.title}`, description: `Review the delivered implementation in its retained worktree. Read the predecessor artifact and choose the relevant checks from the repository. Run checks and report their exact commands, outcomes, and any limitations. Do not edit product files, silently repair failures, publish, or merge. A successful provider exit is not proof that checks passed.`, departmentId: 'engineering', stage: 'verify', agentId: agent.id, status: 'queued', priority: parent.priority, source: 'repo', runType: 'cli', missionRevision: parent.missionRevision, dependsOn: [parent.id], handoff: 'delivery', requiresDirection: false, evidence: [], artifact: '', createdAt: now, updatedAt: now });
    this.activity(state, 'QA handoff created', `${agent.name} can inspect the delivered worktree while the founder reviews ${parent.title}.`, 'engineering');
  }

  async dispatch(input: unknown): Promise<ActionResponse> {
    const action = validateAction(input);
    return this.locked(async () => {
      if (this.closed) throw new ActionError('The workspace is shutting down.', 503);
      const before = structuredClone(this.data);
      let notice: string | undefined;
      try {
        let state = this.data[this.data.activeMode];
        switch (action.type) {
          case 'set_mode':
            if (action.mode === 'demo' && this.job) { this.abortTask(this.job.taskId); const task = this.data.live.tasks.find((item) => item.id === this.job?.taskId); if (task?.status === 'running') { this.data.pausedFrom[task.id] = 'queued'; task.status = 'paused'; task.updatedAt = this.time(); notice = 'Live work was paused before entering the sample replay.'; } }
            this.data.activeMode = action.mode; state = this.data[action.mode]; break;
          case 'reset_demo':
            if (this.job) { this.abortTask(this.job.taskId); const task = this.data.live.tasks.find((item) => item.id === this.job?.taskId); if (task?.status === 'running') { this.data.pausedFrom[task.id] = 'queued'; task.status = 'paused'; task.updatedAt = this.time(); } }
            this.data.unstartedTaskIds = this.data.unstartedTaskIds?.filter((id) => !this.data.demo.tasks.some((task) => task.id === id));
            this.data.demo = createState('demo', this.time()); this.data.activeMode = 'demo'; state = this.data.demo; notice = 'Sample replay reset. Live work is preserved.'; break;
          case 'rename_company': state.company.name = action.name; break;
          case 'set_mission': this.mission(state, action.mission); break;
          case 'connect_repo': {
            const path = await realpath(action.path).catch(() => { throw new ActionError('That local repository path does not exist.'); });
            if (!(await stat(path)).isDirectory()) throw new ActionError('The repository path must be a directory.');
            if (this.job) throw new ActionError('Pause the running provider job before changing repositories.', 409);
            const inspection = await this.adapters.inspectRepository(path);
            state = this.data.live; this.data.activeMode = 'live';
            if (state.company.repoPath && state.company.repoPath !== path) for (const task of state.tasks) if (!terminal.has(task.status) && task.source === 'repo') { this.data.pausedFrom[task.id] = task.status === 'running' ? 'queued' : task.status; task.status = 'paused'; task.updatedAt = this.time(); }
            state.company.repoPath = path;
            if (action.mission) this.mission(state, action.mission);
            state.providers = await this.adapters.checkProviders();
            await this.inspect(state, inspection); notice = 'Connected and inspected locally. Continuous inspection and provider execution remain opt-in.'; break;
          }
          case 'set_config':
            if (state.mode === 'demo' && action.config.allowProviderRuns === true) throw new ActionError('Provider execution is unavailable in sample replay.', 409);
            Object.assign(state.config, action.config);
            if ((state.config.paused || !state.config.allowProviderRuns) && state.mode === 'live' && this.job) { this.abortTask(this.job.taskId); const task = state.tasks.find((item) => item.id === this.job?.taskId); if (task?.status === 'running') { this.data.pausedFrom[task.id] = 'queued'; task.status = 'paused'; task.updatedAt = this.time(); } }
            state.runtime.nextCycleAt = null; break;
          case 'resolve_decision': {
            const decision = state.decisions.find((item) => item.id === action.decisionId);
            if (!decision || decision.status !== 'open') throw new ActionError('This decision is not open.', 409);
            const option = action.optionId ? decision.options.find((item) => item.id === action.optionId) : undefined;
            if (action.optionId && !option) throw new ActionError('Unknown decision option.');
            if (action.optionId === 'revise' && !action.answer) throw new ActionError('Explain the required revisions before releasing the team.');
            decision.answer = [option?.label, action.answer].filter(Boolean).join(': '); decision.status = 'resolved'; decision.answeredAt = this.time();
            this.message(state, `Shared direction — ${decision.title}: ${decision.answer}`, 'founder', 'Founder');
            for (const id of decision.taskIds) { const task = state.tasks.find((item) => item.id === id); if (!task || terminal.has(task.status)) continue; task.requiresDirection = this.directionOpen(state, task); if (task.status === 'paused' && !task.requiresDirection) { task.status = this.data.pausedFrom[id] ?? 'queued'; delete this.data.pausedFrom[id]; } if (!task.requiresDirection) task.missionRevision = state.company.missionRevision; task.updatedAt = this.time(); }
            this.release(state); this.activity(state, 'Direction shared with the team', `${decision.title}: ${decision.answer}`, decision.departmentId); break;
          }
          case 'create_task': {
            const agent = action.agentId ? state.agents.find((candidate) => candidate.id === action.agentId) : state.agents.find((candidate) => candidate.enabled && candidate.departmentId === action.departmentId);
            if (!agent || !agent.enabled || agent.departmentId !== action.departmentId) throw new ActionError('Choose an enabled teammate in this department.', 409);
            const dependsOn = action.dependsOn ?? [];
            for (const id of dependsOn) { const parent = state.tasks.find((task) => task.id === id); if (!parent || parent.status === 'dismissed' || (state.mode === 'live' && !this.taskMatchesRepo(state, parent))) throw new ActionError('Each dependency must be an existing, active task in this workspace and repository.', 409); }
            const now = this.time(); const task: Task = { id: randomUUID(), title: action.title, description: action.description, departmentId: action.departmentId, agentId: agent.id, status: action.requiresDirection ? 'waiting' : 'proposed', stage: inferTaskStage(action, agent.role), priority: action.priority ?? 'medium', source: state.mode === 'demo' ? 'sample' : 'founder', runType: state.mode === 'demo' ? 'sample' : 'cli', missionRevision: state.company.missionRevision, dependsOn, requiresDirection: !!action.requiresDirection, evidence: [], artifact: '', createdAt: now, updatedAt: now };
            state.tasks.push(task); (this.data.unstartedTaskIds ??= []).push(task.id);
            if (task.requiresDirection) this.ask(state, task, `Direction needed: ${task.title}`, `What should ${agent.name} know before starting?\n${task.description}`);
            this.activity(state, 'Work proposed', `${task.title} assigned to ${agent.name}. Creating work does not start a provider; use Start after direction and dependencies are satisfied.`, task.departmentId);
            notice = 'Work recorded. No provider was invoked.'; break;
          }
          case 'set_task_preview': {
            const task = state.tasks.find((item) => item.id === action.taskId); if (!task) throw new ActionError('Unknown task.', 404);
            if (action.html === null) delete task.preview;
            else task.preview = { html: action.html, source: state.mode === 'demo' ? 'sample' : 'founder', updatedAt: this.time() };
            task.updatedAt = this.time();
            this.activity(state, action.html === null ? 'HTML preview removed' : 'HTML preview recorded', `${task.title}. This is provided HTML, not a verified build or provider output; no scripts were executed by the server.`, task.departmentId);
            notice = 'Preview record saved. No build or script was run.'; break;
          }
          case 'task_action': {
            const task = state.tasks.find((item) => item.id === action.taskId); if (!task) throw new ActionError('Unknown task.', 404);
            switch (action.action) {
              case 'accept': if (task.status !== 'review') throw new ActionError('Only a deliverable awaiting review can be accepted.', 409); task.status = 'done'; this.release(state); break;
              case 'start':
                if (!['proposed', 'queued', 'failed'].includes(task.status)) throw new ActionError('This task cannot be started from its current status.', 409);
                if (state.mode === 'live' && !this.taskMatchesRepo(state, task)) throw new ActionError('Reconnect this task’s repository before starting it.', 409);
                if (task.requiresDirection || !this.dependenciesDone(state, task)) throw new ActionError('Resolve direction and accept prerequisite deliverables first.', 409);
                if (state.config.paused) throw new ActionError('Resume the team before starting tasks.', 409);
                if (state.mode === 'live' && task.runType === 'cli' && !state.config.allowProviderRuns) throw new ActionError('Enable native provider runs before starting an implementation task.', 409);
                if (state.mode === 'live' && task.runType === 'cli' && !state.company.repoPath) throw new ActionError('Connect a repository first.', 409);
                this.data.unstartedTaskIds = this.data.unstartedTaskIds?.filter((id) => id !== task.id);
                task.status = 'queued'; break;
              case 'pause': if (!['proposed', 'queued', 'running', 'waiting'].includes(task.status)) throw new ActionError('This task cannot be paused.', 409); this.data.pausedFrom[task.id] = task.status === 'running' ? 'queued' : task.status; this.abortTask(task.id); task.status = 'paused'; break;
              case 'resume': if (task.status !== 'paused') throw new ActionError('Only a paused task can be resumed.', 409); if (task.requiresDirection) throw new ActionError('Answer the shared direction decision first.', 409); if (state.mode === 'live' && !this.taskMatchesRepo(state, task)) throw new ActionError('Reconnect this task’s repository before resuming it.', 409); task.status = this.dependenciesDone(state, task) ? (this.data.pausedFrom[task.id] ?? 'queued') : 'waiting'; delete this.data.pausedFrom[task.id]; state.runtime.error = null; break;
              case 'dismiss': if (['done', 'dismissed'].includes(task.status)) throw new ActionError('This task is already closed.', 409); this.abortTask(task.id); task.status = 'dismissed'; for (const [key, id] of Object.entries(this.data.findingTaskIds)) if (id === task.id && !this.data.dismissedFindingKeys.includes(key)) this.data.dismissedFindingKeys.push(key); break;
            }
            task.updatedAt = this.time(); this.activity(state, `Task ${action.action === 'accept' ? 'accepted' : action.action === 'dismiss' ? 'dismissed' : action.action === 'pause' ? 'paused' : action.action === 'resume' ? 'resumed' : 'queued'}`, task.title, task.departmentId); break;
          }
          case 'send_message': this.message(state, action.text, 'founder', 'Founder'); this.activity(state, 'Founder message saved', 'Added to the shared context for subsequent provider jobs. No model response has been generated.'); notice = 'Saved for the team. Agents receive this context on their next native job.'; break;
          case 'update_agent': { const agent = state.agents.find((item) => item.id === action.agentId); if (!agent) throw new ActionError('Unknown team role.', 404); const { type: _type, agentId: _agentId, ...changes } = action; Object.assign(agent, changes); this.activity(state, 'Team role updated', `${agent.name}: ${agent.role}. Changes apply to subsequent jobs.`, agent.departmentId); break; }
          case 'add_agent': if (state.agents.length >= 100) throw new ActionError('A team can contain at most 100 roles.'); state.agents.push({ id: randomUUID(), name: action.name, role: action.role, departmentId: action.departmentId, provider: action.provider, enabled: true }); break;
          case 'import_template':
            if (this.job && state.mode === 'live') throw new ActionError('Pause the running job before replacing the team.', 409);
            state.company.name = action.template.name; this.mission(state, action.template.mission); state.agents = action.template.agents.map((agent) => ({ ...agent, id: randomUUID() }));
            for (const task of state.tasks) task.agentId = state.agents.find((agent) => agent.enabled && agent.departmentId === task.departmentId)?.id ?? null;
            this.activity(state, 'Team template imported', `${state.agents.length} roles loaded. Repository access, provider permissions, and task history were not imported.`); break;
          case 'inspect_repo': if (state.mode !== 'live') throw new ActionError('Connect a repository to run a real inspection.', 409); await this.inspect(state); break;
          case 'run_demo_cycle':
            if (state.mode !== 'demo') throw new ActionError('Sample replay is available only in demo mode.', 409);
            if (state.config.paused) throw new ActionError('Resume the sample replay first.', 409);
            this.release(state);
            { const task = state.tasks.find((item) => item.status === 'running') ?? state.tasks.find((item) => item.status === 'queued' && !item.requiresDirection && this.dependenciesDone(state, item));
              if (task) { if (task.status === 'running') { task.status = 'review'; task.artifact ||= `SAMPLE DELIVERABLE\n${task.title}\nThis illustrates a reviewable handoff. It is not a result from an AI provider or your repository.`; task.evidence.push({ id: randomUUID(), label: 'Sample replay output', detail: 'Illustrative output; no command or provider was executed.', kind: 'report', source: 'sample', recordedAt: this.time() }); } else task.status = 'running'; task.updatedAt = this.time(); this.activity(state, 'Sample replay advanced', task.title, task.departmentId); }
              state.runtime.lastCycleAt = this.time(); notice = 'Sample only: no provider or repository commands were executed.'; }
            break;
        }
        this.refresh(state); if (state !== this.data.live) this.refresh(this.data.live);
        const titles: Record<WorkspaceAction['type'], string> = { set_mission: 'Mission revised', rename_company: 'Company renamed', connect_repo: 'Repository connected and inspected', set_mode: 'Workspace mode selected', reset_demo: 'Sample replay reset', set_config: 'Runtime configuration changed', resolve_decision: 'Founder direction recorded', task_action: 'Task state changed', create_task: 'Work proposed', set_task_preview: 'HTML preview updated', send_message: 'Founder message recorded', update_agent: 'Team role updated', add_agent: 'Team role added', inspect_repo: 'Repository inspected', run_demo_cycle: 'Sample replay advanced', import_template: 'Team template imported' };
        const latest = state.activity[0]; const fresh = latest && latest.id !== before[state.mode].activity[0]?.id;
        await this.persist(action.type, titles[action.type], fresh ? latest.detail : notice ?? `Saved ${action.type.replaceAll('_', ' ')}; no past activity was reconstructed.`, action.type === 'reset_demo' ? ['demo'] : []); this.emit(); this.pump();
        return { state: this.getState(), ...(notice ? { notice } : {}) };
      } catch (error) { this.data = before; throw error; }
    });
  }

  private pump(): void {
    if (this.closed || this.job || this.data.activeMode !== 'live') return;
    const state = this.data.live;
    if (state.config.paused || !state.config.allowProviderRuns || !state.company.repoPath) return;
    const task = state.tasks.find((item) => item.status === 'queued' && item.runType === 'cli' && !item.requiresDirection && this.dependenciesDone(state, item) && this.taskMatchesRepo(state, item));
    if (!task) return;
    const assigned = state.agents.find((agent) => agent.id === task.agentId && agent.enabled) ?? state.agents.find((agent) => agent.enabled && agent.departmentId === task.departmentId);
    if (!assigned) return;
    const job = { taskId: task.id, controller: new AbortController(), invalidated: false, promise: null as Promise<void> | null }; this.job = job;
    job.promise = this.runJob(job, task.id, assigned.id).finally(() => { if (this.job === job) this.job = null; this.pump(); });
  }
  private async runJob(job: NonNullable<WorkspaceEngine['job']>, taskId: string, agentId: string): Promise<void> {
    let input: Parameters<EngineAdapters['runProviderTask']>[0] | null = null;
    try {
      await this.locked(async () => {
        const state = this.data.live; const task = state.tasks.find((item) => item.id === taskId); const agent = state.agents.find((item) => item.id === agentId);
        if (!task || !agent || task.status !== 'queued' || job.invalidated || this.closed || job.controller.signal.aborted) return;
        if (this.data.activeMode !== 'live' || state.config.paused || !state.config.allowProviderRuns || !state.company.repoPath || !agent.enabled || task.runType !== 'cli' || task.requiresDirection || this.directionOpen(state, task) || !this.dependenciesDone(state, task) || !this.taskMatchesRepo(state, task)) return;
        const parents = task.dependsOn.map((id) => state.tasks.find((item) => item.id === id)!);
        const workspaces = [...new Set(parents.filter((item) => item.runType === 'cli').map((item) => item.workspacePath))];
        if (workspaces.length > 1 || workspaces.some((path) => !path)) {
          task.status = 'waiting'; this.ask(state, task, 'Choose a coherent worktree handoff', 'Accepted prerequisites have missing or different worktrees. Consolidate their changes into one worktree before continuing; this task will not silently inspect the unchanged checkout.');
          await this.persist('handoff_blocked', 'Worktree handoff needs direction', 'Prerequisites have missing or different worktrees; no downstream provider was invoked.'); this.emit(); return;
        }
        task.status = 'running'; task.agentId = agent.id; task.updatedAt = this.time(); state.runtime.error = null; this.refresh(state);
        const sharedMessages = structuredClone(state.messages);
        for (const parent of parents) sharedMessages.push({ id: randomUUID(), author: 'Accepted predecessor artifact', role: 'system', text: `${parent.title}\n${parent.artifact}\nWorkspace: ${parent.workspacePath ?? 'read-only inspection; no implementation worktree'}`, taskId: parent.id, source: 'live', createdAt: this.time() });
        const upstreamWorkspacePath = workspaces[0] ?? task.workspacePath;
        const rank = (decision: Decision) => decision.taskIds.includes(task.id) ? 0 : decision.departmentId === task.departmentId ? 1 : decision.departmentId === 'product' ? 2 : 3;
        const decisions = state.decisions.filter((decision) => decision.status === 'resolved').sort((a, b) => rank(a) - rank(b) || (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')).map(({ id, title, answer, departmentId, taskIds, answeredAt }) => ({ id, title, answer, departmentId, taskIds, answeredAt }));
        input = { provider: agent.provider, repoPath: state.company.repoPath!, ...(upstreamWorkspacePath ? { upstreamWorkspacePath } : {}), decisions, task: structuredClone(task), agent: structuredClone(agent), mission: state.company.mission, messages: sharedMessages, signal: job.controller.signal };
        this.activity(state, 'Native provider job started', `${agent.name} (${agent.provider}) is working on ${task.title}. Output will require founder review.`, task.departmentId);
        await this.persist('provider_started', 'Native provider job started', `${agent.name} (${agent.provider}) started ${task.title}. A start is not a completed or verified result.`); this.emit();
      });
      if (!input) return;
      const result = await this.adapters.runProviderTask(input);
      await this.locked(async () => {
        const state = this.data.live; const task = state.tasks.find((item) => item.id === taskId); if (!task) return;
        if (result.workspacePath) task.workspacePath = result.workspacePath;
        const output = [result.stdout, result.stderr && `STDERR\n${result.stderr}`, result.error].filter(Boolean).join('\n\n').slice(0, 250000);
        task.evidence.push(...(result.evidence ?? []));
        task.evidence.push({ id: randomUUID(), label: `${input!.provider} job result`, detail: `Exit code: ${result.exitCode ?? 'none'}. ${result.interrupted ? 'Interrupted.' : 'Provider output is not proof that tests passed.'}`, kind: 'command', source: 'agent', recordedAt: this.time() });
        task.artifact = [task.artifact, output].filter(Boolean).join('\n\n--- Native job output ---\n\n');
        if (!job.invalidated && task.status === 'running') {
          const successful = result.exitCode === 0 && !result.interrupted && !result.timedOut && !result.truncated && !result.error;
          if (!successful) task.status = 'failed';
          else if (result.directionRequest) { task.status = 'waiting'; this.ask(state, task, 'The team needs your direction', result.directionRequest.question, result.directionRequest.options, result.directionRequest.recommendationId ?? null); }
          else if (result.blockedReason) { task.status = 'waiting'; this.ask(state, task, 'A provider job is blocked', result.blockedReason); }
          else task.status = 'review';
          state.runtime.error = task.status === 'failed' ? result.error ?? (result.interrupted ? 'Provider job interrupted.' : `Provider job exited ${result.exitCode ?? 'without a result'}.`) : null;
        }
        if (input!.upstreamWorkspacePath && result.worktreeChanged !== false) {
          for (const parent of state.tasks.filter((item) => task.dependsOn.includes(item.id) && item.status === 'done' && item.workspacePath === input!.upstreamWorkspacePath)) {
            parent.status = 'review'; parent.updatedAt = this.time(); parent.evidence.push({ id: randomUUID(), label: 'Acceptance needs another review', detail: result.worktreeChanged ? 'The downstream job changed this retained worktree. Prior acceptance no longer covers its current contents.' : 'The downstream job reused this worktree without a complete unchanged-content proof. Review its current contents before accepting again.', kind: 'diff', source: 'observed', recordedAt: this.time() });
            this.activity(state, 'Prior acceptance invalidated', `${parent.title}: review the retained worktree after the downstream job.`, parent.departmentId);
          }
        }
        if (!job.invalidated && task.status === 'review') this.createQA(state, task);
        this.release(state);
        task.updatedAt = this.time(); state.runtime.activeTaskId = null; this.refresh(state);
        this.activity(state, job.invalidated ? 'Interrupted output retained' : task.status === 'review' ? 'Provider output ready for review' : task.status === 'waiting' ? 'Provider needs founder direction' : 'Provider job failed', `${task.title}. ${result.workspacePath ? 'Isolated worktree retained for inspection.' : 'No successful validation is claimed.'}`, task.departmentId);
        await this.persist(job.invalidated ? 'provider_interrupted' : task.status === 'failed' ? 'provider_failed' : task.status === 'waiting' ? 'provider_direction' : 'provider_completed', job.invalidated ? 'Interrupted output retained' : task.status === 'failed' ? 'Provider job failed' : task.status === 'waiting' ? 'Provider needs founder direction' : 'Provider output ready for review', `${task.title}. Provider output and recorded evidence are retained; a provider exit is not proof that tests passed.`); this.emit();
      });
    } catch (error) {
      await this.locked(async () => {
        const state = this.data.live; const task = state.tasks.find((item) => item.id === taskId);
        if (task && !job.invalidated && task.status === 'running') { task.status = 'failed'; task.updatedAt = this.time(); task.artifact = [task.artifact, `Job failed: ${(error as Error).message}`].filter(Boolean).join('\n\n'); }
        state.runtime.error = (error as Error).message; this.refresh(state);
        await this.persist('provider_error', 'Provider job error recorded', (error as Error).message); this.emit();
      }).catch(() => {});
    }
  }

  async tick(): Promise<void> {
    if (this.closed || this.data.activeMode !== 'live') return;
    const state = this.data.live;
    if (!state.config.paused && state.config.autoInspect && state.company.repoPath && state.runtime.nextCycleAt && this.now().getTime() >= Date.parse(state.runtime.nextCycleAt)) {
      try { await this.dispatch({ type: 'inspect_repo' }); }
      catch (error) { await this.locked(async () => { this.data.live.runtime.error = (error as Error).message; this.data.live.runtime.nextCycleAt = new Date(this.now().getTime() + this.data.live.config.cycleSeconds * 1000).toISOString(); await this.persist('inspection_error', 'Inspection error recorded', (error as Error).message); this.emit(); }); }
    }
    this.pump();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; if (this.timer) clearInterval(this.timer);
    const job = this.job; if (job) { job.invalidated = true; job.controller.abort(); }
    await this.locked(async () => {
      const live = this.data.live;
      for (const task of live.tasks) if (task.status === 'running') { task.status = 'paused'; this.data.pausedFrom[task.id] = 'queued'; task.updatedAt = this.time(); }
      if (job) { live.runtime.status = 'interrupted'; live.runtime.error = 'Server shutdown interrupted the provider job. Review retained work before resuming.'; }
      live.runtime.activeTaskId = null; live.runtime.nextCycleAt = null;
      await this.persist('shutdown', 'Workspace server closed', job ? 'A provider job was interrupted; review retained output before resuming.' : 'Server closed without an active provider job. No provider completion is implied.', [this.data.activeMode]); this.emit();
    });
    if (job?.promise) await Promise.race([job.promise, new Promise<void>((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref(); })]);
    this.listeners.clear();
  }
}
