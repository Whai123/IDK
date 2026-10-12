import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactError, listTaskFiles, readTaskFile } from '../server/artifacts.ts';
import { ActionError } from '../server/engine.ts';
import type { WorkspaceEngine } from '../server/engine.ts';
import { createWorkspaceServer, PREVIEW_CSP } from '../server/index.ts';
import { runCommand } from '../server/providers.ts';
import { createState } from '../server/seed.ts';
import type { HistoryCheckpoint, Task } from '../src/lib/types.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'startup-artifacts-test-')), repo = join(directory, 'repo'), workspace = join(directory, 'task');
  await mkdir(repo);
  const git = async (args: string[], cwd = repo) => {
    const result = await runCommand('git', args, { cwd, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result;
  };
  await git(['init', '-q']);
  await writeFile(join(repo, 'README.md'), '# Original readme\n');
  await writeFile(join(repo, 'deleted.md'), 'This will be deleted.\n');
  await writeFile(join(repo, 'unchanged.md'), 'Only changed files are inventoried.\n');
  await git(['add', '.']);
  await git(['-c', 'user.name=Artifact Fixture', '-c', 'user.email=artifact@example.test', 'commit', '-qm', 'Fixture']);
  await git(['worktree', 'add', '--detach', workspace, 'HEAD']);
  const state = createState('live'); state.company.repoPath = repo;
  const task: Task = { id: 'task-fixture', title: 'Fixture deliverable', description: 'Read-only API fixture.', departmentId: 'engineering', agentId: null, status: 'review', priority: 'medium', source: 'repo', runType: 'cli', missionRevision: 1, dependsOn: [], requiresDirection: false, evidence: [], artifact: '', workspacePath: workspace, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  state.tasks = [task];
  return { directory, repo, workspace, state, task, git, async close() { await git(['worktree', 'remove', '--force', workspace]); await rm(directory, { recursive: true, force: true }); } };
}

function status(expected: number) { return (error: unknown) => error instanceof ArtifactError && error.status === expected; }

test('task inventory preserves modified, added and deleted files while hiding credential-like paths', async () => {
  const app = await fixture();
  try {
    await writeFile(join(app.workspace, 'README.md'), '# Changed readme\n');
    await rm(join(app.workspace, 'deleted.md'));
    await writeFile(join(app.workspace, 'index.html'), '<!doctype html><h1>Actual current file</h1>');
    await writeFile(join(app.workspace, '.env'), 'FIXTURE_SECRET=not-a-real-secret');
    await writeFile(join(app.workspace, 'credentials.json'), '{"fixture":"not-a-real-secret"}');
    const inventory = await listTaskFiles(app.state, app.task.id);
    assert.deepEqual(inventory.files.map(file => [file.path, file.status]).sort(), [['README.md', 'modified'], ['deleted.md', 'deleted'], ['index.html', 'added']]);
    assert.equal(inventory.files.find(file => file.path === 'deleted.md')?.previewable, false);
    assert.equal(inventory.truncated, false);
    const read = await readTaskFile(app.state, app.task.id, 'index.html');
    assert.equal(read.language, 'html'); assert.equal(read.content, '<!doctype html><h1>Actual current file</h1>'); assert.equal(read.truncated, false);
    await assert.rejects(readTaskFile(app.state, app.task.id, 'unchanged.md'), status(404));
    await assert.rejects(readTaskFile(app.state, app.task.id, 'deleted.md'), status(404));
    await assert.rejects(readTaskFile(app.state, app.task.id, '.env'), status(403));
  } finally { await app.close(); }
});

test('task file reads reject traversal, foreign worktrees and forged unregistered Git pointers', async () => {
  const app = await fixture();
  try {
    for (const path of ['../repo/README.md', '/etc/passwd', 'C:/private.txt', 'a/../../private.txt', 'a\\private.txt']) await assert.rejects(readTaskFile(app.state, app.task.id, path), status(403));
    app.task.workspacePath = app.repo;
    await assert.rejects(listTaskFiles(app.state, app.task.id), status(403));
    const foreign = join(app.directory, 'foreign'); await mkdir(foreign); await app.git(['init', '-q'], foreign);
    app.task.workspacePath = foreign;
    await assert.rejects(listTaskFiles(app.state, app.task.id), status(403));
    const forged = join(app.directory, 'forged'); await mkdir(forged); await copyFile(join(app.workspace, '.git'), join(forged, '.git'));
    app.task.workspacePath = forged;
    await assert.rejects(listTaskFiles(app.state, app.task.id), status(403));
  } finally { app.task.workspacePath = app.workspace; await app.close(); }
});

test('task previews reject symlink escapes, protected aliases and hard-link aliases', async () => {
  const app = await fixture();
  try {
    const outside = join(app.directory, 'outside.md'); await writeFile(outside, 'Fixture outside content.');
    await symlink(outside, join(app.workspace, 'outside-link.md'));
    await writeFile(join(app.workspace, '.env'), 'FIXTURE_SECRET=not-a-real-secret');
    await symlink('.env', join(app.workspace, 'env-alias.md'));
    await link(join(app.workspace, '.env'), join(app.workspace, 'hard-alias.md'));
    const inventory = await listTaskFiles(app.state, app.task.id);
    for (const path of ['outside-link.md', 'env-alias.md', 'hard-alias.md']) {
      assert.equal(inventory.files.find(file => file.path === path)?.previewable, false);
      await assert.rejects(readTaskFile(app.state, app.task.id, path), status(403));
    }
  } finally { await app.close(); }
});

test('task file APIs enforce text size, UTF-8 and binary limits', async () => {
  const app = await fixture();
  try {
    await writeFile(join(app.workspace, 'oversize.txt'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(app.workspace, 'binary.txt'), Buffer.from([0, 1, 2]));
    await writeFile(join(app.workspace, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
    await writeFile(join(app.workspace, 'image.png'), 'A file format that is not previewed as text.');
    assert.equal((await listTaskFiles(app.state, app.task.id)).files.find(file => file.path === 'oversize.txt')?.previewable, false);
    await assert.rejects(readTaskFile(app.state, app.task.id, 'oversize.txt'), status(413));
    await assert.rejects(readTaskFile(app.state, app.task.id, 'binary.txt'), status(415));
    await assert.rejects(readTaskFile(app.state, app.task.id, 'invalid.txt'), status(415));
    await assert.rejects(readTaskFile(app.state, app.task.id, 'image.png'), status(415));
  } finally { await app.close(); }
});

test('task inventory bounds its file count and reports native inspection failures honestly', async () => {
  const app = await fixture();
  try {
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(app.workspace, `change-${index.toString().padStart(3, '0')}.md`), '# Fixture\n')));
    const inventory = await listTaskFiles(app.state, app.task.id);
    assert.equal(inventory.files.length, 200); assert.equal(inventory.truncated, true);
    await assert.rejects(listTaskFiles(app.state, app.task.id, async () => ({ exitCode: 1, stdout: '', stderr: 'Fixture native failure' })), status(409));
    await assert.rejects(listTaskFiles(app.state, app.task.id, async () => { throw new Error('Fixture spawn failure'); }), status(503));
    app.task.workspacePath = undefined;
    await assert.rejects(listTaskFiles(app.state, app.task.id), status(409));
    await assert.rejects(listTaskFiles(app.state, 'unknown-task'), status(404));
  } finally { app.task.workspacePath = app.workspace; await app.close(); }
});

test('HTTP preview routes isolate HTML scripts and use captured replay data without live file reads', async () => {
  const app = await fixture();
  app.task.preview = { html: '<!doctype html><script>document.body.dataset.fixture="old"</script><p>Captured old preview</p>', source: 'founder', updatedAt: '2026-01-01T00:00:00Z' };
  const checkpoint: HistoryCheckpoint = { id: 'checkpoint-old', recordedAt: '2026-01-01T00:00:00Z', kind: 'preview', title: 'Recorded preview', detail: 'Fixture checkpoint.', source: 'live', taskIds: [app.task.id], decisionIds: [], missionRevision: 1, limitations: [], snapshot: structuredClone(app.state) };
  const fakeEngine = {
    getState: () => structuredClone(app.state),
    getHistory: () => ({ entries: [{ ...checkpoint, snapshot: undefined }], retainedLimit: 100, droppedCount: 0 }),
    getHistoryCheckpoint: (id: string) => { if (id !== checkpoint.id || app.state.mode !== checkpoint.snapshot.mode) throw new ActionError('Unknown history checkpoint.', 404); return structuredClone(checkpoint); },
  } as unknown as WorkspaceEngine;
  const dist = join(app.directory, 'dist'); await mkdir(dist); await writeFile(join(dist, 'index.html'), '<!doctype html><h1>Parent app</h1>');
  const server = createWorkspaceServer(fakeEngine, { distDirectory: dist });
  await new Promise<void>(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/api/tasks/${app.task.id}`;
  try {
    app.task.preview.html = '<!doctype html><p>Current new preview</p>';
    const current = await fetch(`${base}/preview`); assert.equal(current.status, 200); assert.match(await current.text(), /Current new preview/);
    assert.equal(current.headers.get('content-security-policy'), PREVIEW_CSP); assert.equal(current.headers.get('cache-control'), 'no-store'); assert.equal(current.headers.get('x-content-type-options'), 'nosniff'); assert.equal(current.headers.get('referrer-policy'), 'no-referrer');
    const recorded = await fetch(`${base}/preview?checkpoint=${checkpoint.id}`); assert.equal(recorded.status, 200); assert.match(await recorded.text(), /Captured old preview/);
    assert.equal((await fetch(`${base}/preview?checkpoint=${checkpoint.id}&path=index.html`)).status, 400);
    await writeFile(join(app.workspace, 'app.html'), '<!doctype html><h1>Actual changed app</h1>');
    await writeFile(join(app.workspace, 'report.md'), '# Actual report');
    assert.match(await (await fetch(`${base}/preview?path=app.html`)).text(), /Actual changed app/);
    assert.equal((await fetch(`${base}/preview?path=report.md`)).status, 415);
    assert.equal((await fetch(`${base}/preview?path=unchanged.md`)).status, 404);
    const source = await fetch(`${base}/file?path=app.html`); assert.match(source.headers.get('content-type') ?? '', /application\/json/); assert.equal((await source.json() as { language: string }).language, 'html');
    const history = await fetch(`http://127.0.0.1:${address.port}/api/history`); assert.equal(history.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/history/${checkpoint.id}`)).status, 200);
    app.state.mode = 'demo'; assert.equal((await fetch(`${base}/preview?checkpoint=${checkpoint.id}`)).status, 404);
    const parent = await fetch(`http://127.0.0.1:${address.port}/`); assert.match(parent.headers.get('content-security-policy') ?? '', /script-src 'self'/); assert.doesNotMatch(parent.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/);
  } finally { server.closeStreams(); server.server.closeAllConnections(); await new Promise<void>(resolve => server.server.close(() => resolve())); await app.close(); }
});
