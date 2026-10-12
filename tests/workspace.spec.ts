import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ActionResponse, HistoryCheckpoint, HistoryResponse, TeamTemplate, WorkspaceAction, WorkspaceState } from '../src/lib/types.ts';

const apiUrl = 'http://127.0.0.1:4174';

async function state(request: APIRequestContext): Promise<WorkspaceState> {
  const response = await request.get(`${apiUrl}/api/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function act(request: APIRequestContext, action: WorkspaceAction): Promise<WorkspaceState> {
  const response = await request.post(`${apiUrl}/api/actions`, { data: action });
  expect(response.ok()).toBeTruthy();
  const body = await response.json() as ActionResponse;
  return body.state;
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

async function connect(page: Page, repoPath: string) {
  await settings(page);
  await page.getByLabel('Repository path', { exact: true }).fill(repoPath);
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await act(request, { type: 'reset_demo' });
  await act(request, { type: 'set_config', config: { paused: true, autoInspect: false, allowProviderRuns: false } });
});

test('sample work stays labeled and department filtering includes marketing', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('Sample workspace', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Departments', exact: true }).getByRole('button', { name: /^Marketing/ }).click();
  const tasks = page.getByTestId('task-card');
  await expect(tasks.first()).toBeVisible();
  const snapshot = await state(request);
  const marketingTasks = snapshot.tasks.filter(task => task.departmentId === 'marketing' && task.status !== 'dismissed');
  expect(marketingTasks.length).toBeGreaterThan(0);
  for (const task of marketingTasks) {
    await expect(tasks.filter({ hasText: task.title })).toBeVisible();
  }
  const otherTask = snapshot.tasks.find(task => task.departmentId === 'engineering' && task.status !== 'dismissed');
  expect(otherTask).toBeDefined();
  await expect(tasks.filter({ hasText: otherTask!.title })).toHaveCount(0);
});

test('founder direction persists across reload and unblocks its assigned work', async ({ page, request }) => {
  await page.goto('/');
  const before = await state(request);
  const decision = before.decisions.find(item => item.status === 'open');
  expect(decision).toBeDefined();
  const card = page.getByTestId('decision-card').filter({ hasText: decision!.title });
  await expect(card).toBeVisible();
  const direction = 'Focus on developer onboarding before launch campaigns.';
  await card.getByText('Give different direction', { exact: true }).click();
  await card.getByLabel('Your direction', { exact: true }).fill(direction);
  await card.getByRole('button', { name: 'Send direction', exact: true }).click();
  await expect.poll(async () => (await state(request)).decisions.find(item => item.id === decision!.id)?.status).toBe('resolved');
  await page.reload();
  const after = await state(request);
  const resolved = after.decisions.find(item => item.id === decision!.id);
  expect(resolved?.answer).toBe(direction);
  expect(resolved?.answeredAt).toBeTruthy();
  expect(after.messages.some(message => message.role === 'founder' && message.text.includes(direction))).toBeTruthy();
  for (const taskId of decision!.taskIds) {
    const task = after.tasks.find(item => item.id === taskId);
    if (task && task.status !== 'done' && task.status !== 'dismissed') {
      expect(task.requiresDirection).toBe(false);
      const dependenciesAccepted = task.dependsOn.every(id => after.tasks.find(item => item.id === id)?.status === 'done');
      if (dependenciesAccepted) expect(task.status).not.toBe('waiting');
      else expect(task.status).toBe('waiting');
    }
  }
});

test('changing mission records a new revision and pauses affected work', async ({ page, request }) => {
  await page.goto('/');
  const before = await state(request);
  const affected = before.tasks.filter(task => !['done', 'dismissed', 'failed'].includes(task.status));
  expect(affected.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Edit mission', exact: true }).click();
  const mission = 'Help a new contributor install this repository in two minutes.';
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Company mission', { exact: true }).fill(mission);
  await dialog.getByRole('button', { name: 'Save mission', exact: true }).click();
  await expect.poll(async () => (await state(request)).company.mission).toBe(mission);
  const after = await state(request);
  expect(after.company.missionRevision).toBe(before.company.missionRevision + 1);
  expect(after.tasks.filter(task => affected.some(previous => previous.id === task.id) && task.status === 'paused').length).toBeGreaterThan(0);
  expect(after.decisions.some(decision => decision.status === 'open')).toBeTruthy();
  await page.reload();
  await expect(page.getByText(mission, { exact: true }).first()).toBeVisible();
});

test('connecting a fixture repo yields observed evidence and dismissed proposals stay dismissed', async ({ page, request }) => {
  const fixture = await mkdtemp(join(tmpdir(), 'founder-workspace-repo-'));
  try {
    await writeFile(join(fixture, 'package.json'), JSON.stringify({
      name: 'browser-audit-fixture',
      version: '1.0.0',
      scripts: { test: 'node --test' },
    }, null, 2));
    execFileSync('git', ['init', '--quiet', fixture]);
    await page.goto('/');
    await connect(page, fixture);
    await expect.poll(async () => (await state(request)).company.repoPath).toBe(fixture);
    await page.getByRole('button', { name: 'Inspect repository', exact: true }).click();
    await expect.poll(async () => (await state(request)).tasks.filter(task => task.source === 'repo').length).toBeGreaterThan(0);
    const inspected = await state(request);
    expect(inspected.mode).toBe('live');
    expect(inspected.tasks.every(task => task.source !== 'sample')).toBeTruthy();
    const evidence = inspected.tasks.flatMap(task => task.evidence).filter(item => item.source === 'observed');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some(item => /package\.json|readme/i.test(`${item.label} ${item.detail}`))).toBeTruthy();
    expect(inspected.tasks.flatMap(task => task.evidence).some(item => item.source === 'sample')).toBe(false);
    const proposal = inspected.tasks.find(task => task.source === 'repo' && task.status === 'proposed');
    expect(proposal).toBeDefined();
    await page.getByRole('navigation', { name: 'Company', exact: true }).getByRole('button', { name: /^Overview/ }).click();
    const card = page.getByTestId('task-card').filter({ hasText: proposal!.title });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Dismiss proposal', exact: true }).click();
    await expect.poll(async () => (await state(request)).tasks.find(task => task.id === proposal!.id)?.status).toBe('dismissed');
    await act(request, { type: 'inspect_repo' });
    const reinspected = await state(request);
    expect(reinspected.tasks.find(task => task.id === proposal!.id)?.status).toBe('dismissed');
    expect(reinspected.tasks.filter(task => task.title === proposal!.title && task.status === 'proposed')).toHaveLength(0);
    await page.reload();
    await expect(page.getByTestId('task-card').filter({ hasText: proposal!.title })).toHaveCount(0);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('mobile navigation opens and the workspace fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  const marketingNav = page.getByRole('navigation', { name: 'Departments', exact: true }).getByRole('button', { name: /^Marketing/ });
  await expect(marketingNav).toBeVisible();
  await marketingNav.click();
  await expect(page.getByTestId('task-card').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('a shared team template carries roles without repository paths or execution state', async ({ request }) => {
  const before = await state(request);
  const response = await request.get(`${apiUrl}/api/template`);
  expect(response.ok()).toBeTruthy();
  const template = await response.json() as TeamTemplate;
  expect(template.agents).toHaveLength(before.agents.length);
  expect(template.agents.map(agent => agent.departmentId)).toEqual(before.agents.map(agent => agent.departmentId));
  expect(template.agents.map(agent => agent.provider)).toEqual(before.agents.map(agent => agent.provider));
  expect(template).not.toHaveProperty('repoPath');
  expect(template).not.toHaveProperty('tasks');
  expect(template).not.toHaveProperty('messages');
  expect(template).not.toHaveProperty('providers');
  expect(template.agents.every(agent => !('id' in agent))).toBeTruthy();
  const imported = await act(request, {
    type: 'import_template',
    template: { ...template, name: 'Imported test company', mission: 'Build a developer-friendly onboarding flow.' },
  });
  expect(imported.company.name).toBe('Imported test company');
  expect(imported.company.mission).toBe('Build a developer-friendly onboarding flow.');
  expect(imported.agents.map(agent => ({ ...agent, id: undefined }))).toEqual(template.agents.map(agent => ({ ...agent, id: undefined })));
});

async function openOffice(page: Page) {
  await page.getByRole('navigation', { name: 'Company', exact: true }).getByRole('button', { name: /^3D Office/ }).click();
  await expect(page.getByTestId('office-scene-host')).toBeVisible();
}

test('the office shows the configured departments and offers keyboard access to sample task evidence', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await openOffice(page);
  const snapshot = await state(request);
  expect(snapshot.departments).toHaveLength(7);
  const canvas = page.getByTestId('office-canvas');
  await expect(canvas).toHaveAttribute('data-renderer-ready', 'true');
  await expect(canvas).toHaveAttribute('data-agent-count', String(snapshot.agents.length));
  await expect(page.getByText('Sample workspace', { exact: true }).first()).toBeVisible();
  for (const department of snapshot.departments) {
    await expect(page.getByRole('button', { name: `Select ${department.name} department`, exact: true })).toBeVisible();
  }
  const directory = page.getByLabel('Office team directory', { exact: true });
  for (const agent of snapshot.agents) {
    await expect(directory.getByRole('button', { name: `Select ${agent.name}`, exact: true })).toBeVisible();
  }
  const delivered = snapshot.tasks.find(task => ['review', 'done'].includes(task.status) && task.agentId && task.evidence.length > 0)!;
  expect(delivered).toBeDefined();
  const owner = snapshot.agents.find(agent => agent.id === delivered.agentId)!;
  const teammate = directory.getByRole('button', { name: `Select ${owner.name}`, exact: true });
  await teammate.focus();
  await teammate.press('Enter');
  const inspector = page.getByTestId('office-inspector');
  await expect(inspector.getByRole('heading', { name: owner.name, exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: `Inspect task: ${delivered.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: delivered.title, exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Evidence', exact: true }).click();
  await expect(dialog.getByText(delivered.evidence[0].label, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('article').filter({ hasText: delivered.evidence[0].label }).getByText('Sample', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('office state updates retain one canvas and leaving the view releases the old scene', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await openOffice(page);
  const canvas = page.getByTestId('office-canvas');
  await expect(canvas).toHaveAttribute('data-renderer-ready', 'true');
  const originalCanvas = await canvas.elementHandle();
  const before = await state(request);
  const agent = before.agents.find(item => item.departmentId === 'marketing')!;
  await page.getByLabel('Office team directory', { exact: true }).getByRole('button', { name: `Select ${agent.name}`, exact: true }).click();
  await act(request, { type: 'update_agent', agentId: agent.id, name: 'Updated marketing lead' });
  await expect(page.getByTestId('office-inspector').getByRole('heading', { name: 'Updated marketing lead', exact: true })).toBeVisible();
  await act(request, { type: 'add_agent', name: 'New operations teammate', role: 'Release coordinator', departmentId: 'operations', provider: 'codex' });
  await expect(canvas).toHaveAttribute('data-agent-count', String(before.agents.length + 1));
  await expect(canvas).toHaveCount(1);
  expect(await originalCanvas!.evaluate(element => element === document.querySelector('[data-testid="office-canvas"]'))).toBe(true);
  await page.getByTestId('office-inspector').getByRole('button', { name: 'Edit teammate', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await originalCanvas!.evaluate(element => element === document.querySelector('[data-testid="office-canvas"]'))).toBe(true);
  const templateResponse = await request.get(`${apiUrl}/api/template`);
  expect(templateResponse.ok()).toBeTruthy();
  const template = await templateResponse.json() as TeamTemplate;
  const imported = await act(request, { type: 'import_template', template });
  // Import replaces role IDs: an old edit form must not turn into an add form.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const remapped = imported.agents.find(item => item.name === 'Updated marketing lead')!;
  expect(remapped.id).not.toBe(agent.id);
  expect(imported.agents.some(item => item.id === agent.id)).toBe(false);
  await expect(page.getByTestId('office-inspector').getByRole('heading', { name: remapped.name, exact: true })).toBeVisible();
  await expect(page.getByLabel('Office team directory', { exact: true }).getByRole('button', { name: `Select ${remapped.name}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await originalCanvas!.evaluate(element => element === document.querySelector('[data-testid="office-canvas"]'))).toBe(true);
  await page.getByRole('navigation', { name: 'Company', exact: true }).getByRole('button', { name: /^Overview/ }).click();
  await expect(canvas).toHaveCount(0);
  expect(await originalCanvas!.evaluate(element => element.isConnected)).toBe(false);
  await openOffice(page);
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute('data-renderer-ready', 'true');
  await expect(canvas).toHaveAttribute('data-agent-count', String(before.agents.length + 1));
  expect(pageErrors).toEqual([]);
});

test('the office remains usable on mobile when WebGL is unavailable', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
      if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [contextId, ...args]);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await openOffice(page);
  await expect(page.getByTestId('office-webgl-fallback')).toBeVisible();
  const snapshot = await state(request);
  const agent = snapshot.agents[0];
  await page.getByLabel('Office team directory', { exact: true }).getByRole('button', { name: `Select ${agent.name}`, exact: true }).click();
  const inspector = page.getByTestId('office-inspector');
  await expect(inspector.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
  const assigned = snapshot.tasks.find(task => task.agentId === agent.id)!;
  expect(assigned).toBeDefined();
  await inspector.getByRole('button', { name: `Inspect task: ${assigned.title}`, exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: assigned.title, exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});

async function mission(page: Page) {
  await page.getByRole('navigation', { name: 'Company', exact: true }).getByRole('button', { name: 'Mission', exact: true }).click();
}

test('mission planning connects task ownership, prerequisite work, and clearly sourced evidence', async ({ page, request }) => {
  const snapshot = await state(request);
  await page.goto('/');
  await mission(page);
  await expect(page.getByRole('heading', { name: snapshot.company.mission, exact: true }).first()).toBeVisible();
  const qa = snapshot.tasks.find(task => task.dependsOn.length && task.departmentId === 'engineering' && task.stage === 'verify')!;
  expect(qa).toBeDefined();
  await page.locator(`.mission-nodes [data-mission-task="${qa.id}"]`).click();
  const inspector = page.getByTestId('mission-task-inspector');
  await expect(inspector.getByRole('heading', { name: qa.title, exact: true })).toBeVisible();
  await expect(inspector).toContainText(snapshot.agents.find(agent => agent.id === qa.agentId)!.name);
  for (const dependencyId of qa.dependsOn) {
    await expect(inspector).toContainText(snapshot.tasks.find(task => task.id === dependencyId)!.title);
  }
  expect(qa.status).toBe('waiting');
  expect(qa.requiresDirection).toBe(false);
  const delivered = snapshot.tasks.find(task => ['review', 'done'].includes(task.status) && task.evidence.length)!;
  await page.locator(`.mission-nodes [data-mission-task="${delivered.id}"]`).click();
  await inspector.getByRole('button', { name: 'Open workbench', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: delivered.title, exact: true })).toBeVisible();
  await dialog.getByRole('tab', { name: 'Evidence', exact: true }).click();
  await expect(dialog.getByRole('article').filter({ hasText: delivered.evidence[0].label }).getByText('Sample', { exact: true })).toBeVisible();
});

test('a founder can create bounded dependent work without implicitly starting an AI job', async ({ page, request }) => {
  const before = await state(request);
  const owner = before.agents.find(agent => agent.role === 'Quality engineer')!;
  const dependency = before.tasks.find(task => task.id === 'demo-engineering')!;
  await page.goto('/');
  await mission(page);
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = 'Review the first-run setup instructions';
  const description = 'Review the documented setup commands after the first-run implementation. Report one reproducibility issue and its evidence.';
  await dialog.getByLabel('Task title', { exact: true }).fill(title);
  await dialog.getByLabel('Task description', { exact: true }).fill(description);
  await dialog.getByLabel('Department', { exact: true }).selectOption('engineering');
  await dialog.getByLabel('Owner', { exact: true }).selectOption(owner.id);
  await dialog.getByLabel('Priority', { exact: true }).selectOption('high');
  await dialog.getByLabel('Dependencies', { exact: true }).selectOption([dependency.id]);
  await dialog.getByLabel('Founder direction required', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Create proposal', exact: true }).click();
  await expect.poll(async () => (await state(request)).tasks.some(task => task.title === title)).toBe(true);
  const after = await state(request);
  const created = after.tasks.find(task => task.title === title)!;
  expect(created.description).toBe(description);
  expect(created.departmentId).toBe('engineering');
  expect(created.agentId).toBe(owner.id);
  expect(created.dependsOn).toEqual([dependency.id]);
  expect(created.missionRevision).toBe(before.company.missionRevision);
  expect(created.status).toBe('waiting');
  expect(created.requiresDirection).toBe(true);
  expect(created.evidence).toHaveLength(0);
  expect(created.workspacePath).toBeUndefined();
  expect(after.config.allowProviderRuns).toBe(false);
  expect(after.decisions.some(decision => decision.status === 'open' && decision.taskIds.includes(created.id))).toBe(true);
  expect(after.activity.filter(event => event.title === 'Native provider job started')).toHaveLength(0);
  await page.reload();
  await mission(page);
  await page.locator(`.mission-nodes [data-mission-task="${created.id}"]`).click();
  await expect(page.getByTestId('mission-task-inspector').getByRole('heading', { name: title, exact: true })).toBeVisible();
});

test('a direction choice shows affected work and retains unresolved QA dependencies', async ({ page, request }) => {
  const before = await state(request);
  const decision = before.decisions.find(item => item.id === 'demo-launch-channel')!;
  await page.goto('/');
  const card = page.getByTestId('decision-card').filter({ hasText: decision.title });
  const impact = card.getByTestId('decision-impact');
  await expect(impact).toBeVisible();
  for (const taskId of decision.taskIds) {
    await expect(impact).toContainText(before.tasks.find(task => task.id === taskId)!.title);
  }
  const blocked = before.tasks.find(task => decision.taskIds.includes(task.id) && task.dependsOn.some(id => before.tasks.find(parent => parent.id === id)?.status !== 'done'))!;
  const prerequisite = before.tasks.find(task => task.id === blocked.dependsOn[0])!;
  await expect(impact).toContainText(prerequisite.title);
  const recommendation = decision.options.find(option => option.id === decision.recommendationId)!;
  await card.locator(`[data-option="${recommendation.id}"]`).click();
  await expect.poll(async () => (await state(request)).decisions.find(item => item.id === decision.id)?.status).toBe('resolved');
  const after = await state(request);
  const unchangedPrerequisite = after.tasks.find(task => task.id === prerequisite.id)!;
  expect(unchangedPrerequisite.status).toBe(prerequisite.status);
  const stillBlocked = after.tasks.find(task => task.id === blocked.id)!;
  expect(stillBlocked.requiresDirection).toBe(false);
  expect(stillBlocked.status).toBe('waiting');
  await mission(page);
  await page.locator(`.mission-nodes [data-mission-task="${blocked.id}"]`).click();
  await expect(page.getByTestId('mission-task-inspector')).toContainText(prerequisite.title);
});

test('an HTML workbench preview is interactive while isolating the workspace and blocking external fetches', async ({ page, request }) => {
  const snapshot = await state(request);
  const task = snapshot.tasks.find(item => ['review', 'done'].includes(item.status) && item.departmentId === 'product')!;
  const html = '<!doctype html><html><body><h1>Sample interactive preview</h1><button id="increment">Try preview</button><output id="count">0</output><script>let previewClicks=0;document.getElementById("increment").addEventListener("click",()=>{document.getElementById("count").textContent=String(++previewClicks)});document.documentElement.dataset.previewReady="true";</script></body></html>';
  await act(request, { type: 'set_task_preview', taskId: task.id, html });
  let escapedNetworkRequests = 0;
  await page.route('https://preview-network.invalid/**', async route => {
    escapedNetworkRequests++;
    await route.fulfill({ status: 200, body: 'The preview should not reach this route.' });
  });
  await page.goto('/');
  await page.getByTestId('task-card').filter({ hasText: task.title }).getByRole('button', { name: 'View evidence', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'App preview', exact: true }).click();
  const iframe = dialog.getByTestId('task-app-preview');
  await expect(iframe).toBeVisible();
  const sandbox = (await iframe.getAttribute('sandbox'))!.split(/\s+/);
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  expect(sandbox).not.toContain('allow-top-navigation');
  const preview = page.frameLocator('iframe[title="Isolated app preview"]');
  await expect(preview.locator('html')).toHaveAttribute('data-preview-ready', 'true');
  await preview.getByRole('button', { name: 'Try preview', exact: true }).click();
  await expect(preview.locator('#count')).toHaveText('1');
  const frame = await (await iframe.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  const isolation = await frame!.evaluate(async () => {
    let parentBlocked = false;
    try { void parent.document.body; } catch { parentBlocked = true; }
    let networkBlocked = false;
    try { await fetch('https://preview-network.invalid/probe'); } catch { networkBlocked = true; }
    return { parentBlocked, networkBlocked, origin: window.origin };
  });
  expect(isolation).toEqual({ parentBlocked: true, networkBlocked: true, origin: 'null' });
  expect(escapedNetworkRequests).toBe(0);
  expect((await state(request)).tasks.find(item => item.id === task.id)?.preview?.source).toBe('sample');
});

test('a recorded checkpoint stays read-only while current mission and task state advance', async ({ page, request }) => {
  const capturedMission = 'Captured mission: make first-run setup reproducible.';
  await act(request, { type: 'set_mission', mission: capturedMission });
  const historyResponse = await request.get(`${apiUrl}/api/history`);
  expect(historyResponse.ok()).toBeTruthy();
  const history = await historyResponse.json() as HistoryResponse;
  const checkpointResponse = await request.get(`${apiUrl}/api/history/${history.entries[0].id}`);
  expect(checkpointResponse.ok()).toBeTruthy();
  const checkpoint = await checkpointResponse.json() as HistoryCheckpoint;
  expect(checkpoint.snapshot.company.mission).toBe(capturedMission);
  const task = checkpoint.snapshot.tasks.find(item => item.id === 'demo-engineering')!;
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Management', exact: true }).getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.locator(`[data-testid="history-entry"][data-history-id="${checkpoint.id}"]`).click();
  await expect(page.getByText('Read-only replay', { exact: true })).toBeVisible();
  await mission(page);
  await expect(page.getByRole('heading', { name: capturedMission, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create task', exact: true })).toBeDisabled();
  await page.locator(`.mission-nodes [data-mission-task="${task.id}"]`).click();
  await expect(page.getByTestId('mission-task-inspector').getByRole('heading', { name: task.title, exact: true })).toBeVisible();
  const currentMission = 'Current mission: prioritize the repository quickstart.';
  await act(request, { type: 'set_mission', mission: currentMission });
  await act(request, { type: 'task_action', taskId: task.id, action: 'dismiss' });
  await expect(page.getByRole('heading', { name: capturedMission, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: currentMission, exact: true })).toHaveCount(0);
  const retainedResponse = await request.get(`${apiUrl}/api/history/${checkpoint.id}`);
  expect(retainedResponse.ok()).toBeTruthy();
  const retained = await retainedResponse.json() as HistoryCheckpoint;
  expect(retained.snapshot).toEqual(checkpoint.snapshot);
  expect((await state(request)).tasks.find(item => item.id === task.id)?.status).toBe('dismissed');
  await page.getByRole('button', { name: 'Return to live', exact: true }).click();
  await expect(page.getByText('Read-only replay', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: currentMission, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create task', exact: true })).toBeEnabled();
});

test('historical workbench previews show captured HTML rather than the current artifact', async ({ page, request }) => {
  const task = (await state(request)).tasks.find(item => ['review', 'done'].includes(item.status) && item.departmentId === 'product')!;
  await act(request, { type: 'set_task_preview', taskId: task.id, html: '<!doctype html><h1>Captured preview version</h1>' });
  const historyResponse = await request.get(`${apiUrl}/api/history`);
  expect(historyResponse.ok()).toBeTruthy();
  const history = await historyResponse.json() as HistoryResponse;
  const checkpointId = history.entries[0].id;
  await act(request, { type: 'set_task_preview', taskId: task.id, html: '<!doctype html><h1>Current preview version</h1>' });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Management', exact: true }).getByRole('button', { name: 'Timeline', exact: true }).click();
  await page.locator(`[data-testid="history-entry"][data-history-id="${checkpointId}"]`).click();
  await expect(page.getByText('Read-only replay', { exact: true })).toBeVisible();
  await mission(page);
  await page.locator(`.mission-nodes [data-mission-task="${task.id}"]`).click();
  await page.getByTestId('mission-task-inspector').getByRole('button', { name: 'Open workbench', exact: true }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'App preview', exact: true }).click();
  const historicalIframe = page.getByRole('dialog').getByTestId('task-app-preview');
  await expect(historicalIframe).toHaveAttribute('src', new RegExp(`checkpoint=${checkpointId}`));
  await expect(page.frameLocator('iframe[title="Isolated app preview"]').getByRole('heading', { name: 'Captured preview version', exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="Isolated app preview"]').getByRole('heading', { name: 'Current preview version', exact: true })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Return to live', exact: true }).click();
  await page.locator(`.mission-nodes [data-mission-task="${task.id}"]`).click();
  await page.getByTestId('mission-task-inspector').getByRole('button', { name: 'Open workbench', exact: true }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'App preview', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Isolated app preview"]').getByRole('heading', { name: 'Current preview version', exact: true })).toBeVisible();
});
