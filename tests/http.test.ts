import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceEngine } from '../server/engine.ts';
import { WorkspaceStore } from '../server/store.ts';
import { createWorkspaceServer } from '../server/index.ts';
import type { WorkspaceState } from '../src/lib/types.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'startup-http-test-'));
  const dist = join(directory, 'dist');
  await mkdir(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>Workspace fixture</title>');
  const engine = await WorkspaceEngine.open(new WorkspaceStore(join(directory, 'state')), {
    checkProviders: async () => [],
    inspectRepository: async () => ({ summary: 'Fixture audit', findings: [] }),
    runProviderTask: async () => ({ exitCode: 0, stdout: 'Fixture report', stderr: '' }),
  }, { scheduler: false });
  const app = createWorkspaceServer(engine, { distDirectory: dist, maxBodyBytes: 2048 });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    ...app, engine, directory, dist, url,
    async close() {
      app.closeStreams();
      await engine.close();
      app.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('HTTP refuses cross-origin mutations without changing founder direction', async () => {
  const app = await fixture();
  try {
    const original = app.engine.getState().company.mission;
    const payload = JSON.stringify({ type: 'set_mission', mission: 'Unwanted cross-origin change' });
    const refused = await fetch(`${app.url}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: payload });
    assert.equal(refused.status, 403);
    assert.equal(app.engine.getState().company.mission, original);
    const accepted = await fetch(`${app.url}/api/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url }, body: payload });
    assert.equal(accepted.status, 200);
    assert.equal(app.engine.getState().company.mission, 'Unwanted cross-origin change');
  } finally { await app.close(); }
});

test('HTTP rejects malformed, excessive and unsupported mutation requests', async () => {
  const app = await fixture();
  try {
    const request = (body: string, contentType = 'application/json') => fetch(`${app.url}/api/actions`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    assert.equal((await request('{')).status, 400);
    assert.equal((await request(JSON.stringify({ type: 'rename_company', name: 'x', unexpected: true }))).status, 400);
    assert.equal((await request('{}', 'text/plain')).status, 415);
    assert.equal((await request(JSON.stringify({ type: 'send_message', text: 'x'.repeat(3000) }))).status, 413);
    assert.equal((await fetch(`${app.url}/api/actions`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${app.url}/api/state`)).status, 200);
  } finally { await app.close(); }
});

test('SSE sends an initial snapshot and saved changes', async () => {
  const app = await fixture();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${app.url}/api/events`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function snapshot(): Promise<WorkspaceState> {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (event.startsWith('event: state\n')) return JSON.parse(event.slice('event: state\ndata: '.length)) as WorkspaceState;
          continue;
        }
        const chunk = await reader!.read();
        if (chunk.done) throw new Error('Event stream ended before a snapshot arrived');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    assert.equal((await snapshot()).mode, 'demo');
    await app.engine.dispatch({ type: 'rename_company', name: 'A saved company update' });
    assert.equal((await snapshot()).company.name, 'A saved company update');
  } finally {
    clearTimeout(timeout);
    await reader?.cancel();
    controller.abort();
    await app.close();
  }
});

test('production serving provides the built page and rejects escaping file paths', async () => {
  const app = await fixture();
  try {
    await writeFile(join(app.directory, 'outside.json'), '{"fixture":"outside"}');
    await symlink(join(app.directory, 'outside.json'), join(app.dist, 'outside.json'));
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Workspace fixture/);
    assert.equal((await fetch(`${app.url}/outside.json`)).status, 403);
    assert.equal((await fetch(`${app.url}/%2e%2e%2foutside.json`)).status, 403);
    const template = await fetch(`${app.url}/api/template`);
    const saved = await template.json();
    assert.equal(saved.schemaVersion, 1);
    assert.ok(Array.isArray(saved.agents));
    assert.equal(saved.repoPath, undefined);
  } finally { await app.close(); }
});
