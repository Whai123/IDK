import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { EngineAdapters } from '../server/engine.ts';
import { runCommand } from '../server/providers.ts';
import type { CommandRunner } from '../server/providers.ts';
import { launchLocalPilot, parsePilotArgs } from '../scripts/local-pilot.ts';

async function fixture(t: TestContext, run?: EngineAdapters['runProviderTask']) {
  const directory = await mkdtemp(join(tmpdir(), 'startup-local-pilot-test-'));
  const repoPath = join(directory, 'repo');
  const codexHome = join(directory, 'cli-runtime');
  const retained = join(directory, 'retained');
  await Promise.all([mkdir(repoPath), mkdir(codexHome), mkdir(retained)]);
  await writeFile(join(repoPath, '.gitignore'), '.startup-os/\n.cache/\nnode_modules/\ndist/\n');
  await writeFile(join(repoPath, 'README.md'), 'A fixture for a bounded local pilot.\n');
  for (const args of [
    ['init', '-q'],
    ['add', '.gitignore', 'README.md'],
    ['-c', 'user.name=Pilot Fixture', '-c', 'user.email=pilot@example.invalid', 'commit', '-qm', 'Fixture baseline'],
  ]) {
    const result = await runCommand('git', args, { cwd: repoPath });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const calls: Parameters<EngineAdapters['runProviderTask']>[0][] = [];
  const commandCalls: { command: string; args: string[] }[] = [];
  const adapters: EngineAdapters = {
    inspectRepository: async path => ({ repoPath: path, summary: 'Fixture metadata; no scripts or models run.', findings: [] }),
    checkProviders: async () => [{ id: 'codex', installed: true, authenticated: true, detail: 'Stubbed authentication for tests.', checkedAt: new Date().toISOString() }],
    runProviderTask: async input => {
      calls.push(input);
      return run ? run(input) : { exitCode: 0, stdout: 'Stubbed delivery for launcher tests.', stderr: '', workspacePath: input.upstreamWorkspacePath ?? retained, worktreeChanged: false };
    },
  };
  const runner: CommandRunner = async (command, args, options) => {
    commandCalls.push({ command, args });
    if (command === 'git') return runCommand(command, args, options);
    if (command === 'codex' && args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli test', stderr: '' };
    if (command === 'codex' && args.join(' ') === 'login status') return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT (test fixture)' };
    throw new Error('Unexpected native command in launcher test: ' + command + ' ' + args.join(' '));
  };
  const options = { repoPath, codexHome, temporaryDirectory: directory, adapters, runner, log: (_line: string) => {}, serveUi: false, keepUiOpen: false, timeoutMs: 10_000 };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repoPath, adapters, calls, commandCalls, options };
}

test('local pilot defaults to prerequisite checks and requires an explicit run flag', async t => {
  const f = await fixture(t);
  assert.equal(parsePilotArgs([]).run, false);
  assert.equal(parsePilotArgs(['--run']).run, true);
  assert.throws(() => parsePilotArgs(['--rnu']));
  const result = await launchLocalPilot(f.options);
  assert.equal(result.kind, 'readiness');
  assert.equal(f.calls.length, 0);
  assert.ok(f.commandCalls.every(call => !(call.command === 'codex' && call.args[0] === 'exec')));
  assert.equal((await runCommand('git', ['status', '--porcelain'], { cwd: f.repoPath })).stdout, '');
});

test('local pilot delivers only its Engineering and dependent QA jobs and leaves founder acceptance pending', async t => {
  const f = await fixture(t);
  const result = await launchLocalPilot({ ...f.options, run: true });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.provider === 'codex'));
  assert.match(f.calls[1].agent.role, /quality|\bqa\b|test/i);
  const engineering = result.state.tasks.find(task => task.id === result.engineeringTaskId)!;
  const qa = result.state.tasks.find(task => task.id === result.qaTaskId)!;
  assert.equal(engineering.status, 'review');
  assert.equal(qa.status, 'review');
  assert.deepEqual(qa.dependsOn, [engineering.id]);
  assert.equal(qa.handoff, 'delivery');
  assert.equal(f.calls[1].upstreamWorkspacePath, engineering.workspacePath);
  assert.equal(result.state.config.allowProviderRuns, false);
  assert.ok(result.state.tasks.every(task => task.status !== 'done'));
  assert.equal((await runCommand('git', ['status', '--porcelain'], { cwd: f.repoPath })).stdout, '');
});

test('local pilot refuses a dirty repository before any model job', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repoPath, 'README.md'), 'Uncommitted founder work.\n');
  await assert.rejects(launchLocalPilot({ ...f.options, run: true }), /clean|uncommitted|dirty|readiness/i);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(join(f.repoPath, 'README.md'), 'utf8'), 'Uncommitted founder work.\n');
});

test('a failed Engineering job retains partial output, disables runs, and never invokes QA', async t => {
  const f = await fixture(t, async () => ({ exitCode: 1, stdout: 'Partial fixture output retained.', stderr: 'Fixture runtime failed.' }));
  const result = await launchLocalPilot({ ...f.options, run: true });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(f.calls.length, 1);
  const engineering = result.state.tasks.find(task => task.id === result.engineeringTaskId)!;
  assert.equal(engineering.status, 'failed');
  assert.match(engineering.artifact, /Partial fixture output retained/);
  assert.equal(result.qaTaskId, undefined);
  assert.equal(result.state.config.allowProviderRuns, false);
});

test('a founder direction request stops the pilot without selecting an answer or running QA', async t => {
  const f = await fixture(t, async () => ({ exitCode: 0, stdout: 'Fixture asks for direction.', stderr: '', directionRequest: { question: 'Which provider status should count as available?' } }));
  const result = await launchLocalPilot({ ...f.options, run: true });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(f.calls.length, 1);
  const engineering = result.state.tasks.find(task => task.id === result.engineeringTaskId)!;
  assert.equal(engineering.status, 'waiting');
  assert.ok(result.state.decisions.some(decision => decision.status === 'open' && decision.taskIds.includes(engineering.id)));
  assert.equal(result.state.config.allowProviderRuns, false);
  assert.equal(result.qaTaskId, undefined);
});

test('an already cancelled pilot never invokes a model', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(launchLocalPilot({ ...f.options, run: true, signal: controller.signal }), /cancelled|aborted|interrupt/i);
  assert.equal(f.calls.length, 0);
});

test('cancellation while the task is queued prevents the native job from starting', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await launchLocalPilot({ ...f.options, run: true, signal: controller.signal, log: line => {
    if (/Refresh provider status: queued/.test(line)) controller.abort();
  } });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(result.outcome, 'interrupted');
  assert.equal(f.calls.length, 0);
  assert.equal(result.state.config.allowProviderRuns, false);
  assert.ok(result.state.tasks.every(task => !['running', 'done'].includes(task.status)));
});

test('cancellation interrupts a running job and preserves partial output without a QA handoff', async t => {
  const controller = new AbortController();
  let workerInterrupted = false;
  const f = await fixture(t, async input => {
    const result = new Promise<Awaited<ReturnType<EngineAdapters['runProviderTask']>>>(resolve => {
      const interrupted = () => {
        workerInterrupted = true;
        resolve({ exitCode: null, stdout: 'Partial cancelled fixture work.', stderr: '', interrupted: true });
      };
      if (input.signal.aborted) interrupted();
      else input.signal.addEventListener('abort', interrupted, { once: true });
    });
    setImmediate(() => controller.abort());
    return result;
  });
  const result = await launchLocalPilot({ ...f.options, run: true, signal: controller.signal });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(result.outcome, 'interrupted');
  assert.equal(workerInterrupted, true);
  assert.equal(f.calls.length, 1);
  const engineering = result.state.tasks.find(task => task.id === result.engineeringTaskId)!;
  assert.equal(engineering.status, 'paused');
  assert.match(engineering.artifact, /Partial cancelled fixture work/);
  assert.equal(result.state.config.allowProviderRuns, false);
  assert.equal(result.qaTaskId, undefined);
});

test('the evidence viewer escapes output, rejects foreign hosts and refuses founder mutations', async t => {
  const maliciousOutput = '<script>alert("fixture")</script>';
  const f = await fixture(t, async input => ({ exitCode: 0, stdout: maliciousOutput, stderr: '', workspacePath: input.upstreamWorkspacePath ?? join(f.directory, 'retained'), worktreeChanged: false }));
  const result = await launchLocalPilot({ ...f.options, run: true, serveUi: true, keepUiOpen: true });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.ok(result.url);
  const page = await fetch(result.url!);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /read-only/);
  assert.ok(!html.includes(maliciousOutput));
  assert.match(html, /&lt;script&gt;/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const foreignStatus = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(result.url!, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(foreignStatus, 403);
  const refused = await fetch(result.url! + '/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'task_action', taskId: result.engineeringTaskId, action: 'accept' }) });
  assert.equal(refused.status, 403);
  const live = await (await fetch(result.url! + '/api/state')).json();
  assert.equal(live.tasks.find((task: { id: string; status: string }) => task.id === result.engineeringTaskId).status, 'review');
  assert.equal(live.config.allowProviderRuns, false);
  assert.equal(f.calls.length, 2);
});

test('a failed independent QA job cannot be reported as ready for founder review', async t => {
  let runs = 0;
  const f = await fixture(t, async input => {
    runs++;
    return runs === 1
      ? { exitCode: 0, stdout: 'Fixture Engineering delivery.', stderr: '', workspacePath: join(f.directory, 'retained') }
      : { exitCode: 1, stdout: 'Fixture QA found a failed check.', stderr: '', workspacePath: input.upstreamWorkspacePath, worktreeChanged: false };
  });
  const result = await launchLocalPilot({ ...f.options, run: true });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(result.outcome, 'failed');
  assert.equal(f.calls.length, 2);
  assert.equal(result.state.tasks.find(task => task.id === result.engineeringTaskId)?.status, 'review');
  assert.equal(result.state.tasks.find(task => task.id === result.qaTaskId)?.status, 'failed');
  assert.equal(result.state.config.allowProviderRuns, false);
});

test('the trial deadline interrupts a running worker and disables further execution', async t => {
  let workerInterrupted = false;
  const f = await fixture(t, async input => new Promise(resolve => {
    const interrupted = () => {
      workerInterrupted = true;
      resolve({ exitCode: null, stdout: 'Fixture work preserved after timeout.', stderr: '', interrupted: true });
    };
    if (input.signal.aborted) interrupted();
    else input.signal.addEventListener('abort', interrupted, { once: true });
  }));
  const result = await launchLocalPilot({ ...f.options, run: true, timeoutMs: 300 });
  assert.equal(result.kind, 'mission');
  if (result.kind !== 'mission') return;
  t.after(result.close);
  assert.equal(result.outcome, 'timed_out');
  assert.equal(workerInterrupted, true);
  assert.equal(f.calls.length, 1);
  assert.equal(result.state.tasks.find(task => task.id === result.engineeringTaskId)?.status, 'paused');
  assert.equal(result.state.config.allowProviderRuns, false);
  assert.equal(result.qaTaskId, undefined);
});
