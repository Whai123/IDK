import type { Decision, Task, TaskStage, TaskStatus, WorkspaceState } from './lib/types.ts';

export type { TaskStage } from './lib/types.ts';

export interface HandoffDescription {
  prerequisites: { taskId: string; title: string; status: TaskStatus | 'missing'; ready: boolean; reason: string }[];
  ready: boolean;
  needsDirection: boolean;
  missingIds: string[];
}

export interface DecisionImpact {
  directTaskIds: string[];
  downstreamTaskIds: string[];
  readyAfterAnswerIds: string[];
  stillBlockedIds: string[];
  explanations: string[];
}

const stages: { id: TaskStage; title: string; description: string }[] = [
  { id: 'idea', title: 'Idea', description: 'Goals and product decisions' },
  { id: 'design', title: 'Design', description: 'Flows and experience' },
  { id: 'build', title: 'Build', description: 'Implementation work' },
  { id: 'verify', title: 'Verify', description: 'Checks and delivery review' },
  { id: 'launch', title: 'Launch', description: 'Marketing and sales' },
  { id: 'support', title: 'Support', description: 'Customer understanding' },
  { id: 'operations', title: 'Operations', description: 'Repository and team health' },
];
const stageIds = new Set(stages.map((stage) => stage.id));
const terminalStatuses = new Set<TaskStatus>(['done', 'dismissed', 'review', 'failed']);

/** Stages organize the work; only dependsOn establishes an actual handoff. */
export function inferTaskStage(task: Task, state: WorkspaceState): TaskStage {
  if (task.stage && stageIds.has(task.stage)) return task.stage;
  if (task.runType === 'audit') return 'operations';
  if (task.departmentId === 'engineering') {
    const role = state.agents.find((agent) => agent.id === task.agentId)?.role ?? '';
    if (task.handoff === 'delivery' || /\b(qa|quality|test|testing|verification)\b/i.test(role) || /^(verify|verification|test|review acceptance)\b/i.test(task.title)) return 'verify';
    return 'build';
  }
  return ({ product: 'idea', design: 'design', marketing: 'launch', sales: 'launch', support: 'support', operations: 'operations' } as const)[task.departmentId];
}

export function describeHandoff(task: Task, state: WorkspaceState): HandoffDescription {
  const prerequisites = [...new Set(task.dependsOn)].map((taskId) => {
    const parent = state.tasks.find((candidate) => candidate.id === taskId);
    if (!parent) return { taskId, title: 'Missing prerequisite', status: 'missing' as const, ready: false, reason: 'The prerequisite task is missing from this workspace.' };
    if (task.handoff === 'delivery') {
      const ready = (parent.status === 'review' || parent.status === 'done') && !!parent.workspacePath;
      const reason = ready ? 'Delivered worktree is available for verification.' : !parent.workspacePath ? 'A retained implementation worktree is required.' : 'The implementation must reach review or be accepted first.';
      return { taskId, title: parent.title, status: parent.status, ready, reason };
    }
    const ready = parent.status === 'done';
    return { taskId, title: parent.title, status: parent.status, ready, reason: ready ? 'The founder accepted this prerequisite.' : 'The founder must accept this prerequisite first.' };
  });
  const needsDirection = task.requiresDirection || state.decisions.some((decision) => decision.status === 'open' && decision.taskIds.includes(task.id));
  return { prerequisites, needsDirection, missingIds: prerequisites.filter((parent) => parent.status === 'missing').map((parent) => parent.taskId), ready: !needsDirection && prerequisites.every((parent) => parent.ready) };
}

/** Describe graph effects of answering, without predicting what an option will create. */
export function decisionImpact(decision: Decision, state: WorkspaceState): DecisionImpact {
  const known = new Set(state.tasks.map((task) => task.id));
  const directTaskIds = [...new Set(decision.taskIds)].filter((id) => known.has(id));
  const visited = new Set(directTaskIds);
  const pending = [...directTaskIds];
  for (let index = 0; index < pending.length; index++) {
    for (const task of state.tasks) if (!visited.has(task.id) && task.dependsOn.includes(pending[index]!)) { visited.add(task.id); pending.push(task.id); }
  }
  const downstreamTaskIds = state.tasks.filter((task) => visited.has(task.id) && !directTaskIds.includes(task.id)).map((task) => task.id);
  const prospective: WorkspaceState = {
    ...state,
    decisions: state.decisions.map((item) => item.id === decision.id ? { ...item, status: 'resolved' } : item),
    tasks: state.tasks.map((task) => directTaskIds.includes(task.id) && decision.status === 'open' && !terminalStatuses.has(task.status) ? {
      ...task, requiresDirection: state.decisions.some((other) => other.id !== decision.id && other.status === 'open' && other.taskIds.includes(task.id)),
    } : task),
  };
  const candidates = prospective.tasks.filter((task) => visited.has(task.id) && !terminalStatuses.has(task.status));
  const readyAfterAnswerIds = decision.status === 'open' ? candidates.filter((task) => {
    const previous = state.tasks.find((candidate) => candidate.id === task.id)!;
    return !describeHandoff(previous, state).ready && describeHandoff(task, prospective).ready;
  }).map((task) => task.id) : [];
  const stillBlockedIds = candidates.filter((task) => !describeHandoff(task, prospective).ready).map((task) => task.id);
  const explanations = [
    decision.status === 'open' ? 'Your answer is shared with subsequent provider jobs. It clears this direction request; it does not complete tasks or their prerequisites.' : 'This direction request has already been answered. No new release is predicted.',
    'Ready means direction and prerequisite requirements are satisfied. Proposed work still needs to be queued; team pause, repository access and provider settings still apply.',
  ];
  for (const task of candidates.filter((item) => stillBlockedIds.includes(item.id))) {
    const handoff = describeHandoff(task, prospective);
    const reasons = [...(handoff.needsDirection ? ['another direction request remains open'] : []), ...handoff.prerequisites.filter((parent) => !parent.ready).map((parent) => `${parent.title}: ${parent.reason}`)];
    explanations.push(`${task.title} remains blocked: ${reasons.join(' ')}.`);
  }
  const missing = [...new Set(decision.taskIds)].filter((id) => !known.has(id));
  if (missing.length) explanations.push(`${missing.length} referenced ${missing.length === 1 ? 'task is' : 'tasks are'} missing from this workspace; no release is predicted for them.`);
  return { directTaskIds, downstreamTaskIds, readyAfterAnswerIds, stillBlockedIds, explanations };
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

const statusLabels: Record<TaskStatus, string> = { proposed: 'Proposed', queued: 'Queued', running: 'Working', waiting: 'Waiting', review: 'Awaiting review', done: 'Accepted', paused: 'Paused', dismissed: 'Dismissed', failed: 'Failed' };
const sourceLabels: Record<Task['source'], string> = { sample: 'Sample', repo: 'Repository', founder: 'Founder' };

/** A self-contained, accessible graph of actual recorded dependencies. */
export function renderMissionMap(state: WorkspaceState, selectedTaskId: string | null): string {
  const laneWidth = 232, padding = 16, cardWidth = 200, cardHeight = 98, rowHeight = 124, top = 92;
  const lanes = stages.map((stage) => ({ ...stage, tasks: state.tasks.filter((task) => inferTaskStage(task, state) === stage.id) }));
  const maximumRows = Math.max(1, ...lanes.map((lane) => lane.tasks.length));
  const width = lanes.length * laneWidth + padding * 2;
  const height = top + maximumRows * rowHeight + 10;
  const positions = new Map<string, { x: number; y: number }>();
  lanes.forEach((lane, laneIndex) => lane.tasks.forEach((task, row) => positions.set(task.id, { x: padding + laneIndex * laneWidth + 8, y: top + row * rowHeight })));
  const edges = state.tasks.flatMap((task) => describeHandoff(task, state).prerequisites.map((parent) => ({ parent, task })));
  const paths = edges.filter(({ parent }) => positions.has(parent.taskId)).map(({ parent, task }) => {
    const start = positions.get(parent.taskId)!; const end = positions.get(task.id)!;
    const startY = start.y + cardHeight / 2, endY = end.y + cardHeight / 2;
    let path: string;
    if (start.x === end.x) {
      const outside = start.x + cardWidth + 22;
      path = parent.taskId === task.id
        ? `M ${start.x + cardWidth} ${startY} C ${outside + 20} ${startY}, ${outside + 20} ${start.y + 15}, ${start.x + cardWidth} ${start.y + 15}`
        : `M ${start.x + cardWidth} ${startY} C ${outside} ${startY}, ${outside} ${endY}, ${end.x + cardWidth} ${endY}`;
    } else {
      const forward = end.x > start.x;
      const startX = start.x + (forward ? cardWidth : 0), endX = end.x + (forward ? 0 : cardWidth), midpoint = (startX + endX) / 2;
      path = `M ${startX} ${startY} C ${midpoint} ${startY}, ${midpoint} ${endY}, ${endX} ${endY}`;
    }
    return `<path class="mission-edge${parent.ready ? ' is-ready' : ''}${selectedTaskId === task.id || selectedTaskId === parent.taskId ? ' is-selected' : ''}" d="${path}" marker-end="url(#mission-map-arrow)"><title>${escape(`${parent.title} → ${task.title}. ${parent.reason}`)}</title></path>`;
  }).join('');
  const background = lanes.map((lane, index) => {
    const x = padding + index * laneWidth;
    return `<g class="mission-lane mission-lane-${lane.id}"><rect class="mission-lane-background" x="${x}" y="12" width="216" height="${height - 28}" rx="15"/><text class="mission-lane-title" x="${x + 14}" y="40">${lane.title}</text><text class="mission-lane-count" x="${x + 200}" y="40" text-anchor="end">${lane.tasks.length}</text><text class="mission-lane-description" x="${x + 14}" y="63">${lane.description}</text>${lane.tasks.length ? '' : `<text class="mission-lane-empty" x="${x + 108}" y="132" text-anchor="middle">No recorded tasks</text>`}</g>`;
  }).join('');
  const nodes = state.tasks.map((task) => {
    const position = positions.get(task.id)!; const handoff = describeHandoff(task, state); const agent = state.agents.find((candidate) => candidate.id === task.agentId);
    const stage = stages.find((candidate) => candidate.id === inferTaskStage(task, state))!;
    const status = statusLabels[task.status]; const source = sourceLabels[task.source];
    const footer = handoff.needsDirection ? 'Needs founder direction' : handoff.missingIds.length ? 'Missing prerequisite' : !handoff.prerequisites.length ? 'No prerequisites' : `${handoff.prerequisites.filter((parent) => parent.ready).length}/${handoff.prerequisites.length} prerequisites ready`;
    return `<foreignObject x="${position.x}" y="${position.y}" width="${cardWidth}" height="${cardHeight}"><button xmlns="http://www.w3.org/1999/xhtml" type="button" class="mission-task mission-status-${escape(task.status)}${selectedTaskId === task.id ? ' is-selected' : ''}" data-mission-task="${escape(task.id)}" aria-pressed="${selectedTaskId === task.id}" aria-label="${escape(`${task.title}. ${stage.title}. ${status}. ${source}. ${footer}`)}"><span class="mission-task-top"><span class="mission-source mission-source-${escape(task.source)}">${source}</span><span class="mission-task-status">${status}</span></span><span class="mission-task-title" title="${escape(task.title)}">${escape(task.title)}</span><span class="mission-task-owner">${escape(agent ? `${agent.name} · ${agent.provider === 'claude' ? 'Claude' : 'Codex'}` : 'Unassigned role')}</span><span class="mission-task-footer">${escape(footer)}</span></button></foreignObject>`;
  }).join('');
  const sampleCount = state.tasks.filter((task) => task.source === 'sample').length;
  const sourceCaption = state.mode === 'demo' ? 'Sample workflow · no provider work is implied' : `${state.tasks.length - sampleCount} recorded ${state.tasks.length - sampleCount === 1 ? 'task' : 'tasks'}${sampleCount ? ` · ${sampleCount} sample ${sampleCount === 1 ? 'task' : 'tasks'}` : ''}`;
  const relationships = edges.map(({ parent, task }) => `<li class="mission-relationship${selectedTaskId === task.id || selectedTaskId === parent.taskId ? ' is-selected' : ''}"><span>${parent.status === 'missing' ? `${escape(parent.title)} <code>${escape(parent.taskId)}</code>` : `<button type="button" data-mission-task="${escape(parent.taskId)}">${escape(parent.title)}</button>`}</span><span aria-hidden="true"> → </span><button type="button" data-mission-task="${escape(task.id)}">${escape(task.title)}</button><span class="mission-relationship-reason">${escape(parent.reason)}</span></li>`).join('');
  return `<section class="mission-map" aria-label="Mission dependency map"><div class="mission-map-heading"><div><h3>Mission map</h3><p>${escape(sourceCaption)}</p></div><span class="mission-map-legend">Lines show recorded prerequisites. Stage order does not imply a dependency.</span></div><div class="mission-map-scroll"><svg class="mission-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="Seven work stages with ${state.tasks.length} tasks and ${edges.filter(({ parent }) => parent.status !== 'missing').length} recorded dependencies"><defs><marker id="mission-map-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${background}<g class="mission-edges">${paths}</g><g class="mission-nodes">${nodes}</g></svg></div><details class="mission-edge-list"><summary>Read handoffs · ${edges.length} ${edges.length === 1 ? 'prerequisite' : 'prerequisites'}</summary>${relationships ? `<ul>${relationships}</ul>` : '<p>No prerequisites have been recorded. The stage lanes do not create a task sequence.</p>'}</details></section>`;
}
