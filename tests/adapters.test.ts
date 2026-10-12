import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectRepository } from '../server/inspector.ts';
import { checkProviders, runCommand, runProviderTask } from '../server/providers.ts';
import type { CommandRunner, ProviderTaskInput, ProviderTaskResult } from '../server/providers.ts';

async function repository(commit = false): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'startup-adapter-test-'));
  assert.equal((await runCommand('git', ['init', '-q'], { cwd: path })).exitCode, 0);
  if (commit) {
    await writeFile(join(path, 'README.md'), '# Test project\n\nA small test fixture for verifying isolated native process adapters without executing models.\n');
    assert.equal((await runCommand('git', ['add', 'README.md'], { cwd: path })).exitCode, 0);
    assert.equal((await runCommand('git', ['-c', 'user.name=Adapter Test', '-c', 'user.email=adapter@example.test', 'commit', '-qm', 'Fixture'], { cwd: path })).exitCode, 0);
  }
  return path;
}

function providerRunner(execute: CommandRunner): CommandRunner {
  return async (command, args, options) => {
    if (command !== 'codex' && command !== 'claude') return runCommand(command, args, options);
    if (args[0] === '--version') return { exitCode: 0, stdout: 'fixture-cli 1.0', stderr: '' };
    if (args[0] === 'login') return { exitCode: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    if (args[0] === 'auth') return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '' };
    return execute(command, args, options);
  };
}

function input(repoPath: string, commandRunner: CommandRunner): ProviderTaskInput {
  return { provider: 'codex', repoPath, task: { id: 'fixture-task', title: 'Improve the fixture docs', description: 'Change README only and report evidence.' }, agent: { name: 'Engineer', role: 'Developer', departmentId: 'engineering' }, mission: 'Useful, verifiable onboarding improvements', messages: [], commandRunner };
}

async function cleanup(path: string, result?: ProviderTaskResult): Promise<void> {
  if (result?.workspacePath) {
    await runCommand('git', ['worktree', 'remove', '--force', result.workspacePath], { cwd: path });
    await rm(dirname(result.workspacePath), { recursive: true, force: true });
  }
  await rm(path, { recursive: true, force: true });
}

test('native authentication detection returns only sanitized status, never native account metadata', async () => {
  const statuses = await checkProviders(async (command, args) => {
    if (args[0] === '--version') return { exitCode: 0, stdout: 'version', stderr: '' };
    return command === 'claude'
      ? { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: 'private@example.test', apiKey: 'fixture-secret-value' }), stderr: '' }
      : { exitCode: 0, stdout: 'Not logged in', stderr: 'fixture-secret-value' };
  });
  assert.equal(statuses[0].authenticated, true);
  assert.equal(statuses[1].authenticated, false);
  assert.doesNotMatch(JSON.stringify(statuses), /private@example|fixture-secret/);
});

test('missing executable and unsupported auth status remain truthful', async () => {
  const statuses = await checkProviders(async (command, args) => {
    if (command === 'claude') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { exitCode: args[0] === '--version' ? 0 : 2, stdout: '', stderr: 'unsupported argument' };
  });
  assert.equal(statuses[0].installed, false);
  assert.equal(statuses[1].installed, true);
  assert.equal(statuses[1].authenticated, null);
});

test('bounded audit produces grounded missing-manifest proposals without claiming no tests exist', async () => {
  const path = await repository();
  try {
    const result = await inspectRepository(path);
    assert.ok(result.findings.some(finding => finding.key === 'engineering:confirm-project-stack' && finding.requiresDirection));
    assert.ok(result.findings.some(finding => finding.departmentId === 'product'));
    assert.ok(result.findings.some(finding => finding.departmentId === 'marketing' && finding.description.includes('Hypothesis')));
    assert.equal(new Set(result.findings.map(finding => finding.key)).size, result.findings.length);
    assert.match(result.summary, /No project scripts or model runs/);
  } finally { await cleanup(path); }
});

test('audit rejects README symlinks that escape the repository', async () => {
  const path = await repository();
  const outside = await mkdtemp(join(tmpdir(), 'startup-outside-test-'));
  try {
    await writeFile(join(outside, 'private.txt'), 'Do not read this content.');
    await symlink(join(outside, 'private.txt'), join(path, 'README.md'));
    await assert.rejects(inspectRepository(path), /symlink points outside/);
  } finally {
    await cleanup(path);
    await rm(outside, { recursive: true, force: true });
  }
});

test('audit recognizes actual Node test entry points and bounds metadata reads', async () => {
  const path = await repository();
  try {
    await writeFile(join(path, 'package.json'), '{"scripts":{"test":"node --test","dev":"node app.js"}}');
    await mkdir(join(path, 'tests'));
    const result = await inspectRepository(path);
    assert.ok(!result.findings.some(finding => finding.key === 'engineering:locate-verification'));
    await writeFile(join(path, 'README.md'), 'x'.repeat(65_537));
    await assert.rejects(inspectRepository(path), /inspection limit/);
  } finally { await cleanup(path); }
});

test('provider runner blocks dirty and unborn repositories before any model execution', async () => {
  const unborn = await repository();
  const dirty = await repository(true);
  let executions = 0;
  const runner = providerRunner(async () => { executions++; return { exitCode: 0, stdout: '', stderr: '' }; });
  try {
    assert.match((await runProviderTask(input(unborn, runner))).error ?? '', /initial commit/);
    await writeFile(join(dirty, 'new.txt'), 'Uncommitted work');
    assert.match((await runProviderTask(input(dirty, runner))).error ?? '', /uncommitted changes/);
    assert.equal(executions, 0);
  } finally { await cleanup(unborn); await cleanup(dirty); }
});

test('native task uses an isolated worktree and records command failures, diffs and new files', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    const runner = providerRunner(async (command, args, options) => {
      assert.equal(command, 'codex');
      assert.deepEqual(args, ['exec', '--json', '--sandbox', 'workspace-write', '--color', 'never', '-']);
      assert.notEqual(options?.cwd, path);
      assert.match(options?.input ?? '', /Company mission: Useful/);
      assert.match(options?.input ?? '', /Do not publish/);
      await writeFile(join(options!.cwd!, 'README.md'), '# Improved fixture\n');
      await writeFile(join(options!.cwd!, 'new-guide.md'), 'Retained new file\n');
      return { exitCode: 17, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'node --test', exit_code: 1, aggregated_output: 'One test failed' } }) + '\n', stderr: 'Task failed' };
    });
    result = await runProviderTask(input(path, runner));
    assert.equal(result.exitCode, 17);
    assert.equal(result.worktreeChanged, true);
    assert.match(result.error ?? '', /did not exit successfully/);
    assert.ok(result.evidence?.some(item => item.kind === 'diff' && item.detail.includes('Improved fixture')));
    assert.ok(result.evidence?.some(item => item.kind === 'command' && item.label === 'Command exited 1'));
    assert.ok(result.evidence?.some(item => item.label === 'New files in retained worktree' && item.detail.includes('new-guide.md')));
    assert.equal((await runCommand('git', ['status', '--porcelain'], { cwd: path })).stdout, '');
  } finally { await cleanup(path, result); }
});

test('Claude execution uses native permission controls and treats conversation as a report', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    const runner = providerRunner(async (command, args) => {
      assert.equal(command, 'claude');
      assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
      return { exitCode: 0, stdout: '{"type":"result","result":"Tests passed according to the agent"}\n', stderr: '' };
    });
    result = await runProviderTask({ ...input(path, runner), provider: 'claude' });
    assert.equal(result.exitCode, 0);
    assert.ok(!result.evidence?.some(item => item.label === 'Command exited 0'));
  } finally { await cleanup(path, result); }
});

test('direction requests come only from validated final native assistant messages', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    const direction = { status: 'needs_direction', summary: 'Target user is unclear.', question: 'Who is the first user?', options: [{ id: 'solo', label: 'Solo developers', description: 'Optimize individual onboarding.' }, { id: 'teams', label: 'Teams', description: 'Optimize collaboration.' }], recommendationId: 'solo' };
    const runner = providerRunner(async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(direction) } }) + '\n', stderr: '' }));
    result = await runProviderTask(input(path, runner));
    assert.equal(result.directionRequest?.question, direction.question);
    assert.equal(result.directionRequest?.recommendationId, 'solo');
    assert.ok(result.evidence?.some(item => item.kind === 'report' && item.source === 'agent'));
    const logOnly = providerRunner(async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'print fixture', exit_code: 0, aggregated_output: JSON.stringify(direction) } }) + '\n', stderr: '' }));
    const second = await runProviderTask({ ...input(path, logOnly), upstreamWorkspacePath: result.workspacePath });
    assert.equal(second.directionRequest, undefined);
  } finally { await cleanup(path, result); }
});

test('canonical founder decisions survive beyond the recent conversation window', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    const runner = providerRunner(async (_command, _args, options) => {
      const prompt = options?.input ?? '';
      assert.match(prompt, /Resolved founder decisions \(canonical memory\)/);
      assert.match(prompt, /Thai-first documentation for solo developers/);
      assert.match(prompt, /Included 1 of 1 resolved decisions/);
      assert.doesNotMatch(prompt, /An old chat-only answer/);
      return { exitCode: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'completed', summary: 'Fixture checked prompt context only; no model or project tests were executed.' }) } }) + '\n', stderr: '' };
    });
    result = await runProviderTask({
      ...input(path, runner),
      messages: [
        { id: 'old', author: 'Founder', role: 'founder', text: 'An old chat-only answer', taskId: null, source: 'live', createdAt: '2026-01-01T00:00:00Z' },
        ...Array.from({ length: 25 }, (_, index) => ({ id: `recent-${index}`, author: 'Engineer', role: 'agent' as const, text: `Unrelated recent update ${index}`, taskId: null, source: 'live' as const, createdAt: '2026-01-02T00:00:00Z' })),
      ],
      decisions: [{ id: 'canonical-old', title: 'Audience and language', answer: 'Thai-first documentation for solo developers', departmentId: 'product', taskIds: ['fixture-task'], answeredAt: '2026-01-01T00:00:00Z' }],
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.evidence?.some(item => item.kind === 'report' && item.source === 'agent' && item.detail.includes('no model or project tests were executed')));
    assert.ok(!result.evidence?.some(item => item.label === 'Command exited 0'));
  } finally { await cleanup(path, result); }
});

test('malformed native direction requests block the task instead of appearing successful', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    for (const report of [
      { status: 'needs_direction', summary: 'I need an audience decision.' },
      { status: 'needs_direction', summary: 'I need an audience decision.', question: 42 },
      { status: 'needs_direction', question: 'Who is the intended user?' },
    ]) {
      const runner = providerRunner(async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } }) + '\n', stderr: '' }));
      result = await runProviderTask({ ...input(path, runner), upstreamWorkspacePath: result?.workspacePath });
      assert.equal(result.exitCode, 0);
      assert.equal(result.directionRequest, undefined);
      assert.match(result.blockedReason ?? '', /Malformed founder direction request/);
      assert.match(result.error ?? '', /without a valid question and summary/);
    }
  } finally { await cleanup(path, result); }
});

test('time and output limits are failures even when a native process reports exit zero', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    for (const flags of [{ timedOut: true }, { truncated: true }]) {
      const runner = providerRunner(async () => ({ exitCode: 0, stdout: '', stderr: '', ...flags }));
      result = await runProviderTask({ ...input(path, runner), upstreamWorkspacePath: result?.workspacePath });
      assert.equal(result.exitCode, 0);
      assert.match(result.error ?? '', flags.timedOut ? /time limit/ : /output reached its limit/);
      assert.ok(result.workspacePath);
    }
  } finally { await cleanup(path, result); }
});

test('accepted predecessor content reaches the next role in a validated retained worktree', async () => {
  const path = await repository(true);
  const foreign = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    result = await runProviderTask(input(path, providerRunner(async (_command, _args, options) => {
      await writeFile(join(options!.cwd!, 'README.md'), '# Accepted predecessor\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    })));
    let secondRuns = 0;
    const successor = providerRunner(async (_command, _args, options) => {
      secondRuns++;
      assert.equal(await readFile(join(options!.cwd!, 'README.md'), 'utf8'), '# Accepted predecessor\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const accepted = await runProviderTask({ ...input(path, successor), upstreamWorkspacePath: result.workspacePath });
    assert.equal(accepted.workspacePath, result.workspacePath);
    assert.equal(accepted.exitCode, 0);
    assert.equal(result.worktreeChanged, true);
    assert.equal(accepted.worktreeChanged, false);
    const rejected = await runProviderTask({ ...input(path, successor), upstreamWorkspacePath: foreign });
    assert.match(rejected.error ?? '', /not a worktree/);
    assert.equal(rejected.workspacePath, undefined);
    assert.equal(secondRuns, 1);
  } finally { await cleanup(path, result); await cleanup(foreign); }
});

test('workspace comparison observes untracked-file edits without reading their contents', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    result = await runProviderTask(input(path, providerRunner(async (_command, _args, options) => {
      await writeFile(join(options!.cwd!, 'draft.md'), 'first draft');
      return { exitCode: 0, stdout: '', stderr: '' };
    })));
    assert.equal(result.worktreeChanged, true);
    const updated = await runProviderTask({ ...input(path, providerRunner(async (_command, _args, options) => {
      await writeFile(join(options!.cwd!, 'draft.md'), 'other draft');
      return { exitCode: 0, stdout: '', stderr: '' };
    })), upstreamWorkspacePath: result.workspacePath });
    assert.equal(updated.worktreeChanged, true);
    assert.ok(updated.evidence?.some(item => item.label === 'Task workspace comparison' && item.detail.includes('metadata changed')));
  } finally { await cleanup(path, result); }
});

test('incomplete workspace snapshots conservatively require renewed review', async () => {
  const path = await repository(true);
  let result: ProviderTaskResult | undefined;
  try {
    let diffCalls = 0;
    const ordinary = providerRunner(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const runner: CommandRunner = async (command, args, options) => {
      if (command === 'git' && args[0] === 'diff' && diffCalls++ === 0) return { exitCode: 1, stdout: '', stderr: 'Fixture snapshot failed' };
      return ordinary(command, args, options);
    };
    result = await runProviderTask(input(path, runner));
    assert.equal(result.worktreeChanged, true);
    assert.ok(result.evidence?.some(item => item.label === 'Task workspace comparison' && item.detail.includes('comparison was incomplete')));
  } finally { await cleanup(path, result); }
});

test('native subprocess cancellation stops a running process without shell execution', async () => {
  const controller = new AbortController();
  const running = runCommand(process.execPath, ['-e', 'process.stdout.write("started"); setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 3000 });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.interrupted, true);
  assert.equal(result.exitCode, null);
});

test('native subprocess output limit stops runaway output', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000)'], { outputLimitBytes: 1024, timeoutMs: 3000 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1024);
});
