import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decision, Task, WorkspaceState } from '../src/lib/types.ts';
import { createState } from '../server/seed.ts';
import { decisionImpact, describeHandoff, inferTaskStage, renderMissionMap } from '../src/mission-map.ts';

const now = '2026-10-12T00:00:00.000Z';
function task(id: string, changes: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, description: 'Recorded work.', departmentId: 'engineering', agentId: 'agent-engineer', status: 'queued', priority: 'medium', source: 'repo', runType: 'cli', missionRevision: 1, dependsOn: [], requiresDirection: false, evidence: [], artifact: '', createdAt: now, updatedAt: now, ...changes };
}
function decision(id: string, ids: string[], changes: Partial<Decision> = {}): Decision {
  return { id, title: 'Choose the audience', context: 'Direction needed.', departmentId: 'product', options: [{ id: 'first', label: 'Maintainers', description: 'Prepare a maintainer-focused draft.' }], recommendationId: 'first', taskIds: ids, status: 'open', answer: null, source: 'founder', createdAt: now, answeredAt: null, ...changes };
}
function state(tasks: Task[], decisions: Decision[] = []): WorkspaceState { return { ...createState('live', now), tasks, decisions }; }

test('stage inference respects explicit stages, QA roles and audits without manufacturing dependencies', () => {
  const workspace = state([]);
  assert.equal(inferTaskStage(task('engineer'), workspace), 'build');
  assert.equal(inferTaskStage(task('qa', { agentId: 'agent-qa' }), workspace), 'verify');
  assert.equal(inferTaskStage(task('handoff', { handoff: 'delivery' }), workspace), 'verify');
  assert.equal(inferTaskStage(task('audit', { runType: 'audit' }), workspace), 'operations');
  assert.equal(inferTaskStage(task('launch', { departmentId: 'marketing' }), workspace), 'launch');
  assert.equal(inferTaskStage(task('explicit', { stage: 'idea' }), workspace), 'idea');
});

test('delivery handoffs need a retained worktree; other prerequisites require founder acceptance', () => {
  const parent = task('build', { status: 'review', workspacePath: '/retained/build' });
  const qa = task('qa', { dependsOn: [parent.id], handoff: 'delivery' });
  const launch = task('launch', { dependsOn: [parent.id], departmentId: 'marketing' });
  const workspace = state([parent, qa, launch]);
  assert.equal(describeHandoff(qa, workspace).ready, true);
  assert.equal(describeHandoff(launch, workspace).ready, false);
  delete parent.workspacePath;
  assert.equal(describeHandoff(qa, workspace).ready, false);
  assert.match(describeHandoff(qa, workspace).prerequisites[0]!.reason, /worktree/);
  parent.status = 'done';
  assert.equal(describeHandoff(launch, workspace).ready, true);
  assert.equal(describeHandoff(qa, workspace).ready, false);
});

test('missing dependencies and open direction cards block work even when a cached flag is false', () => {
  const work = task('work', { dependsOn: ['absent'] });
  const workspace = state([work], [decision('direction', [work.id])]);
  const handoff = describeHandoff(work, workspace);
  assert.equal(handoff.ready, false); assert.equal(handoff.needsDirection, true);
  assert.deepEqual(handoff.missingIds, ['absent']); assert.equal(handoff.prerequisites[0]!.status, 'missing');
  assert.equal(describeHandoff(task('explicit', { requiresDirection: true }), state([])).ready, false);
});

test('a shared answer releases eligible direct tasks but preserves acceptance and other direction requirements', () => {
  const channel = task('channel', { departmentId: 'marketing', status: 'waiting', requiresDirection: true });
  const email = task('email', { departmentId: 'marketing', status: 'waiting', requiresDirection: true, dependsOn: ['qa'] });
  const social = task('social', { departmentId: 'marketing', status: 'waiting', requiresDirection: true });
  const qa = task('qa', { status: 'review', agentId: 'agent-qa' });
  const downstream = task('follow-up', { dependsOn: ['channel'] });
  const shared = decision('launch-direction', ['channel', 'email', 'social']);
  const workspace = state([channel, email, social, qa, downstream], [shared, decision('budget', ['social'])]);
  const before = structuredClone(workspace);
  const result = decisionImpact(shared, workspace);
  assert.deepEqual(result.directTaskIds, ['channel', 'email', 'social']);
  assert.deepEqual(result.downstreamTaskIds, ['follow-up']);
  assert.deepEqual(result.readyAfterAnswerIds, ['channel']);
  assert.deepEqual(result.stillBlockedIds, ['email', 'social', 'follow-up']);
  assert.match(result.explanations.join(' '), /another direction request/);
  assert.match(result.explanations.join(' '), /must accept/);
  assert.deepEqual(workspace, before);
});

test('decision traversal handles cycles and missing references without predicting completed work', () => {
  const a = task('a', { dependsOn: ['b'], requiresDirection: true, status: 'waiting' });
  const b = task('b', { dependsOn: ['a'], status: 'waiting' });
  const answer = decision('cycle', ['a', 'not-here', 'a']);
  const result = decisionImpact(answer, state([a, b], [answer]));
  assert.deepEqual(result.directTaskIds, ['a']); assert.deepEqual(result.downstreamTaskIds, ['b']);
  assert.deepEqual(result.readyAfterAnswerIds, []); assert.deepEqual(result.stillBlockedIds, ['a', 'b']);
  assert.match(result.explanations.join(' '), /referenced task is missing/);
  const answered = { ...answer, status: 'resolved' as const };
  assert.deepEqual(decisionImpact(answered, state([a, b], [answered])).readyAfterAnswerIds, []);
});

test('answering a card does not claim to unlock a downstream task that was already ready', () => {
  const accepted = task('accepted', { status: 'done' });
  const downstream = task('downstream', { dependsOn: [accepted.id] });
  const card = decision('stale-direction', [accepted.id]);
  const result = decisionImpact(card, state([accepted, downstream], [card]));
  assert.deepEqual(result.downstreamTaskIds, [downstream.id]);
  assert.deepEqual(result.readyAfterAnswerIds, []);
  assert.deepEqual(result.stillBlockedIds, []);
});

test('mission render escapes metadata and displays only actual edges with truthful source labels', () => {
  const parent = task('build" onclick="bad', { title: '<script>bad()</script>', status: 'review', workspacePath: '/retained/work' });
  const qa = task('qa', { agentId: 'agent-qa', handoff: 'delivery', dependsOn: [parent.id] });
  const unrelated = task('launch', { departmentId: 'marketing', source: 'sample' });
  const html = renderMissionMap(state([parent, qa, unrelated]), qa.id);
  assert.equal((html.match(/<path class="mission-edge/g) ?? []).length, 1);
  assert.equal((html.match(/<foreignObject/g) ?? []).length, 3);
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('onclick="bad'));
  assert.ok(html.includes('data-mission-task="build&quot; onclick=&quot;bad"'));
  assert.ok(html.includes('2 recorded tasks · 1 sample task'));
  assert.ok(html.includes('mission-source-sample">Sample'));
  assert.ok(html.includes('Stage order does not imply a dependency.'));
  assert.ok(html.includes('aria-pressed="true"'));
});

test('empty lanes, missing prerequisites and cyclic edges remain readable without invented connections', () => {
  const empty = renderMissionMap(state([]), null);
  assert.equal((empty.match(/No recorded tasks/g) ?? []).length, 7);
  assert.equal((empty.match(/<path class="mission-edge/g) ?? []).length, 0);
  assert.match(empty, /No prerequisites have been recorded/);
  const a = task('a', { dependsOn: ['b', 'missing'] }); const b = task('b', { dependsOn: ['a'] });
  const html = renderMissionMap(state([a, b]), null);
  assert.equal((html.match(/<path class="mission-edge/g) ?? []).length, 2);
  assert.match(html, /Missing prerequisite/); assert.match(html, /<code>missing<\/code>/);
  assert.ok(!html.includes('NaN')); assert.ok(!html.includes('undefined'));
  const sample = renderMissionMap(createState('demo', now), null);
  assert.match(sample, /Sample workflow · no provider work is implied/);
});
