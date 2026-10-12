import type { Agent, Department, Task, TaskStage, WorkspaceState } from '../src/lib/types.ts';

export function inferTaskStage(task: Pick<Task, 'departmentId' | 'title'>, role = ''): TaskStage {
  if (task.departmentId === 'engineering') return /quality|\bqa\b|verify|verification|acceptance|checks|tests/i.test(`${task.title} ${role}`) ? 'verify' : 'build';
  return ({ product: 'idea', design: 'design', marketing: 'launch', sales: 'launch', support: 'support', operations: 'operations' } as const)[task.departmentId];
}

export const departments: Department[] = [
  { id: 'product', name: 'Product', description: 'Decide what to build and why.', color: '#8b7cf8', icon: 'compass' },
  { id: 'design', name: 'Design', description: 'Make the experience clear and useful.', color: '#e3a664', icon: 'sparkles' },
  { id: 'engineering', name: 'Engineering', description: 'Build, inspect, and verify the product.', color: '#6a9ff0', icon: 'code' },
  { id: 'marketing', name: 'Marketing', description: 'Position the product and earn attention.', color: '#e98fba', icon: 'megaphone' },
  { id: 'sales', name: 'Sales', description: 'Turn customer interest into useful conversations.', color: '#bca371', icon: 'handshake' },
  { id: 'support', name: 'Support', description: 'Understand questions and help customers succeed.', color: '#70b9b0', icon: 'life-buoy' },
  { id: 'operations', name: 'Operations', description: 'Keep the company organized and its work traceable.', color: '#93b477', icon: 'settings' },
];

export function seedAgents(): Agent[] {
  return [
    { id: 'agent-product', name: 'Ada', role: 'Product lead', departmentId: 'product', provider: 'claude', enabled: true },
    { id: 'agent-design', name: 'Mira', role: 'Experience designer', departmentId: 'design', provider: 'claude', enabled: true },
    { id: 'agent-engineer', name: 'Eli', role: 'Product engineer', departmentId: 'engineering', provider: 'claude', enabled: true },
    { id: 'agent-marketing', name: 'Olive', role: 'Marketing strategist', departmentId: 'marketing', provider: 'claude', enabled: true },
    { id: 'agent-sales', name: 'Leo', role: 'Sales lead', departmentId: 'sales', provider: 'claude', enabled: true },
    { id: 'agent-qa', name: 'Nora', role: 'Quality engineer', departmentId: 'engineering', provider: 'codex', enabled: true },
    { id: 'agent-campaign', name: 'June', role: 'Campaign writer', departmentId: 'marketing', provider: 'codex', enabled: true },
    { id: 'agent-growth', name: 'Miles', role: 'Growth analyst', departmentId: 'marketing', provider: 'codex', enabled: true },
    { id: 'agent-support', name: 'Tess', role: 'Customer advocate', departmentId: 'support', provider: 'codex', enabled: true },
    { id: 'agent-operations', name: 'Owen', role: 'Operations lead', departmentId: 'operations', provider: 'codex', enabled: true },
  ];
}

export function createState(mode: 'demo' | 'live', now = new Date().toISOString()): WorkspaceState {
  const state: WorkspaceState = {
    schemaVersion: 1, mode,
    company: { name: mode === 'demo' ? 'Northstar Studio' : 'My Company', mission: mode === 'demo' ? 'Help solo developers understand and try our product' : '', missionRevision: 1, repoPath: null },
    departments: structuredClone(departments), agents: seedAgents(), tasks: [], decisions: [], messages: [], activity: [], providers: [],
    config: { paused: false, autoInspect: false, allowProviderRuns: false, cycleSeconds: 60 },
    runtime: { status: 'waiting', lastCycleAt: null, nextCycleAt: null, activeTaskId: null, error: null },
  };
  if (mode === 'live') return state;
  const task = (id: string, title: string, departmentId: Task['departmentId'], agentId: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
    id, title, departmentId, agentId, status, description: 'Sample workflow replay. No repository was inspected and no AI provider was called.', priority: 'medium', source: 'sample', runType: 'sample', missionRevision: 1,
    dependsOn: [], stage: inferTaskStage({ departmentId, title }), requiresDirection: false, evidence: [], artifact: '', createdAt: now, updatedAt: now, ...extra,
  });
  state.tasks = [
    task('demo-positioning', 'Clarify the first-run product promise', 'product', 'agent-product', 'done', { artifact: 'SAMPLE BRIEF\nLead with one benefit: get from a repository to a useful first result. Explain who this helps before listing features.', evidence: [{ id: 'sample-positioning', label: 'Sample positioning brief', detail: 'Illustrative copy written for this replay; not a finding about your product.', kind: 'report', source: 'sample', recordedAt: now }] }),
    task('demo-design', 'Simplify the onboarding preview', 'design', 'agent-design', 'done', { dependsOn: ['demo-positioning'], artifact: 'SAMPLE DESIGN HANDOFF\nOne clear promise, a short checklist, and a visible first-result preview. This is an illustrative accepted design, not a recorded design review.' }),
    task('demo-engineering', 'Finish the first-run integration', 'engineering', 'agent-engineer', 'running', { priority: 'high', dependsOn: ['demo-design'], preview: { source: 'sample', updatedAt: now, html: '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sample first-run preview</title><style>body{font:16px/1.6 system-ui;background:#f7f6f0;color:#243e35;padding:32px;max-width:600px;margin:auto}aside{background:#f4e3bf;padding:12px;border-radius:8px}button{background:#386954;color:white;border:0;border-radius:8px;padding:12px 20px;font:inherit}li{margin:12px 0}</style><aside>Sample HTML preview · illustrative only. No provider ran and no repository result is claimed.</aside><h1>Try one useful first result.</h1><p>A short checklist turns a new repository into a clear next step.</p><ol><li>Choose your project</li><li>Understand its setup</li><li>Review the first result</li></ol><button id="demo">Show sample result</button><p id="result" role="status">Ready for an illustrative walkthrough.</p><script>document.getElementById("demo").onclick=()=>document.getElementById("result").textContent="Sample result shown. This preview does not connect to a backend."</script></html>' } }),
    task('demo-qa', 'Review the first-run acceptance checks', 'engineering', 'agent-qa', 'waiting', { dependsOn: ['demo-engineering'], priority: 'high' }),
    task('demo-channel', 'Write the launch-channel plan', 'marketing', 'agent-marketing', 'waiting', { requiresDirection: true, priority: 'high', dependsOn: ['demo-positioning'] }),
    task('demo-email', 'Draft the launch email', 'marketing', 'agent-campaign', 'waiting', { requiresDirection: true, dependsOn: ['demo-qa', 'demo-channel'] }),
    task('demo-social', 'Draft a short product demo campaign', 'marketing', 'agent-growth', 'waiting', { requiresDirection: true, dependsOn: ['demo-qa', 'demo-channel'] }),
    task('demo-marketing-audit', 'Check the sample campaign measurement plan', 'marketing', 'agent-growth', 'proposed', { artifact: 'SAMPLE MEASUREMENT PLAN\nTrack qualified demo visits and first-run completion. These are proposed metrics, not measured results.' }),
    task('demo-sales', 'Prepare a founder-led customer conversation', 'sales', 'agent-sales', 'waiting', { dependsOn: ['demo-qa'] }),
    task('demo-support', 'Organize the sample onboarding FAQ', 'support', 'agent-support', 'queued'),
    task('demo-operations', 'Review the sample weekly operating checklist', 'operations', 'agent-operations', 'review', { artifact: 'SAMPLE CHECKLIST\nReview open founder decisions, accepted deliverables, and overdue customer questions.' }),
  ];
  state.decisions = [{ id: 'demo-launch-channel', title: 'Which launch channel should Marketing focus on?', context: 'Sample direction request: the campaign team needs one shared channel choice before drafting. Email and social deliverables also wait for QA acceptance.', departmentId: 'marketing', options: [
    { id: 'community', label: 'Developer communities', description: 'A useful demo and founder-led discussion.' },
    { id: 'email', label: 'A small email launch', description: 'Start with people who already asked to hear more.' },
    { id: 'content', label: 'A technical walkthrough', description: 'Explain one concrete workflow in a public article.' },
  ], recommendationId: 'community', taskIds: ['demo-channel', 'demo-email', 'demo-social'], status: 'open', answer: null, source: 'sample', createdAt: now, answeredAt: null }];
  state.messages = [{ id: 'demo-message', author: 'Workspace', role: 'system', text: 'This is a sample company replay. Decisions and deliverables here are illustrative; no agents are running.', taskId: null, source: 'sample', createdAt: now }];
  state.activity = [{ id: 'demo-activity', title: 'Sample team loaded', detail: '10 example roles across seven departments. Marketing is waiting for a shared launch direction.', departmentId: null, source: 'sample', createdAt: now }];
  state.runtime.status = 'working';
  state.runtime.activeTaskId = 'demo-engineering';
  return state;
}
