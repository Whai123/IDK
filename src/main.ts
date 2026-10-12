import './styles.css';
import type { ActionResponse, Agent, DepartmentId, HistoryCheckpoint, HistoryResponse, Priority, ProviderId, Task, TaskFileResponse, TaskFilesResponse, WorkspaceAction, WorkspaceState } from './lib/types';
import type { OfficeSelection } from './office-scene';
import { decisionImpact, describeHandoff, inferTaskStage, renderMissionMap } from './mission-map';

const app = document.querySelector<HTMLDivElement>('#app')!;
type View = 'overview' | 'mission' | 'timeline' | 'office' | 'department' | 'team' | 'settings';
type Modal = { kind: 'task' | 'agent'; id: string } | { kind: 'mission' | 'conversation' | 'add-agent' | 'create-task' };
let state: WorkspaceState | null = null;
let liveState: WorkspaceState | null = null;
let checkpoint: HistoryCheckpoint | null = null;
let history: HistoryResponse | null = null;
let historyLoading = false;
let historyError = '';
let historyLoadingId: string | null = null;
let historyRequest = 0;
let selectedMissionTask: string | null = null;
type WorkbenchTab = 'document' | 'evidence' | 'files' | 'checks' | 'preview';
let workbenchTab: WorkbenchTab = 'document';
const fileInventories = new Map<string, { response?: TaskFilesResponse; loading: boolean; error?: string }>();
const fileContents = new Map<string, { response?: TaskFileResponse; loading: boolean; error?: string }>();
let selectedFilePath: string | null = null;
let filePreview: { taskKey: string; path: string; html: string } | null = null;
let view: View = 'overview';
let department: DepartmentId = 'marketing';
let modal: Modal | null = null;
let navOpen = false;
let busy = false;
let connection: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
let loadError = '';
let notice: { text: string; error: boolean } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let returnFocusId = '';
const drafts: Record<string, string> = {};
const expanded = new Set<string>();
let officeHost: HTMLDivElement | null = null;
type OfficeModule = typeof import('./office-scene');
let officeController: ReturnType<OfficeModule['createOfficeScene']> | null = null;
let officeModule: Promise<OfficeModule> | null = null;
let officeGeneration = 0;
let officeInitialized = false;
let officeMotion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let officeSelection: OfficeSelection | null = null;
let selectedAgentIdentity: { name: string; departmentId: DepartmentId; role: string } | null = null;

const icons: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/><path d="m12 12 8-8m-1-1h3v3"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>',
  pen: '<path d="m15 5 4 4M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15z"/>',
  megaphone: '<path d="m3 10 13-5v14L3 14zM16 9h3a3 3 0 0 1 0 6h-3M6 15l2 6h4l-2-5M21 3l-2 2m2 16-2-2"/>',
  chart: '<path d="M4 3v18h17M8 15l4-5 4 2 5-7"/>',
  support: '<path d="M4 13v-1a8 8 0 0 1 16 0v1M4 12H2v7h4v-7zm16 0h2v7h-4v-7zM20 19c0 3-3 3-6 3"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-18a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v3"/>',
  settings: '<path d="m10 3-1 3-3 1-3 3 3 2-1 4 4 1 2 4 3-2 4 1 1-4 3-2-2-3-1-3-4 1z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H3l2-5a9 9 0 1 1 16-4z"/><path d="M8 10h8M8 14h5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 1 7M20 3v6h-6"/>',
  alert: '<path d="M12 8v5m0 4h.01M10 3 2 18a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 3a2.3 2.3 0 0 0-4 0z"/>',
  file: '<path d="M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M18 8a8 8 0 0 1-8 8H6"/>',
  link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  send: '<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
const deptIcon: Record<DepartmentId, string> = { product: 'target', design: 'pen', engineering: 'code', marketing: 'megaphone', sales: 'chart', support: 'support', operations: 'layers' };
const statusLabels: Record<Task['status'], string> = { proposed: 'Proposed', queued: 'Queued', running: 'In progress', waiting: 'Waiting', review: 'Ready for review', done: 'Accepted', paused: 'Paused', dismissed: 'Dismissed', failed: 'Needs attention' };
const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name: string, className = ''): string => `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.grid}</svg>`;
const value = (id: string, fallback: string): string => esc(checkpoint ? fallback : drafts[id] ?? fallback);
const replaying = (): boolean => checkpoint !== null || historyLoadingId !== null;
const disabled = (): string => busy || replaying() ? ' disabled' : '';
const sampleBadge = (sample: boolean): string => sample ? '<span class="badge badge-sample">Sample</span>' : '';
const departmentName = (id: DepartmentId): string => state?.departments.find(d => d.id === id)?.name ?? id;
const providerName = (id: ProviderId): string => id === 'claude' ? 'Claude Code' : 'Codex';
const agentFor = (task: Task): Agent | undefined => state?.agents.find(a => a.id === task.agentId);
const sourceName = (task: Task): string => task.source === 'sample' ? 'Sample scenario' : task.runType === 'audit' ? 'Repository audit' : task.source === 'founder' ? 'Founder request' : 'Repository signal';
const shortTime = (date: string | null): string => {
  if (!date || Number.isNaN(Date.parse(date))) return 'Not yet';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));
};
const matchingTasks = (): Task[] => state!.tasks.filter(t => view !== 'department' || t.departmentId === department);
const button = (label: string, action: string, className = 'button button-secondary', glyph?: string): string => `<button type="button" class="${className}" data-action="${action}"${disabled()}>${glyph ? icon(glyph) : ''}${label}</button>`;

function toast(text: string, error = false): void {
  notice = { text, error };
  clearTimeout(noticeTimer);
  render();
  noticeTimer = setTimeout(() => { notice = null; app.querySelector('.toast')?.remove(); }, error ? 10000 : 6000);
}

function assertState(candidate: unknown): WorkspaceState {
  const s = candidate as WorkspaceState;
  if (!s || s.schemaVersion !== 1 || !s.company || !Array.isArray(s.tasks) || !Array.isArray(s.agents) || !Array.isArray(s.departments) || !s.config || !s.runtime) throw new Error('The server returned an unsupported workspace.');
  return s;
}

async function requestAction(action: WorkspaceAction, clearDrafts: string[] = []): Promise<void> {
  if (busy) return;
  if (replaying()) { toast('Return to live before changing the workspace.', true); return; }
  busy = true;
  render();
  try {
    const response = await fetch('/api/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const payload = await response.json() as ActionResponse & { error?: string; message?: string };
    if (!response.ok) throw new Error(payload.error ?? payload.message ?? 'The action could not be completed.');
    liveState = assertState(payload.state);
    if (!checkpoint) state = liveState;
    clearDrafts.forEach(id => delete drafts[id]);
    if ((action.type === 'set_mission' && modal?.kind === 'mission') || action.type === 'update_agent' || action.type === 'add_agent' || action.type === 'create_task') modal = null;
    if (payload.notice) notice = { text: payload.notice, error: false };
    busy = false;
    render();
    if (history || view === 'timeline') void loadHistory();
  } catch (error) {
    busy = false;
    toast(error instanceof Error ? error.message : 'Could not reach the workspace server.', true);
  }
}

async function load(): Promise<void> {
  loadError = '';
  render();
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('The workspace server is unavailable. Please try again.');
    liveState = assertState(await response.json());
    if (!checkpoint) state = liveState;
    render();
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'Could not load the workspace.';
    render();
  }
}

function providerStatus(id: ProviderId): { label: string; className: string; detail: string } {
  const provider = state!.providers.find(p => p.id === id);
  if (!provider) return { label: 'Not checked', className: 'neutral', detail: 'Provider status has not been detected.' };
  if (!provider.installed) return { label: 'Not installed', className: 'neutral', detail: provider.detail };
  if (provider.authenticated === true) return { label: 'Signed in', className: 'green', detail: provider.detail };
  return { label: provider.authenticated === false ? 'Sign-in needed' : 'Sign-in not verified', className: 'amber', detail: provider.detail };
}

function sidebar(): string {
  const active = (name: View): string => view === name ? ' active' : '';
  return `<aside class="sidebar ${navOpen ? 'is-open' : ''}" aria-label="Workspace navigation" data-scroll="navigation" ${matchMedia('(max-width: 800px)').matches && !navOpen ? 'inert' : ''}>
    <a class="brand" href="#" data-action="go-overview" aria-label="Startup Workspace home"><span class="brand-symbol">${icon('layers')}</span><span>Startup<span class="brand-sub">WORKSPACE</span></span></a>
    <div class="sidebar-label">YOUR COMPANY</div>
    <nav class="primary-nav" aria-label="Company">
      <button id="nav-overview" class="nav-item${active('overview')}" data-view="overview">${icon('grid')}<span>Overview</span><span class="nav-count">${state!.decisions.filter(d => d.status === 'open').length}</span></button>
      <button id="nav-mission" class="nav-item${active('mission')}" data-view="mission" aria-label="Mission">${icon('branch')}<span>Mission</span><span class="office-nav-badge">MAP</span></button>
      <button id="nav-office" class="nav-item office-nav${active('office')}" data-view="office" aria-label="3D Office">${icon('layers')}<span>3D Office</span><span class="office-nav-badge">3D</span></button>
    </nav>
    <div class="sidebar-label department-label">DEPARTMENTS <span>${state!.departments.length}</span></div>
    <nav class="department-nav" aria-label="Departments">
      ${state!.departments.map(d => `<button id="nav-${esc(d.id)}" class="nav-item dept-${esc(d.id)}${view === 'department' && department === d.id ? ' active' : ''}" data-department="${esc(d.id)}"><span class="department-icon">${icon(deptIcon[d.id])}</span><span>${esc(d.name)}</span><span class="nav-count">${state!.tasks.filter(t => t.departmentId === d.id && ['running','queued','waiting','review'].includes(t.status)).length}</span></button>`).join('')}
    </nav>
    <div class="sidebar-rule"></div>
    <nav class="primary-nav" aria-label="Management">
      <button id="nav-timeline" class="nav-item${active('timeline')}" data-view="timeline" aria-label="Timeline">${icon('clock')}<span>Timeline</span></button>
      <button id="nav-team" class="nav-item${active('team')}" data-view="team">${icon('people')}<span>Team</span><span class="nav-count">${state!.agents.length}</span></button>
      <button id="nav-settings" class="nav-item${active('settings')}" data-view="settings">${icon('settings')}<span>Settings</span></button>
    </nav>
    <div class="sidebar-bottom">
      <div class="sidebar-runtime"><span class="status-dot ${state!.config.paused ? 'amber' : 'green'}"></span><div><strong>${state!.config.paused ? 'Team is paused' : state!.mode === 'demo' ? 'Sample workspace' : 'Local workspace'}</strong><span>${state!.mode === 'demo' ? 'Explore with sample data' : state!.company.repoPath ? esc(state!.company.repoPath) : 'Connect your repository'}</span></div></div>
      <div class="founder-profile"><span class="avatar founder-avatar">F</span><div><strong>You</strong><span>Founder · workspace owner</span></div>${icon('chevron')}</div>
    </div>
  </aside>`;
}

function topbar(): string {
  const current = view === 'department' ? departmentName(department) : view === 'team' ? 'Your team' : view === 'settings' ? 'Settings' : view === 'office' ? '3D Office' : view === 'mission' ? 'Mission' : view === 'timeline' ? 'Timeline' : 'Company overview';
  return `<header class="topbar">
    <div class="breadcrumb"><button id="mobile-nav" class="icon-button mobile-menu" data-action="toggle-nav" aria-label="${navOpen ? 'Close navigation' : 'Open navigation'}" aria-expanded="${navOpen}">${icon('menu')}</button><span class="breadcrumb-company">${esc(state!.company.name)}</span>${icon('chevron')}<span>${esc(current)}</span></div>
    <div class="topbar-actions"><span class="connection-status" title="Live workspace updates"><span class="status-dot ${connection === 'connected' ? 'green' : 'amber'}"></span>${connection === 'connected' ? 'Connected' : connection === 'reconnecting' ? 'Reconnecting' : 'Connecting'}</span><button id="talk-team" class="button button-quiet" data-action="open-chat">${icon('chat')}<span>Talk to team</span></button><span class="avatar small-avatar">F</span></div>
  </header>`;
}

function pageHeading(title: string, subtitle: string): string {
  return `<div class="page-heading"><div><div class="eyebrow">FOUNDER WORKSPACE</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="mode-switch" role="group" aria-label="Workspace mode"><button data-mode="demo" class="${state!.mode === 'demo' ? 'selected' : ''}" aria-pressed="${state!.mode === 'demo'}"${disabled()}>Sample</button><button data-mode="live" class="${state!.mode === 'live' ? 'selected' : ''}" aria-pressed="${state!.mode === 'live'}"${disabled()}>Live</button></div></div>`;
}

function missionCard(): string {
  const open = state!.decisions.filter(d => d.status === 'open').length;
  const moving = state!.tasks.filter(t => ['running', 'queued'].includes(t.status)).length;
  const delivered = state!.tasks.filter(t => ['review', 'done'].includes(t.status)).length;
  return `<section class="mission-card" aria-label="Company mission"><div class="mission-top"><span class="mission-icon">${icon('target')}</span><div class="mission-copy"><div class="mission-eyebrow">THE MISSION <span class="revision">REV ${state!.company.missionRevision}</span></div><h2>${esc(state!.company.mission)}</h2></div><button id="edit-mission" class="button button-quiet mission-edit" data-action="edit-mission" aria-label="Edit mission">${icon('pen')}<span>Edit mission</span></button></div><div class="mission-bottom"><div class="mission-stats"><div><strong>${open}</strong><span>Need direction</span></div><div><strong>${moving}</strong><span>In motion</span></div><div><strong>${delivered}</strong><span>Delivered</span></div><div><strong>${state!.agents.filter(a => a.enabled).length}</strong><span>Team members</span></div></div><div class="mission-runtime"><span class="status-dot ${state!.config.paused ? 'amber' : 'green'}"></span><span>${state!.config.paused ? 'Paused' : esc(state!.runtime.status)}</span><button id="pause-team" class="button button-small button-secondary" data-action="toggle-pause"${disabled()}>${icon(state!.config.paused ? 'play' : 'pause')}${state!.config.paused ? 'Resume team' : 'Pause team'}</button></div></div></section>`;
}

function sampleBanner(): string {
  if (state!.mode === 'demo') return `<div class="mode-banner sample-banner"><div>${icon('spark')}<span><strong>Sample workspace</strong> <span class="banner-detail">Explore the full startup team. Activity and findings below are illustrative.</span></span></div><div class="banner-actions">${button('Play sample step', 'sample-step', 'button button-small button-quiet', 'play')}${button('Replay sample', 'reset-demo', 'button button-small button-quiet', 'refresh')}</div></div>`;
  return `<div class="mode-banner live-banner"><div>${icon('branch')}<span><strong>Live workspace</strong> <span class="banner-detail">${state!.company.repoPath ? esc(state!.company.repoPath) : 'Connect a local repository in Settings to begin.'}</span></span></div>${state!.company.repoPath ? button('Inspect repository', 'inspect-repo', 'button button-small button-secondary', 'search') : button('Connect repository', 'go-settings', 'button button-small button-secondary', 'link')}</div>`;
}

function panelHead(title: string, glyph: string, count: number, tone: string, subtitle?: string): string {
  return `<div class="panel-heading"><div class="panel-heading-main"><span class="panel-icon ${tone}">${icon(glyph)}</span><h2>${title}</h2><span class="count-pill">${count}</span></div>${subtitle ? `<p>${subtitle}</p>` : ''}</div>`;
}

function empty(title: string, detail: string, glyph = 'check'): string {
  return `<div class="empty-state"><span class="empty-icon">${icon(glyph)}</span><strong>${title}</strong><p>${detail}</p></div>`;
}

function decisionPanel(): string {
  const decisions = state!.decisions.filter(d => d.status === 'open' && (view !== 'department' || d.departmentId === department));
  return `<section class="panel direction-panel">${panelHead('Needs your direction', 'alert', decisions.length, 'amber')}<div class="panel-body">${decisions.length ? decisions.map(d => {
    const recommended = d.options.find(o => o.id === d.recommendationId);
    const draftId = `direction-${d.id}`;
    return `<article class="decision-card" data-testid="decision-card" data-decision-id="${esc(d.id)}"><div class="card-eyebrow"><span class="department-tag dept-${esc(d.departmentId)}">${esc(departmentName(d.departmentId))}</span>${sampleBadge(d.source === 'sample')}</div><h3>${esc(d.title)}</h3><p class="decision-context">${esc(d.context)}</p><div class="decision-options">${d.options.map(o => `<button class="decision-option ${o.id === d.recommendationId ? 'recommended' : ''}" data-decision="${esc(d.id)}" data-option="${esc(o.id)}"${disabled()}><span class="option-circle">${o.id === d.recommendationId ? icon('check') : ''}</span><span><span class="option-label">${esc(o.label)}${o.id === d.recommendationId ? '<span class="recommended-label">Recommended</span>' : ''}</span><span class="option-description">${esc(o.description)}</span></span>${icon('arrow')}</button>`).join('')}</div>${recommended ? `<div class="recommendation-note">${icon('spark')}<span>The team recommends <strong>${esc(recommended.label)}</strong>.</span></div>` : ''}${renderDecisionImpact(d)}<details id="custom-${esc(d.id)}" data-remember${expanded.has(`custom-${d.id}`) ? ' open' : ''}><summary>Give different direction ${icon('down')}</summary><form data-form="decision" data-id="${esc(d.id)}"><label for="${esc(draftId)}">Your direction</label><textarea id="${esc(draftId)}" data-draft="${esc(draftId)}" rows="3" required placeholder="What should the team do instead?">${value(draftId, '')}</textarea><button class="button button-primary button-small" type="submit"${disabled()}>Send direction ${icon('arrow')}</button></form></details></article>`;
  }).join('') : empty('Nothing is blocked on you', 'The team will bring you decisions when founder direction is needed.')}</div></section>`;
}

function taskMeta(task: Task): string {
  const agent = agentFor(task);
  return `<div class="task-meta"><span>${esc(agent?.name ?? 'Unassigned')}</span>${agent ? `<span class="meta-dot">·</span><span>${esc(providerName(agent.provider))}</span>` : ''}<span class="meta-dot">·</span><span>${esc(sourceName(task))}</span></div>`;
}

function activePanel(): string {
  const tasks = matchingTasks().filter(t => ['running', 'queued', 'waiting', 'paused', 'failed'].includes(t.status));
  return `<section class="panel active-panel">${panelHead('In motion', 'clock', tasks.length, 'blue')}<div class="panel-body">${tasks.length ? `<div class="task-list">${tasks.map(t => `<button class="task-row" data-open-task="${esc(t.id)}" data-testid="task-card" data-task-id="${esc(t.id)}"><span class="task-row-icon dept-${esc(t.departmentId)}">${icon(deptIcon[t.departmentId])}</span><span class="task-row-copy"><span class="task-title">${esc(t.title)}</span>${taskMeta(t)}<span class="task-run-label">${t.runType === 'sample' ? 'Sample activity' : t.runType === 'audit' ? 'Local audit' : 'Native provider run'}${t.workspacePath ? ' · isolated workspace' : ''}</span></span><span class="task-row-end"><span class="status-label status-${esc(t.status)}"><span class="status-dot"></span>${statusLabels[t.status]}</span>${icon('chevron')}</span></button>`).join('')}</div><div class="panel-footnote">${icon('branch')}Independent work can continue while decisions wait.</div>` : empty('Ready for the next move', 'Start a proposed task or inspect your connected repository.', 'clock')}</div></section>`;
}

function deliveredPanel(): string {
  const tasks = matchingTasks().filter(t => ['review', 'done'].includes(t.status));
  return `<section class="panel delivered-panel">${panelHead('Delivered with evidence', 'check', tasks.length, 'green')}<div class="panel-body">${tasks.length ? tasks.map(t => `<article class="delivery-card" data-testid="task-card" data-task-id="${esc(t.id)}"><div class="card-eyebrow"><span class="department-tag dept-${esc(t.departmentId)}">${esc(departmentName(t.departmentId))}</span>${sampleBadge(t.source === 'sample')}<span class="delivery-status">${t.status === 'done' ? 'Accepted' : 'Ready for review'}</span></div><h3>${esc(t.title)}</h3><p>${esc(t.description)}</p><div class="evidence-preview">${t.evidence.slice(0, 2).map(e => `<div class="evidence-chip">${icon(e.kind === 'command' ? 'code' : e.kind === 'diff' ? 'branch' : 'file')}<span><strong>${esc(e.label)}</strong><span>${e.source === 'sample' ? 'Sample evidence' : e.source === 'observed' ? 'Observed locally' : 'Agent-reported'}</span></span></div>`).join('') || '<span class="muted">No supporting evidence attached yet.</span>'}</div><button class="button button-full button-secondary" data-open-task="${esc(t.id)}">View evidence ${icon('arrow')}</button></article>`).join('') : empty('Results will land here', 'Completed work includes its artifacts, source, and supporting evidence.', 'file')}</div></section>`;
}

function proposalPanel(): string {
  const tasks = matchingTasks().filter(t => t.status === 'proposed');
  return `<section class="panel proposal-panel">${panelHead('Proposed next', 'spark', tasks.length, 'purple')}<div class="panel-body">${tasks.length ? tasks.map(t => `<article class="proposal-card" data-testid="task-card" data-task-id="${esc(t.id)}"><div class="card-eyebrow"><span class="department-tag dept-${esc(t.departmentId)}">${esc(departmentName(t.departmentId))}</span>${sampleBadge(t.source === 'sample')}<span class="priority priority-${esc(t.priority)}">${esc(t.priority)} priority</span></div><button class="proposal-title" data-open-task="${esc(t.id)}"><h3>${esc(t.title)}</h3>${icon('chevron')}</button><p>${esc(t.description)}</p>${taskMeta(t)}<div class="proposal-actions"><button class="button button-small button-purple" data-task-action="start" data-task-id="${esc(t.id)}"${disabled()}>${icon('play')}Start task</button><button class="button button-small button-quiet" data-task-action="dismiss" data-task-id="${esc(t.id)}"${disabled()}>Dismiss proposal</button></div></article>`).join('') : empty('No proposals right now', 'New ideas appear here before they become assigned work.', 'spark')}</div></section>`;
}

function dependencyPanel(): string {
  const tasks = matchingTasks().filter(t => t.dependsOn.length > 0 && t.status !== 'dismissed');
  return `<section class="panel dependency-panel">${panelHead('Across the team', 'branch', tasks.length, 'neutral', 'Dependencies keep departments working toward the same outcome.')}<div class="panel-body">${tasks.length ? `<div class="dependency-list">${tasks.map(t => `<div class="dependency-row"><button class="dependency-task" data-open-task="${esc(t.id)}"><span class="department-tag dept-${esc(t.departmentId)}">${esc(departmentName(t.departmentId))}</span><strong>${esc(t.title)}</strong></button><span class="dependency-connector">${icon('arrow')} depends on</span><div class="dependency-sources">${t.dependsOn.map(id => { const dependency = state!.tasks.find(p => p.id === id); return dependency ? `<button class="dependency-chip" data-open-task="${esc(id)}">${icon(dependency.status === 'done' ? 'check' : 'clock')}${esc(dependency.title)}</button>` : '<span class="muted">Unavailable task</span>'; }).join('')}</div></div>`).join('')}</div>` : empty('No dependencies yet', 'Shared work will show which deliverables another department needs.', 'branch')}</div></section>`;
}

function activityPanel(): string {
  const activity = state!.activity.filter(a => view !== 'department' || a.departmentId === department).slice(0, 5);
  return `<section class="activity-section"><div class="section-heading"><h2>Workspace activity</h2><span>Last cycle · ${shortTime(state!.runtime.lastCycleAt)}</span></div>${activity.length ? `<div class="activity-list">${activity.map(a => `<div class="activity-item"><span class="activity-marker">${icon(a.departmentId ? deptIcon[a.departmentId] : 'spark')}</span><div><strong>${esc(a.title)} ${sampleBadge(a.source === 'sample')}</strong><p>${esc(a.detail)}</p></div><time datetime="${esc(a.createdAt)}">${shortTime(a.createdAt)}</time></div>`).join('')}</div>` : '<p class="muted activity-empty">No activity yet. Workspace actions will be recorded here.</p>'}</section>`;
}

function departmentIntro(): string {
  if (view !== 'department') return '';
  const d = state!.departments.find(item => item.id === department)!;
  const agents = state!.agents.filter(a => a.departmentId === department);
  const loops: Record<DepartmentId, string> = {
    product: 'Turn feedback into clear priorities, acceptance criteria, and decisions.',
    design: 'Translate direction into user flows, interfaces, and accessibility reviews.',
    engineering: 'Move from a technical plan to implementation, checks, and a reviewable diff.',
    marketing: 'Signals → evidence → campaign proposal → founder approval → measured results.',
    sales: 'Understand the audience, prepare qualification questions, and draft useful proposals.',
    support: 'Capture friction, draft helpful answers, and send recurring issues back to product.',
    operations: 'Keep setup, releases, costs, and team routines understandable and repeatable.',
  };
  return `<section class="department-intro dept-${esc(department)}"><span class="department-intro-icon">${icon(deptIcon[department])}</span><div><h2>${esc(d.name)}</h2><p>${esc(d.description)}</p><span class="department-loop">${loops[department]}</span></div><div class="department-members">${agents.map(a => `<span class="avatar" title="${esc(a.name)}">${esc(a.name.trim().split(/\s+/).map(n => n[0]).slice(0, 2).join(''))}</span>`).join('')}<span>${agents.length} ${agents.length === 1 ? 'teammate' : 'teammates'}</span></div></section>${department === 'marketing' ? '<div class="department-note">' + icon('megaphone') + '<span>Campaigns stay as proposals and drafts. Publishing, outreach, and spending need founder approval. Performance claims require connected data.</span></div>' : ''}`;
}

function overview(): string {
  return `${pageHeading(view === 'department' ? departmentName(department) : 'Good work starts with direction.', view === 'department' ? 'One department. Shared context. Tangible outcomes.' : 'Your startup team, decisions, and deliverables in one place.')}${sampleBanner()}${missionCard()}${departmentIntro()}${state!.runtime.error ? `<div class="inline-error" role="alert">${icon('alert')}${esc(state!.runtime.error)}</div>` : ''}<div class="workspace-grid">${decisionPanel()}${activePanel()}${deliveredPanel()}${proposalPanel()}</div>${dependencyPanel()}${activityPanel()}<button class="founder-prompt" data-action="open-chat">${icon('chat')}<span>Give the team direction…</span><span class="prompt-shortcut">Open conversation</span><span class="prompt-send">${icon('send')}</span></button>`;
}

function agentStatus(agent: Agent): string {
  if (!agent.enabled) return 'Disabled';
  if (state!.config.paused) return 'Paused';
  const tasks = state!.tasks.filter(t => t.agentId === agent.id);
  if (tasks.some(t => t.status === 'running')) return state!.mode === 'demo' ? 'Sample · In progress' : 'In progress';
  if (tasks.some(t => t.status === 'failed')) return 'Needs attention';
  if (tasks.some(t => t.status === 'waiting' && t.requiresDirection)) return 'Needs direction';
  if (tasks.some(t => t.status === 'waiting')) return 'Waiting on dependencies';
  if (tasks.some(t => t.status === 'review')) return 'Ready for review';
  if (tasks.some(t => t.status === 'paused')) return 'Paused';
  if (tasks.some(t => t.status === 'queued')) return 'Queued';
  return 'Available';
}

function reconcileOfficeSelection(): void {
  if (!officeSelection || !state) return;
  if (officeSelection.kind === 'agent') {
    let agent = state.agents.find(a => a.id === officeSelection!.id);
    if (!agent && selectedAgentIdentity) {
      const identity = selectedAgentIdentity;
      agent = state.agents.find(a => a.name === identity.name && a.departmentId === identity.departmentId && a.role === identity.role);
    }
    if (agent) {
      officeSelection = { kind: 'agent', id: agent.id };
      selectedAgentIdentity = { name: agent.name, role: agent.role, departmentId: agent.departmentId };
    } else { officeSelection = null; selectedAgentIdentity = null; }
  } else if (officeSelection.kind === 'task' && !state.tasks.some(t => t.id === officeSelection!.id)) officeSelection = null;
  else if (officeSelection.kind === 'department' && !state.departments.some(d => d.id === officeSelection!.id)) officeSelection = null;
}

function selectOfficeItem(selection: OfficeSelection, focusInspector = false): void {
  officeSelection = selection;
  selectedAgentIdentity = null;
  if (selection.kind === 'agent') {
    const agent = state!.agents.find(a => a.id === selection.id);
    if (agent) selectedAgentIdentity = { name: agent.name, role: agent.role, departmentId: agent.departmentId };
  }
  officeController?.focus(selection);
  if (selection.kind === 'task') openModal({ kind: 'task', id: selection.id });
  else {
    render();
    if (focusInspector) document.getElementById('office-selected-title')?.focus();
  }
}

function officeTaskList(tasks: Task[]): string {
  return tasks.length ? `<div class="office-inspector-tasks">${tasks.map(t => `<button id="office-task-${esc(t.id)}" class="office-inspector-task" data-office-task="${esc(t.id)}" aria-label="Inspect task: ${esc(t.title)}"><span><strong>${esc(t.title)}</strong><span>${statusLabels[t.status]} · ${esc(sourceName(t))}</span></span>${icon('chevron')}</button>`).join('')}</div>` : '<p class="office-inspector-empty">No assigned work yet.</p>';
}

function officeInspector(): string {
  let content = '';
  if (officeSelection?.kind === 'agent') {
    const agent = state!.agents.find(a => a.id === officeSelection!.id)!;
    const provider = providerStatus(agent.provider);
    const tasks = state!.tasks.filter(t => t.agentId === agent.id && t.status !== 'dismissed');
    content = `<div class="office-inspector-heading"><span class="agent-avatar dept-${esc(agent.departmentId)}">${icon(deptIcon[agent.departmentId])}</span><span class="office-inspector-type">TEAMMATE</span></div><h3>${esc(agent.name)}</h3><span class="department-tag dept-${esc(agent.departmentId)}">${esc(departmentName(agent.departmentId))}</span><p class="office-inspector-description">${esc(agent.role)}</p><dl class="office-facts"><div><dt>Work status</dt><dd>${esc(agentStatus(agent))}</dd></div><div><dt>Provider</dt><dd>${providerName(agent.provider)}</dd></div><div><dt>Host sign-in</dt><dd><span class="status-dot ${provider.className}"></span>${esc(provider.label)}</dd></div><div><dt>Role enabled</dt><dd>${agent.enabled ? 'Yes' : 'No'}</dd></div></dl><div class="office-inspector-section"><h4>Assigned work <span>${tasks.length}</span></h4>${officeTaskList(tasks)}</div><button class="button button-secondary button-full" data-edit-agent="${esc(agent.id)}">${icon('settings')}Edit teammate</button>`;
  } else if (officeSelection?.kind === 'department') {
    const d = state!.departments.find(d => d.id === officeSelection!.id)!;
    const agents = state!.agents.filter(a => a.departmentId === d.id);
    const tasks = state!.tasks.filter(t => t.departmentId === d.id && t.status !== 'dismissed');
    const decisions = state!.decisions.filter(item => item.departmentId === d.id && item.status === 'open');
    content = `<div class="office-inspector-heading"><span class="agent-avatar dept-${esc(d.id)}">${icon(deptIcon[d.id])}</span><span class="office-inspector-type">DEPARTMENT</span></div><h3>${esc(d.name)}</h3><p class="office-inspector-description">${esc(d.description)}</p><dl class="office-facts"><div><dt>Teammates</dt><dd>${agents.length}</dd></div><div><dt>Open tasks</dt><dd>${tasks.filter(t => !['done', 'dismissed'].includes(t.status)).length}</dd></div><div><dt>Founder decisions</dt><dd>${decisions.length}</dd></div></dl><div class="office-inspector-section"><h4>The team</h4><div class="office-member-chips">${agents.map(a => `<button data-office-agent="${esc(a.id)}">${esc(a.name)} ${icon('arrow')}</button>`).join('') || '<p class="office-inspector-empty">No teammates in this department.</p>'}</div></div><div class="office-inspector-section"><h4>Department work</h4>${officeTaskList(tasks)}</div><button class="button button-primary button-full" data-department="${esc(d.id)}">Open ${esc(d.name)} ${icon('arrow')}</button>`;
  } else if (officeSelection?.kind === 'task') {
    const task = state!.tasks.find(t => t.id === officeSelection!.id)!;
    const agent = agentFor(task);
    content = `<div class="office-inspector-heading"><span class="agent-avatar dept-${esc(task.departmentId)}">${icon('file')}</span><span class="office-inspector-type">TASK</span>${sampleBadge(task.source === 'sample')}</div><h3>${esc(task.title)}</h3><p class="office-inspector-description">${esc(task.description)}</p><dl class="office-facts"><div><dt>Status</dt><dd>${statusLabels[task.status]}</dd></div><div><dt>Owner</dt><dd>${esc(agent?.name ?? 'Unassigned')}</dd></div><div><dt>Provider</dt><dd>${agent ? providerName(agent.provider) : 'Unassigned'}</dd></div><div><dt>Source</dt><dd>${esc(sourceName(task))}</dd></div><div><dt>Evidence</dt><dd>${task.evidence.length} attached</dd></div></dl><div class="office-inspector-section"><h4>Supporting evidence</h4>${task.evidence.length ? `<ul class="office-evidence-list">${task.evidence.map(e => `<li>${icon('file')}<span>${esc(e.label)}<small>${e.source === 'sample' ? 'Sample' : e.source === 'observed' ? 'Observed locally' : 'Agent-reported'}</small></span></li>`).join('')}</ul>` : '<p class="office-inspector-empty">No evidence attached yet.</p>'}</div><button class="button button-primary button-full" data-open-task="${esc(task.id)}">View task evidence ${icon('arrow')}</button>`;
  } else {
    const decisions = state!.decisions.filter(d => d.status === 'open');
    content = `<div class="office-inspector-heading"><span class="office-founder-icon">${icon('target')}</span><span class="office-inspector-type">FOUNDER HUB</span></div><h3>You set the direction.</h3><p class="office-inspector-description">Pick a department or teammate in the office to see their ownership, provider, and current work.</p><div class="office-founder-summary"><strong>${decisions.length}</strong><span>${decisions.length === 1 ? 'decision needs' : 'decisions need'} your direction</span></div><div class="office-inspector-section"><h4>Waiting for you</h4>${decisions.length ? `<ul class="office-decision-list">${decisions.slice(0, 3).map(d => `<li><span class="department-tag dept-${esc(d.departmentId)}">${esc(departmentName(d.departmentId))}</span><strong>${esc(d.title)}</strong>${sampleBadge(d.source === 'sample')}</li>`).join('')}</ul>` : '<p class="office-inspector-empty">No founder decisions are waiting.</p>'}</div><button class="button button-primary button-full" data-action="office-decisions">Review founder decisions ${icon('arrow')}</button><button class="button button-quiet button-full" data-action="open-chat">${icon('chat')}Give the team direction</button>`;
  }
  return `<aside class="office-inspector" data-testid="office-inspector" aria-label="Selected office item" data-scroll="office-inspector"><div class="office-inspector-top"><span>IN THE OFFICE</span>${officeSelection ? '<button class="icon-button" data-action="office-clear" aria-label="Clear office selection">' + icon('close') + '</button>' : icon('spark')}</div>${content.replace('<h3>', '<h3 id="office-selected-title" tabindex="-1">')}<div class="office-inspector-source">${state!.mode === 'demo' ? '<span class="badge badge-sample">Sample workspace</span><p>Illustrative work and evidence. Provider availability is detected separately on the host.</p>' : '<span class="badge badge-green">Live workspace</span><p>Work status comes from the connected workspace. Host availability does not imply an active provider run.</p>'}</div></aside>`;
}

function officeDirectory(): string {
  return `<section class="office-directory" aria-label="Office team directory"><div class="section-heading"><div><h2>Your departments & teammates</h2><p>Use this directory to select the same people and departments without the 3D canvas.</p></div><span>${state!.departments.length} departments · ${state!.agents.length} teammates</span></div><div class="office-directory-grid">${state!.departments.map(d => `<section class="office-directory-department dept-${esc(d.id)}"><button id="office-department-${esc(d.id)}" class="office-directory-heading ${officeSelection?.kind === 'department' && officeSelection.id === d.id ? 'selected' : ''}" data-office-department="${esc(d.id)}" aria-label="Select ${esc(d.name)} department" aria-pressed="${officeSelection?.kind === 'department' && officeSelection.id === d.id}">${icon(deptIcon[d.id])}<span>${esc(d.name)}</span>${icon('chevron')}</button><ul>${state!.agents.filter(a => a.departmentId === d.id).map(a => `<li><button id="office-agent-${esc(a.id)}" class="office-directory-agent ${officeSelection?.kind === 'agent' && officeSelection.id === a.id ? 'selected' : ''}" data-office-agent="${esc(a.id)}" aria-label="Select ${esc(a.name)}" aria-pressed="${officeSelection?.kind === 'agent' && officeSelection.id === a.id}"><span class="status-dot ${!a.enabled || state!.config.paused ? 'neutral' : state!.tasks.some(t => t.agentId === a.id && t.status === 'running') ? 'green' : state!.tasks.some(t => t.agentId === a.id && t.status === 'waiting') ? 'amber' : 'neutral'}"></span><span>${esc(a.name)}</span><small>${a.provider === 'claude' ? 'Claude' : 'Codex'}</small></button></li>`).join('') || '<li class="office-no-members">No teammates assigned</li>'}</ul></section>`).join('')}</div></section>`;
}

function officeView(): string {
  const decisions = state!.decisions.filter(d => d.status === 'open');
  return `${pageHeading('Your startup, in one room.', 'Explore your departments, teammates, and the work that connects them.')}${sampleBanner()}<section class="office-mission"><span class="mission-icon">${icon('target')}</span><div><span>SHARED MISSION</span><h2>${esc(state!.company.mission)}</h2></div><button class="button button-secondary button-small" data-action="office-decisions">${icon('alert')}${decisions.length} ${decisions.length === 1 ? 'needs' : 'need'} direction</button></section><div class="office-layout"><section class="office-stage" aria-label="Interactive 3D office"><div class="office-stage-toolbar"><div><span class="office-stage-eyebrow">THE COMPANY FLOOR</span><h2>${state!.departments.length} departments. One mission.</h2></div><div><button id="office-reset" class="button button-quiet button-small" data-action="office-reset">${icon('refresh')}Reset view</button><button id="office-motion" class="button button-secondary button-small" data-action="office-motion" aria-pressed="${officeMotion}">${icon(officeMotion ? 'pause' : 'play')}${officeMotion ? 'Pause motion' : 'Resume motion'}</button></div></div><div id="office-scene-mount" class="office-scene-mount"></div><div class="office-stage-bottom"><div class="office-legend"><span><i class="status-dot green"></i>In motion</span><span><i class="status-dot amber"></i>Waiting</span><span><i class="status-dot blue"></i>For review</span></div><p>Drag to rotate · Scroll or pinch to zoom · Select a teammate</p></div></section>${officeInspector()}</div><div class="office-truth-note">${icon('branch')}<span>Animations and links illustrate recorded task dependency state. They do not represent live agent conversations. ${state!.mode === 'demo' ? 'This floor shows sample activity.' : 'Live work and evidence remain attached to their tasks.'}</span></div>${officeDirectory()}`;
}

function disposeOffice(): void {
  officeGeneration += 1;
  try { officeController?.dispose(); }
  finally {
    officeController = null;
    officeHost?.remove();
    officeHost = null;
    officeInitialized = false;
  }
}

function mountOffice(): void {
  const mount = document.getElementById('office-scene-mount');
  if (!mount || view !== 'office') return;
  if (!officeHost) {
    officeHost = document.createElement('div');
    officeHost.id = 'office-scene-host';
    officeHost.className = 'office-scene-host';
    officeHost.dataset.testid = 'office-scene-host';
    officeHost.setAttribute('aria-label', '3D office visualization');
  }
  mount.replaceWith(officeHost);
  if (!officeInitialized) {
    officeInitialized = true;
    const host = officeHost;
    const generation = officeGeneration;
    host.innerHTML = '<div class="office-scene-loading" role="status"><span class="loading-indicator"></span><span>Opening your 3D office…</span></div>';
    officeModule ??= import('./office-scene');
    void officeModule.then(({ createOfficeScene }) => {
      // A renderer loading after navigation must never attach to a stale or discarded host.
      if (view !== 'office' || officeHost !== host || generation !== officeGeneration) return;
      host.replaceChildren();
      try {
        officeController = createOfficeScene(host, selectOfficeItem);
        officeController.setMotion(officeMotion);
        officeController.update(state!);
        if (officeSelection) officeController.focus(officeSelection);
      } catch {
        officeController?.dispose();
        officeController = null;
        host.innerHTML = `<div class="office-render-fallback" data-testid="office-ui-fallback">${icon('layers')}<h3>The team directory is ready.</h3><p>This browser could not start the 3D renderer. Select a department or teammate from the directory below to inspect their work.</p></div>`;
      }
    }).catch(() => {
      officeModule = null;
      if (view !== 'office' || officeHost !== host || generation !== officeGeneration) return;
      host.innerHTML = `<div class="office-render-fallback" data-testid="office-ui-fallback">${icon('layers')}<h3>The team directory is ready.</h3><p>The 3D renderer could not load. You can still inspect departments and teammates using the directory below.</p></div>`;
    });
  }
  try { officeController?.update(state!); }
  catch {
    officeController?.dispose();
    officeController = null;
    officeHost.innerHTML = `<div class="office-render-fallback" data-testid="office-ui-fallback">${icon('layers')}<h3>The team directory is ready.</h3><p>The 3D view stopped rendering. You can continue inspecting departments, teammates, and evidence with the directory below.</p></div>`;
  }
}


function fullDate(date: string): string {
  if (Number.isNaN(Date.parse(date))) return 'Unknown recorded date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
}

function taskChips(ids: string[], attribute = 'open-task'): string {
  return ids.map(id => {
    const task = state!.tasks.find(t => t.id === id);
    return task ? `<button class="impact-task-chip" data-${attribute}="${esc(id)}">${esc(task.title)}</button>` : '';
  }).join('');
}

function renderDecisionImpact(decision: WorkspaceState['decisions'][number]): string {
  const impact = decisionImpact(decision, state!);
  return `<div class="decision-impact" data-testid="decision-impact"><div class="impact-heading">${icon('branch')}<strong>What your answer changes</strong></div><div class="impact-task-row"><span>Direct work</span><div>${taskChips(impact.directTaskIds) || '<span class="muted">No attached task records</span>'}</div></div>${impact.downstreamTaskIds.length ? `<div class="impact-task-row"><span>Downstream</span><div>${taskChips(impact.downstreamTaskIds)}</div></div>` : ''}<div class="impact-readiness"><span>${impact.readyAfterAnswerIds.length} newly eligible</span><span>${impact.stillBlockedIds.length} still blocked</span></div>${impact.explanations.map(explanation => `<p>${esc(explanation)}</p>`).join('')}</div>`;
}

function missionInspector(): string {
  const task = state!.tasks.find(t => t.id === selectedMissionTask);
  if (!task) return `<section class="mission-inspector mission-inspector-empty" data-testid="mission-task-inspector">${icon('branch')}<div><h3>Select a piece of the mission.</h3><p>Inspect its owner, prerequisites, evidence, and next handoff.</p></div></section>`;
  const handoff = describeHandoff(task, state!);
  const agent = agentFor(task);
  const downstream = state!.tasks.filter(t => t.dependsOn.includes(task.id));
  return `<section class="mission-inspector" data-testid="mission-task-inspector"><div class="mission-inspector-header"><div><div class="card-eyebrow"><span class="department-tag dept-${esc(task.departmentId)}">${esc(departmentName(task.departmentId))}</span><span class="badge badge-neutral">${esc(inferTaskStage(task, state!))}</span>${sampleBadge(task.source === 'sample')}</div><h3 id="mission-inspector-title" tabindex="-1">${esc(task.title)}</h3><p>${esc(task.description)}</p></div><div class="mission-inspector-actions"><button class="button button-secondary" data-focus-office-task="${esc(task.id)}">Locate in office ${icon('layers')}</button><button class="button button-primary" data-open-task="${esc(task.id)}">Open workbench ${icon('arrow')}</button></div></div><div class="mission-inspector-grid"><div><div class="inspector-mini-label">OWNERSHIP</div><strong>${esc(agent?.name ?? 'Unassigned')}</strong><p>${agent ? providerName(agent.provider) : 'Assign an owner when creating work'} · ${statusLabels[task.status]}</p><div class="inspector-mini-label">EVIDENCE</div><p>${task.evidence.length} attached · ${task.artifact ? 'Deliverable recorded' : 'No deliverable yet'}</p></div><div><div class="inspector-mini-label">HANDOFF REQUIREMENTS</div><div class="handoff-state ${handoff.ready ? 'is-ready' : 'is-blocked'}">${icon(handoff.ready ? 'check' : 'clock')}${handoff.ready ? 'Direction & prerequisites are ready' : handoff.needsDirection ? 'Founder direction is still required' : 'Waiting for prerequisites'}</div><ul class="handoff-list">${handoff.prerequisites.map(p => `<li><span class="status-dot ${p.ready ? 'green' : 'amber'}"></span><div>${p.status === 'missing' ? `<strong>${esc(p.title)}</strong>` : `<button data-mission-task="${esc(p.taskId)}">${esc(p.title)}</button>`}<p>${esc(p.reason)}</p></div></li>`).join('') || '<li class="muted">No prerequisites are recorded.</li>'}</ul></div><div><div class="inspector-mini-label">NEXT HANDOFF</div>${downstream.length ? `<div class="inspector-handoffs">${taskChips(downstream.map(t => t.id), 'mission-task')}</div>` : '<p>No downstream work is recorded.</p>'}<p class="inspector-runtime-note">Readiness does not start a run. Queuing, runtime permissions, and founder acceptance still apply.</p></div></div></section>`;
}

function missionView(): string {
  return `${pageHeading('From direction to delivery.', 'See the work, the handoffs, and the decisions that move your mission.')}${sampleBanner()}<div class="mission-view-toolbar"><div><span class="status-dot ${replaying() ? 'amber' : 'green'}"></span>${checkpoint ? 'Recorded mission state' : historyLoadingId ? 'Loading recorded state…' : 'Connected to workspace state'}<span class="mission-toolbar-detail">${state!.tasks.length} tasks · ${state!.decisions.filter(d => d.status === 'open').length} open decisions</span></div><button class="button button-primary" data-action="create-task"${disabled()}>${icon('plus')}Create task</button></div>${missionCard()}${renderMissionMap(state!, selectedMissionTask).replace('<div class="mission-map-scroll">', '<div class="mission-map-scroll" tabindex="0" data-scroll="mission-map" aria-label="Scroll through mission stages and tasks">')}<p class="mission-scroll-note">Scroll across the stages and down through the recorded tasks.</p>${missionInspector()}<div class="mission-directions">${decisionPanel()}</div>`;
}

function replayBanner(): string {
  if (!checkpoint && !historyLoadingId) return '';
  const entries = history?.entries ?? [];
  const selectedIndex = checkpoint ? entries.findIndex(e => e.id === checkpoint!.id) : -1;
  return `<section class="replay-banner" data-testid="replay-banner" aria-label="Recorded workspace replay"><div class="replay-banner-label">${icon('clock')}<div><strong>${checkpoint ? 'Read-only replay' : 'Loading recorded checkpoint…'}</strong><span>${checkpoint ? `${esc(fullDate(checkpoint.recordedAt))} · ${checkpoint.source === 'sample' ? 'Sample recording' : 'Live recording'} · Revision ${checkpoint.missionRevision}` : 'Your live workspace continues separately.'}</span></div></div>${checkpoint && entries.length > 1 ? `<div class="replay-scrubber"><button class="icon-button" data-history-id="${esc(entries[selectedIndex + 1]?.id ?? '')}" aria-label="Older checkpoint" ${selectedIndex < 0 || selectedIndex >= entries.length - 1 ? 'disabled' : ''}>${icon('chevron', 'flip-icon')}</button><input id="history-range" type="range" min="0" max="${entries.length - 1}" value="${Math.max(0, entries.length - 1 - selectedIndex)}" aria-label="Recorded checkpoints"/><button class="icon-button" data-history-id="${esc(entries[selectedIndex - 1]?.id ?? '')}" aria-label="Newer checkpoint" ${selectedIndex <= 0 ? 'disabled' : ''}>${icon('chevron')}</button></div>` : ''}<button class="button button-secondary" data-action="return-live">Return to live ${icon('arrow')}</button></section>`;
}

function timelineView(): string {
  const entries = history?.entries ?? [];
  const selected = checkpoint;
  return `${pageHeading('The story of the work.', 'Explore recorded mission, team, decisions, and deliverables.')}<div class="timeline-intro"><div>${icon('clock')}<span>Snapshots are read-only. Live updates continue while you explore; returning to live restores the current view.</span></div><button class="button button-secondary button-small" data-action="history-refresh" ${historyLoading ? 'disabled' : ''}>${icon('refresh')}Refresh history</button></div>${historyError ? `<div class="inline-error" role="alert">${icon('alert')}${esc(historyError)}</div>` : ''}<div class="timeline-layout"><section class="timeline-recordings" aria-label="Recorded checkpoints"><div class="section-heading"><h2>Recorded checkpoints</h2><span>${entries.length} retained</span></div>${historyLoading && !history ? '<div class="timeline-loading"><span class="loading-indicator"></span>Loading history…</div>' : entries.length ? `<div class="timeline-entry-list">${entries.map(entry => `<button class="timeline-entry ${entry.id === selected?.id ? 'is-selected' : ''}" data-history-id="${esc(entry.id)}" data-testid="history-entry" aria-pressed="${entry.id === selected?.id}" aria-label="Replay ${esc(entry.title)} · ${esc(fullDate(entry.recordedAt))}"><span class="timeline-entry-marker">${icon(entry.decisionIds.length ? 'target' : entry.taskIds.length ? 'file' : 'clock')}</span><span><span class="timeline-entry-meta"><time datetime="${esc(entry.recordedAt)}">${esc(fullDate(entry.recordedAt))}</time>${sampleBadge(entry.source === 'sample')}</span><strong>${esc(entry.title)}</strong><span class="timeline-entry-detail">${esc(entry.detail)}</span><span class="timeline-entry-counts">Revision ${entry.missionRevision} · ${entry.taskIds.length} task records · ${entry.decisionIds.length} decision records</span></span>${icon('chevron')}</button>`).join('')}</div>` : empty('Your history starts with the work', 'Workspace changes will create recorded checkpoints.', 'clock')}<div class="timeline-retention">${history ? `Retains up to ${history.retainedLimit} checkpoints. ${history.droppedCount ? `${history.droppedCount} earlier recordings are no longer retained.` : 'No earlier recordings have been dropped.'}` : 'History is bounded. Large recorded outputs may be shortened.'}</div></section><section class="timeline-selected"><div class="timeline-snapshot-heading"><span class="eyebrow">${selected ? 'RECORDED SNAPSHOT' : 'LIVE WORKSPACE'}</span><h2>${selected ? esc(selected.title) : 'Choose a checkpoint to explore.'}</h2><p>${selected ? esc(fullDate(selected.recordedAt)) + ' · ' + (selected.source === 'sample' ? 'Sample source' : 'Live source') : 'The same recorded state can be explored in Mission, 3D Office, and each task workbench.'}</p></div>${selected ? `<div class="snapshot-operation"><span>Recorded operation</span><code>${esc(selected.kind)}</code><span>Mission revision</span><strong>${selected.missionRevision}</strong></div><div class="snapshot-mission">${icon('target')}<p>${esc(state!.company.mission)}</p></div><div class="snapshot-changes"><h3>Changed task records</h3>${taskChips(selected.taskIds) || '<p class="muted">No task record changes in this checkpoint.</p>'}<h3>Changed decision records</h3>${selected.decisionIds.map(id => { const decision = state!.decisions.find(d => d.id === id); return `<p>${esc(decision?.title ?? id)}${decision ? ' · ' + esc(decision.status) : ''}</p>`; }).join('') || '<p class="muted">No decision record changes in this checkpoint.</p>'}</div><div class="snapshot-navigation"><button class="button button-primary" data-view="mission">Explore recorded mission ${icon('branch')}</button><button class="button button-secondary" data-view="office">Open recorded office ${icon('layers')}</button></div>${selected.limitations.length ? `<div class="snapshot-limitations"><h3>Recording limitations</h3><ul>${selected.limitations.map(text => `<li>${esc(text)}</li>`).join('')}</ul></div>` : ''}<p class="timeline-truth">Only recorded task text, previews, and evidence are available. Current worktree files are unavailable during replay.</p>` : `<div class="snapshot-placeholder">${icon('branch')}<strong>Every checkpoint keeps the context.</strong><p>Inspect how ownership, prerequisites, founder direction, and evidence looked at that point in time.</p><button class="button button-secondary" data-view="mission">Open live mission ${icon('arrow')}</button></div>`}</section></div>`;
}

function createTaskDialog(): string {
  return `<div class="dialog-header"><div><div class="eyebrow">MOVE THE MISSION FORWARD</div><h2 id="dialog-title">Create a task</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><form class="dialog-body create-task-form" data-form="create-task"><label for="task-title">Task title</label><input id="task-title" data-draft="task-title" value="${value('task-title', '')}" maxlength="240" required placeholder="A specific outcome the team can deliver"/><label for="task-description">Task description</label><textarea id="task-description" data-draft="task-description" rows="3" required placeholder="Describe the outcome, acceptance criteria, and any constraints.">${value('task-description', '')}</textarea><div class="task-form-grid"><div><label for="task-department">Department</label><select id="task-department" data-draft="task-department">${state!.departments.map(d => `<option value="${esc(d.id)}" ${(drafts['task-department'] ?? (view === 'department' ? department : 'engineering')) === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></div><div><label for="task-owner">Owner</label><select id="task-owner" data-draft="task-owner"><option value="">Unassigned</option>${state!.agents.filter(a => a.enabled).map(a => `<option value="${esc(a.id)}" ${drafts['task-owner'] === a.id ? 'selected' : ''}>${esc(a.name)} · ${esc(departmentName(a.departmentId))}</option>`).join('')}</select></div></div><label for="task-priority">Priority</label><select id="task-priority" data-draft="task-priority">${(['high','medium','low'] as const).map(p => `<option value="${p}" ${(drafts['task-priority'] ?? 'medium') === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select><label for="task-dependencies">Dependencies</label><select id="task-dependencies" data-draft="task-dependencies" multiple size="4">${state!.tasks.filter(t => t.status !== 'dismissed').map(t => `<option value="${esc(t.id)}" ${(drafts['task-dependencies'] ?? '').split('\n').includes(t.id) ? 'selected' : ''}>${esc(t.title)} · ${statusLabels[t.status]}</option>`).join('')}</select><p class="field-help">Select prerequisite tasks. Their founder acceptance is required before this task can proceed.</p><label class="toggle-row"><span><strong>Founder direction required</strong><span>Hold this task until an explicit founder decision is recorded.</span></span><input id="task-direction" type="checkbox" aria-label="Founder direction required" data-draft="task-direction" ${drafts['task-direction'] === 'true' ? 'checked' : ''}/><span class="toggle-track" aria-hidden="true"></span></label><div class="dialog-notice">${icon('spark')}A task starts as a proposal. Creating it does not execute a provider or publish anything.</div><div class="form-actions"><button type="submit" class="button button-primary"${disabled()}>Create proposal ${icon('plus')}</button><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button></div></form>`;
}

function renderDocument(text: string): string {
  if (!text.trim()) return '<div class="empty-evidence">No document has been delivered yet.</div>';
  const inline = (line: string): string => esc(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const output: string[] = [];
  let code: string[] | null = null;
  let list = false;
  const closeList = (): void => { if (list) { output.push('</ul>'); list = false; } };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { closeList(); if (code) { output.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code = []; continue; }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item) { if (!list) { output.push('<ul>'); list = true; } output.push(`<li>${inline(item[1]!)}</li>`); continue; }
    closeList();
    if (heading) { const level = Math.min(4, heading[1]!.length + 1); output.push(`<h${level}>${inline(heading[2]!)}</h${level}>`); }
    else if (line.startsWith('> ')) output.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) output.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) output.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  return `<div class="rendered-document">${output.join('')}</div>`;
}

function evidenceMarkup(task: Task, commandsOnly = false): string {
  const evidence = commandsOnly ? task.evidence.filter(e => e.kind === 'command') : task.evidence;
  return `<div class="workbench-section-heading"><h3>${commandsOnly ? 'Recorded check output' : 'Supporting evidence'}</h3><span>${evidence.length} attached</span></div>${evidence.length ? evidence.map(e => `<article class="evidence-block"><div class="evidence-block-header">${icon(e.kind === 'command' ? 'code' : e.kind === 'diff' ? 'branch' : 'file')}<strong>${esc(e.label)}</strong><span class="badge ${e.source === 'sample' ? 'badge-sample' : 'badge-neutral'}">${e.source === 'sample' ? 'Sample' : e.source === 'observed' ? 'Observed' : 'Agent-reported'}</span></div><pre>${esc(e.detail)}</pre><div class="evidence-recorded">Recorded ${esc(fullDate(e.recordedAt))} · ${esc(e.kind)}</div></article>`).join('') : `<div class="empty-evidence">${commandsOnly ? 'No check output is attached. A recorded status does not establish that checks passed.' : 'No evidence is attached. Review the work before accepting it.'}</div>`}`;
}

const taskKey = (task: Task): string => `${task.id}:${task.updatedAt}:${task.workspacePath ?? ''}`;

function fileWorkbench(task: Task): string {
  const diffs = task.evidence.filter(e => e.kind === 'diff');
  if (replaying()) return `<div class="workbench-source-note">${icon('clock')}Current worktree files are unavailable during replay. Only recorded diffs below belong to this snapshot.</div>${diffs.map(e => `<article class="evidence-block"><div class="evidence-block-header">${icon('branch')}<strong>${esc(e.label)}</strong>${sampleBadge(e.source === 'sample')}</div><pre>${esc(e.detail)}</pre></article>`).join('') || '<div class="empty-evidence">No recorded diff is attached.</div>'}`;
  const key = taskKey(task);
  const inventory = fileInventories.get(key);
  const current = selectedFilePath ? fileContents.get(key + ':' + selectedFilePath) : undefined;
  return `<div class="workbench-section-heading"><h3>Current changed files</h3><button class="button button-small button-secondary" data-refresh-files="${esc(task.id)}">${icon('refresh')}Refresh files</button></div><p class="workbench-source-note">This inspector reads the retained task worktree as it exists now. Repository scripts are not started.</p>${!inventory ? '<div class="empty-evidence">Open or refresh the file inventory to inspect current changed files.</div>' : inventory.loading ? '<div class="timeline-loading"><span class="loading-indicator"></span>Inspecting changed files…</div>' : inventory.error ? `<div class="empty-evidence"><strong>Files are unavailable</strong><p>${esc(inventory.error)}</p></div>` : inventory.response?.files.length ? `<div class="workbench-files"><nav class="workbench-file-list" aria-label="Changed files">${inventory.response.files.map(file => `<button data-task-file="${esc(file.path)}" data-task-id="${esc(task.id)}" class="${selectedFilePath === file.path ? 'is-selected' : ''}" ${file.status === 'deleted' || !file.previewable ? 'disabled' : ''}><span class="file-change file-change-${file.status}">${file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}</span><span>${esc(file.path)}</span>${!file.previewable ? '<span class="file-unavailable">Not viewable</span>' : ''}</button>`).join('')}</nav><div class="workbench-file-content">${!selectedFilePath ? '<div class="empty-evidence">Select a changed text file to inspect its current contents.</div>' : current?.loading ? '<div class="timeline-loading"><span class="loading-indicator"></span>Reading file…</div>' : current?.error ? `<div class="inline-error">${esc(current.error)}</div>` : current?.response ? `<div class="file-source-heading"><strong>${esc(current.response.path)}</strong><span>${esc(current.response.language)}</span></div>${current.response.truncated ? '<div class="workbench-source-note">This file content was shortened by the server. The full file is not shown.</div>' : ''}${/\.html?$/i.test(current.response.path) && !current.response.truncated ? `<button class="button button-small button-secondary" data-preview-file="${esc(task.id)}">${icon('play')}Preview HTML file</button>` : ''}<pre class="file-source-content">${esc(current.response.content)}</pre>` : '<div class="empty-evidence">The file has not been loaded.</div>'}</div></div>` : '<div class="empty-evidence">No viewable changed files are present in a retained worktree.</div>'}${inventory?.response?.truncated ? '<div class="workbench-source-note">The changed-file inventory was shortened. Additional files may be omitted.</div>' : ''}${diffs.length ? `<section class="recorded-diffs"><h3>Recorded diff evidence</h3>${diffs.map(e => `<article class="evidence-block"><div class="evidence-block-header">${icon('branch')}<strong>${esc(e.label)}</strong>${sampleBadge(e.source === 'sample')}</div><pre>${esc(e.detail)}</pre></article>`).join('')}</section>` : ''}`;
}

function previewWorkbench(task: Task): string {
  const currentFile = !replaying() && filePreview?.taskKey === taskKey(task) ? filePreview : null;
  const preview = task.preview;
  const available = !!currentFile || !!preview?.html;
  const source = currentFile ? `Current changed file · ${currentFile.path}` : preview ? `${checkpoint ? 'Recorded snapshot' : 'Attached HTML'} · ${preview.source === 'sample' ? 'Sample source' : 'Founder-supplied source'} · ${fullDate(preview.updatedAt)}` : '';
  const params = new URLSearchParams();
  if (checkpoint) params.set('checkpoint', checkpoint.id);
  else if (currentFile) params.set('path', currentFile.path);
  else if (preview) params.set('version', preview.updatedAt);
  const url = `/api/tasks/${encodeURIComponent(task.id)}/preview${params.size ? '?' + params.toString() : ''}`;
  return `<div class="workbench-section-heading"><h3>Isolated app preview</h3>${preview?.source === 'sample' && !currentFile ? sampleBadge(true) : ''}</div><p class="workbench-source-note">Self-contained HTML only. External assets and fetch requests are blocked; inline interaction is allowed; the parent workspace is isolated.</p>${available ? `<div class="preview-source-label">${icon(currentFile ? 'file' : 'clock')}<span>${esc(source)}</span></div><iframe class="app-preview-frame" data-testid="task-app-preview" title="Isolated app preview" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${esc(url)}"></iframe>` : '<div class="preview-empty">' + icon('code') + '<h3>No HTML preview is attached.</h3><p>Attach a self-contained HTML document, or inspect a changed HTML file from the task worktree.</p></div>'}${replaying() ? '<div class="workbench-source-note">This preview uses captured HTML from the selected checkpoint. Editing and current-file preview are unavailable during replay.</div>' : `<details class="preview-source-editor" id="preview-editor-${esc(task.id)}" data-remember ${expanded.has(`preview-editor-${task.id}`) ? 'open' : ''}><summary>${preview ? 'Edit attached HTML' : 'Attach HTML preview'}${icon('down')}</summary><form data-form="preview" data-id="${esc(task.id)}"><label for="preview-html-${esc(task.id)}">HTML preview source</label><textarea id="preview-html-${esc(task.id)}" data-draft="preview-html-${esc(task.id)}" rows="8" maxlength="64000" placeholder="<!doctype html>...">${value(`preview-html-${task.id}`, preview?.html ?? '')}</textarea><div class="form-actions"><button class="button button-primary" type="submit"${disabled()}>Save HTML preview</button>${preview ? `<button class="button button-secondary" type="button" data-preview-remove="${esc(task.id)}"${disabled()}>Remove HTML preview</button>` : ''}</div></form></details>`}`;
}

function teamView(): string {
  return `${pageHeading('Meet your startup team.', 'Roles create responsibility. Evidence shows what actually happened.')}${sampleBanner()}<div class="team-toolbar"><div><h2>${state!.agents.length} teammates</h2><p>Choose a role and native provider for each agent.</p></div><div class="toolbar-buttons">${button('Export template', 'export-template', 'button button-secondary', 'download')}${button('Import template', 'import-template', 'button button-secondary', 'upload')}${button('Add teammate', 'add-agent', 'button button-primary', 'plus')}</div></div><div class="team-grid">${state!.agents.map(a => {
    const provider = providerStatus(a.provider);
    return `<article class="agent-card ${a.enabled ? '' : 'agent-disabled'}"><div class="agent-card-top"><span class="agent-avatar dept-${esc(a.departmentId)}">${icon(deptIcon[a.departmentId])}</span><span class="status-label ${a.enabled ? 'status-queued' : 'status-paused'}"><span class="status-dot"></span>${esc(agentStatus(a))}</span></div><h3>${esc(a.name)}</h3><p class="agent-role">${esc(a.role)}</p><div class="agent-card-meta"><span class="department-tag dept-${esc(a.departmentId)}">${esc(departmentName(a.departmentId))}</span><span class="provider-pill">${a.provider === 'claude' ? '<span class="provider-symbol claude-symbol">✳</span>' : '<span class="provider-symbol codex-symbol">◇</span>'}${providerName(a.provider)}</span></div><div class="agent-provider-status"><span class="status-dot ${provider.className}"></span>${esc(provider.label)} <span>on host</span></div><button class="button button-secondary button-full" data-edit-agent="${esc(a.id)}">${icon('settings')}Edit ${esc(a.name)}</button></article>`;
  }).join('')}</div><div class="info-note">${icon('people')}<p>Providers run through their own CLI on the workspace host. A role, provider assignment, or sample status does not mean a real agent is connected. Review detected provider status in Settings.</p></div><input type="file" id="template-file" accept="application/json,.json" hidden />`;
}

function settingsView(): string {
  return `${pageHeading('Make this workspace yours.', 'Connect a project and decide how much the team can do.')}<div class="settings-grid"><section class="panel settings-panel"><div class="settings-heading">${icon('target')}<div><h2>Company & mission</h2><p>The direction every department shares.</p></div></div><form data-form="company"><label for="company-name">Company name</label><input id="company-name" data-draft="company-name" value="${value('company-name', state!.company.name)}" required maxlength="120"/><button type="submit" class="button button-secondary"${disabled()}>Save company name</button></form><form data-form="mission"><label for="settings-mission">Company mission</label><textarea id="settings-mission" data-draft="settings-mission" rows="4" required>${value('settings-mission', state!.company.mission)}</textarea><button type="submit" class="button button-primary"${disabled()}>Save mission</button></form></section><section class="panel settings-panel"><div class="settings-heading">${icon('branch')}<div><h2>Project repository</h2><p>A local checkout on the server host.</p></div></div><form data-form="repository"><label for="repo-path">Repository path</label><input id="repo-path" data-draft="repo-path" value="${value('repo-path', state!.company.repoPath ?? '')}" placeholder="/workspace/my-project" autocomplete="off" spellcheck="false" required/><p class="field-help">Use an absolute directory path. Repository audits inspect local files; no GitHub token is requested.</p><div class="form-actions"><button class="button button-primary" type="submit"${disabled()}>${icon('link')}Connect repository</button><button class="button button-secondary" type="button" data-action="inspect-repo"${busy || !state!.company.repoPath ? ' disabled' : ''}>${icon('search')}Inspect repository</button></div></form><div class="repository-status"><span class="status-dot ${state!.company.repoPath ? 'green' : 'neutral'}"></span><div><strong>${state!.company.repoPath ? 'Repository connected' : 'No repository connected'}</strong><span>${esc(state!.company.repoPath ?? 'Sample mode works without a checkout.')}</span></div></div><p class="field-help">Native provider tasks may modify the connected repository. Review run permissions below before enabling them.</p></section><section class="panel settings-panel runtime-settings"><div class="settings-heading">${icon('settings')}<div><h2>Runtime permissions</h2><p>You decide when the team moves.</p></div></div><form data-form="runtime"><label class="toggle-row"><span><strong>Inspect repository automatically</strong><span>Run local inspection on the configured interval.</span></span><input id="auto-inspect" type="checkbox" data-draft="auto-inspect" ${(checkpoint ? String(state!.config.autoInspect) : drafts['auto-inspect'] ?? String(state!.config.autoInspect)) === 'true' ? 'checked' : ''}/><span class="toggle-track" aria-hidden="true"></span></label><label class="toggle-row"><span><strong>Allow native AI provider runs</strong><span>Opt in to host CLI runs. They can change files and consume provider usage.</span></span><input id="provider-runs" type="checkbox" data-draft="provider-runs" ${(checkpoint ? String(state!.config.allowProviderRuns) : drafts['provider-runs'] ?? String(state!.config.allowProviderRuns)) === 'true' ? 'checked' : ''}/><span class="toggle-track" aria-hidden="true"></span></label><label for="cycle-seconds">Run interval (seconds)</label><input id="cycle-seconds" data-draft="cycle-seconds" type="number" min="10" max="3600" step="1" value="${value('cycle-seconds', String(state!.config.cycleSeconds))}" required/><div class="form-actions"><button class="button button-primary" type="submit"${disabled()}>Save runtime settings</button>${button(state!.config.paused ? 'Resume team' : 'Pause team', 'toggle-pause', 'button button-secondary', state!.config.paused ? 'play' : 'pause')}</div></form><div class="field-help">Last cycle: ${shortTime(state!.runtime.lastCycleAt)} · Next cycle: ${shortTime(state!.runtime.nextCycleAt)}</div></section><section class="panel settings-panel"><div class="settings-heading">${icon('code')}<div><h2>Native providers</h2><p>Detected on the server host, not in your browser.</p></div></div><div class="provider-list">${(['claude', 'codex'] as ProviderId[]).map(id => { const p = providerStatus(id); return `<div class="provider-card"><div><span class="provider-brand">${id === 'claude' ? '✳' : '◇'}</span><strong>${providerName(id)}</strong><span class="badge badge-${p.className}">${p.label}</span></div><p>${esc(p.detail)}</p><span class="provider-checked">Last checked · ${shortTime(state!.providers.find(item => item.id === id)?.checkedAt ?? null)}</span></div>`; }).join('')}</div><p class="field-help">Install and sign in to the corresponding CLI on the host. Existing provider login may be used when supported by that CLI. This workspace does not collect your provider password or API key.</p></section></div>`;
}

function taskDialog(task: Task): string {
  const agent = agentFor(task);
  const controls: string[] = [];
  if (['proposed', 'failed'].includes(task.status)) controls.push(`<button class="button button-primary" data-task-action="start" data-task-id="${esc(task.id)}"${disabled()}>${icon('play')}Start task</button>`);
  if (['queued', 'running', 'waiting'].includes(task.status)) controls.push(`<button class="button button-secondary" data-task-action="pause" data-task-id="${esc(task.id)}"${disabled()}>${icon('pause')}Pause task</button>`);
  if (task.status === 'paused') controls.push(`<button class="button button-primary" data-task-action="resume" data-task-id="${esc(task.id)}"${disabled()}>${icon('play')}Resume task</button>`);
  if (task.status === 'review') controls.push(`<button class="button button-primary" data-task-action="accept" data-task-id="${esc(task.id)}"${disabled()}>${icon('check')}Accept delivery</button>`);
  if (!['done', 'dismissed', 'running'].includes(task.status)) controls.push(`<button class="button button-quiet" data-task-action="dismiss" data-task-id="${esc(task.id)}"${disabled()}>Dismiss task</button>`);
  const tabs: { id: WorkbenchTab; name: string; glyph: string }[] = [{ id: 'document', name: task.departmentId === 'marketing' ? 'Campaign' : 'Document', glyph: task.departmentId === 'marketing' ? 'megaphone' : 'file' }, { id: 'evidence', name: 'Evidence', glyph: 'check' }, { id: 'files', name: 'Code & diff', glyph: 'code' }, { id: 'checks', name: 'Checks', glyph: 'clock' }, { id: 'preview', name: 'App preview', glyph: 'play' }];
  const handoff = describeHandoff(task, state!);
  let body = '';
  if (workbenchTab === 'document') body = `<div class="workbench-section-heading"><h3>${task.departmentId === 'marketing' ? 'Campaign deliverable' : 'Delivered document'}</h3>${task.artifact ? `<button class="button button-small button-quiet" data-copy-artifact="${esc(task.id)}">${icon('copy')}Copy artifact</button>` : ''}</div>${task.departmentId === 'marketing' ? '<p class="workbench-source-note">A recorded campaign draft. Results and performance claims require actual connected data.</p>' : ''}${renderDocument(task.artifact)}`;
  else if (workbenchTab === 'evidence') body = evidenceMarkup(task);
  else if (workbenchTab === 'checks') body = evidenceMarkup(task, true);
  else if (workbenchTab === 'files') body = fileWorkbench(task);
  else body = previewWorkbench(task);
  return `<div class="dialog-header"><div><div class="card-eyebrow"><span class="workbench-eyebrow">TASK WORKBENCH</span><span class="department-tag dept-${esc(task.departmentId)}">${esc(departmentName(task.departmentId))}</span>${sampleBadge(task.source === 'sample')}${checkpoint ? '<span class="badge badge-amber">Read-only replay</span>' : ''}</div><h2 id="dialog-title">${esc(task.title)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><div class="workbench-summary"><p>${esc(task.description)}</p><div class="workbench-meta"><span><strong>${esc(agent?.name ?? 'Unassigned')}</strong>${agent ? ' · ' + providerName(agent.provider) : ''}</span><span class="status-label status-${task.status}"><span class="status-dot"></span>${statusLabels[task.status]}</span><span>${esc(sourceName(task))}</span><span>Updated ${esc(fullDate(task.updatedAt))}</span></div>${task.source === 'sample' ? '<p class="workbench-sample-note">' + icon('spark') + 'Sample work and findings. No real provider execution is implied.</p>' : ''}</div><div class="workbench-layout"><nav class="workbench-tabs" role="tablist" aria-label="Task artifacts">${tabs.map(tab => `<button id="workbench-tab-${tab.id}" role="tab" tabindex="${workbenchTab === tab.id ? 0 : -1}" aria-selected="${workbenchTab === tab.id}" aria-controls="workbench-tab-panel" data-workbench-tab="${tab.id}" class="${workbenchTab === tab.id ? 'is-selected' : ''}">${icon(tab.glyph)}<span>${tab.name}</span></button>`).join('')}<div class="workbench-sidebar-note"><span>RECORDED SOURCE</span><p>${checkpoint ? esc(fullDate(checkpoint.recordedAt)) : task.workspacePath ? 'Current retained worktree available' : 'Attached task artifacts'}</p></div></nav><section id="workbench-tab-panel" class="workbench-artifact" role="tabpanel" aria-labelledby="workbench-tab-${workbenchTab}" data-scroll="workbench-artifact-${workbenchTab}">${body}</section></div><div class="workbench-handoff"><span class="handoff-label">${icon('branch')}Handoff</span><span>${handoff.needsDirection ? 'Founder direction is required.' : handoff.ready ? 'Direction and prerequisite requirements are satisfied.' : 'Prerequisite work is still required.'}</span>${handoff.prerequisites.length ? `<div>${handoff.prerequisites.map(parent => `<span class="handoff-pill ${parent.ready ? 'ready' : ''}">${icon(parent.ready ? 'check' : 'clock')}${esc(parent.title)}</span>`).join('')}</div>` : ''}</div><div class="dialog-footer">${controls.join('') || '<span class="muted">This task is ' + esc(statusLabels[task.status].toLowerCase()) + '.</span>'}${replaying() ? '<span class="replay-control-note">Workspace changes are disabled in replay.</span>' : ''}</div>`;
}

function conversationDialog(): string {
  return `<div class="dialog-header"><div><div class="eyebrow">FOUNDER CONVERSATION</div><h2 id="dialog-title">Talk to your team</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close conversation">${icon('close')}</button></div><div class="chat-context">${icon('target')}<span>${esc(state!.company.mission)}</span></div><div class="chat-transparency">Messages become shared founder context. This chat records direction; it does not generate AI replies.</div><div class="chat-history" data-scroll="chat" role="log" aria-label="Team conversation">${state!.messages.length ? state!.messages.slice(-30).map(m => `<article class="message message-${esc(m.role)}"><span class="avatar message-avatar">${m.role === 'founder' ? 'F' : m.role === 'system' ? icon('layers') : esc(m.author.charAt(0))}</span><div><div class="message-meta"><strong>${esc(m.author)}</strong>${sampleBadge(m.source === 'sample')}<time datetime="${esc(m.createdAt)}">${shortTime(m.createdAt)}</time></div><p>${esc(m.text)}</p>${m.taskId ? `<button class="message-task-link" data-open-task="${esc(m.taskId)}">View linked task ${icon('arrow')}</button>` : ''}</div></article>`).join('') : empty('A shared place for direction', 'Tell the team what matters, clarify a decision, or record a constraint.', 'chat')}</div><form class="chat-composer" data-form="message"><label for="founder-message">Message to team</label><textarea id="founder-message" data-draft="founder-message" rows="3" required placeholder="What should the team know?">${value('founder-message', '')}</textarea><div><span>Recorded in this workspace</span><button class="button button-primary" type="submit"${disabled()}>Send message ${icon('send')}</button></div></form>`;
}

function agentDialog(agent?: Agent): string {
  const prefix = agent ? `agent-${agent.id}` : 'new-agent';
  return `<div class="dialog-header"><div><div class="eyebrow">YOUR TEAM</div><h2 id="dialog-title">${agent ? 'Edit teammate' : 'Add a teammate'}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><form class="dialog-body agent-form" data-form="agent" data-id="${esc(agent?.id ?? '')}" data-prefix="${esc(prefix)}"><label for="${esc(prefix)}-name">Teammate name</label><input id="${esc(prefix)}-name" data-draft="${esc(prefix)}-name" value="${value(`${prefix}-name`, agent?.name ?? '')}" placeholder="e.g. Growth lead" required maxlength="120"/><label for="${esc(prefix)}-role">Role & responsibilities</label><textarea id="${esc(prefix)}-role" data-draft="${esc(prefix)}-role" rows="3" required placeholder="Describe what this teammate owns.">${value(`${prefix}-role`, agent?.role ?? '')}</textarea>${!agent ? `<label for="${prefix}-department">Department</label><select id="${prefix}-department" data-draft="${prefix}-department">${state!.departments.map(d => `<option value="${esc(d.id)}" ${(drafts[`${prefix}-department`] ?? 'engineering') === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}<label for="${esc(prefix)}-provider">Native AI provider</label><select id="${esc(prefix)}-provider" data-draft="${esc(prefix)}-provider">${(['claude','codex'] as ProviderId[]).map(p => `<option value="${p}" ${(drafts[`${prefix}-provider`] ?? agent?.provider ?? 'codex') === p ? 'selected' : ''}>${providerName(p)}</option>`).join('')}</select><p class="field-help">Changing the provider chooses which host CLI handles future eligible runs. It does not authenticate the provider.</p>${agent ? `<label class="toggle-row"><span><strong>Teammate enabled</strong><span>Allow this role to be assigned work.</span></span><input id="${esc(prefix)}-enabled" type="checkbox" data-draft="${esc(prefix)}-enabled" ${(drafts[`${prefix}-enabled`] ?? String(agent.enabled)) === 'true' ? 'checked' : ''}/><span class="toggle-track" aria-hidden="true"></span></label>` : ''}<div class="form-actions"><button class="button button-primary" type="submit"${disabled()}>${agent ? 'Save teammate' : 'Add teammate'} ${icon('check')}</button><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button></div></form>`;
}

function modalMarkup(): string {
  if (!modal) return '';
  let body = '';
  if (modal.kind === 'task') {
    const task = state!.tasks.find(t => t.id === (modal as { id: string }).id);
    if (!task) { modal = null; return ''; }
    body = taskDialog(task);
  } else if (modal.kind === 'conversation') body = conversationDialog();
  else if (modal.kind === 'agent') {
    const agent = state!.agents.find(a => a.id === (modal as { id: string }).id);
    if (!agent) { modal = null; return ''; }
    body = agentDialog(agent);
  } else if (modal.kind === 'add-agent') body = agentDialog();
  else if (modal.kind === 'create-task') body = createTaskDialog();
  else body = `<div class="dialog-header"><div><div class="eyebrow">COMPANY DIRECTION</div><h2 id="dialog-title">Edit the mission</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><form class="dialog-body" data-form="mission"><label for="modal-mission">Company mission</label><textarea id="modal-mission" data-draft="modal-mission" rows="5" required>${value('modal-mission', state!.company.mission)}</textarea><p class="field-help">A new revision gives every department the latest direction. Existing task evidence stays attached.</p><div class="form-actions"><button class="button button-primary" type="submit"${disabled()}>Save mission ${icon('check')}</button><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button></div></form>`;
  return `<dialog class="workspace-dialog ${modal.kind === 'conversation' ? 'chat-drawer' : modal.kind === 'task' ? 'task-workbench' : ''}" aria-labelledby="dialog-title">${body}</dialog>`;
}

function render(): void {
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = focused?.id;
  let selection: [number | null, number | null] | null = null;
  try { if (focused && 'selectionStart' in focused) selection = [focused.selectionStart, focused.selectionEnd]; } catch { /* Numeric controls do not support selection. */ }
  const scroll = new Map(Array.from(app.querySelectorAll<HTMLElement>('[data-scroll]')).map(el => [el.dataset.scroll!, { top: el.scrollTop, left: el.scrollLeft }]));
  if (!state) {
    app.innerHTML = `<main class="loading-page"><span class="brand-symbol">${icon('layers')}</span><h1>Startup Workspace</h1>${loadError ? `<p role="alert">${esc(loadError)}</p><button class="button button-primary" data-action="retry">Try again ${icon('refresh')}</button>` : '<div class="loading-indicator"></div><p>Getting your workspace ready…</p>'}</main>`;
    return;
  }
  // Detach before replacing the shell so the canvas, camera, and scene listeners survive updates.
  if (view === 'office') { reconcileOfficeSelection(); officeHost?.remove(); }
  else if (officeHost || officeController) disposeOffice();
  app.innerHTML = `<div class="app-shell">${sidebar()}${navOpen ? '<button class="nav-overlay" aria-label="Close navigation" data-action="toggle-nav"></button>' : ''}<div class="main-shell">${topbar()}${replayBanner()}<main class="content ${view === 'office' ? 'office-content' : ''}" data-scroll="main">${view === 'office' ? officeView() : view === 'mission' ? missionView() : view === 'timeline' ? timelineView() : view === 'team' ? teamView() : view === 'settings' ? settingsView() : overview()}<footer class="workspace-footer"><span>${icon('layers')}Startup Workspace</span><span>${state.mode === 'demo' ? 'Sample data · no real agent activity' : 'Local project · evidence stays with the work'}</span></footer></main></div></div>${modalMarkup()}${notice ? `<div class="toast ${notice.error ? 'toast-error' : ''}" role="${notice.error ? 'alert' : 'status'}">${icon(notice.error ? 'alert' : 'check')}<span>${esc(notice.text)}</span><button class="icon-button" data-action="dismiss-notice" aria-label="Dismiss notification">${icon('close')}</button></div>` : ''}${busy ? '<div class="busy-indicator" role="status" aria-label="Saving workspace"></div>' : ''}`;
  if (replaying()) {
    app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('form input, form textarea, form select, form button, [data-edit-agent], [data-action=edit-mission], [data-action=add-agent], [data-action=import-template], [data-action=create-task], [data-action=inspect-repo], [data-preview-remove]').forEach(el => { el.disabled = true; });
  }
  if (view === 'office') mountOffice();
  app.querySelectorAll<HTMLButtonElement>('button:not([id])').forEach((button, index) => { button.id = 'workspace-control-' + index; });
  const dialog = app.querySelector<HTMLDialogElement>('dialog');
  if (dialog) {
    dialog.showModal();
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
  }
  app.querySelectorAll<HTMLElement>('[data-scroll]').forEach(el => { if (scroll.has(el.dataset.scroll!)) { el.scrollTop = scroll.get(el.dataset.scroll!)!.top; el.scrollLeft = scroll.get(el.dataset.scroll!)!.left; } else if (el.dataset.scroll === 'chat') el.scrollTop = el.scrollHeight; });
  app.querySelectorAll<HTMLDetailsElement>('details[data-remember]').forEach(el => el.addEventListener('toggle', () => { if (el.open) expanded.add(el.id); else expanded.delete(el.id); }));
  if (focusId) {
    const next = document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null;
    if (next && (!dialog || dialog.contains(next))) {
      next.focus({ preventScroll: true });
      if (selection) try { next.setSelectionRange(selection[0], selection[1]); } catch { /* Not a text control. */ }
    }
  }
}

function openModal(next: Modal): void {
  returnFocusId = (document.activeElement as HTMLElement)?.id ?? '';
  if (historyLoadingId && next.kind === 'task') { toast('Wait for the recorded checkpoint to finish loading.', true); return; }
  if (replaying() && ['mission', 'agent', 'add-agent', 'create-task'].includes(next.kind)) { toast('Return to live before changing the workspace.', true); return; }
  if (next.kind === 'task' && (modal?.kind !== 'task' || modal.id !== next.id)) { workbenchTab = 'document'; selectedFilePath = null; filePreview = null; }
  modal = next;
  navOpen = false;
  render();
}
function closeModal(): void {
  modal = null;
  render();
  document.getElementById(returnFocusId)?.focus({ preventScroll: true });
}

app.addEventListener('input', event => {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (el.dataset.draft) drafts[el.dataset.draft] = el instanceof HTMLInputElement && el.type === 'checkbox' ? String(el.checked) : el.value;
});
app.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'history-range' && history) { const entry = history.entries[history.entries.length - 1 - Number(input.value)]; if (entry) void selectCheckpoint(entry.id); return; }
  if (input.id === 'template-file' && input.files?.[0]) void importTemplate(input.files[0]);
  if (input.dataset.draft) drafts[input.dataset.draft] = input instanceof HTMLSelectElement && input.multiple ? Array.from(input.selectedOptions).map(option => option.value).join('\n') : input.type === 'checkbox' ? String(input.checked) : input.value;
});

app.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLElement>('button, a[data-action]');
  if (!control || control.hasAttribute('disabled')) return;

  if (control.dataset.focusOfficeTask) { view = 'office'; officeSelection = { kind: 'task', id: control.dataset.focusOfficeTask }; selectedAgentIdentity = null; render(); officeController?.focus(officeSelection); return; }
  if (control.dataset.missionTask) { selectedMissionTask = control.dataset.missionTask; render(); document.getElementById('mission-inspector-title')?.focus({ preventScroll: true }); document.querySelector<HTMLElement>('.mission-inspector')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' }); return; }
  if (control.dataset.historyId) { void selectCheckpoint(control.dataset.historyId); return; }
  if (control.dataset.workbenchTab) {
    workbenchTab = control.dataset.workbenchTab as WorkbenchTab; render();
    if (workbenchTab === 'files' && !replaying() && modal?.kind === 'task') { const task = state!.tasks.find(t => t.id === (modal as { id: string }).id); if (task && !fileInventories.has(taskKey(task))) void loadTaskFiles(task); }
    return;
  }
  if (control.dataset.refreshFiles) { const task = state!.tasks.find(t => t.id === control.dataset.refreshFiles); if (task) void loadTaskFiles(task); return; }
  if (control.dataset.taskFile && control.dataset.taskId) { const task = state!.tasks.find(t => t.id === control.dataset.taskId); if (task) void loadTaskFile(task, control.dataset.taskFile); return; }
  if (control.dataset.previewFile) {
    const task = state!.tasks.find(t => t.id === control.dataset.previewFile);
    const file = task && selectedFilePath ? fileContents.get(taskKey(task) + ':' + selectedFilePath)?.response : undefined;
    if (task && file && !file.truncated && !replaying()) { filePreview = { taskKey: taskKey(task), path: file.path, html: file.content }; workbenchTab = 'preview'; render(); }
    return;
  }
  if (control.dataset.previewRemove) { void requestAction({ type: 'set_task_preview', taskId: control.dataset.previewRemove, html: null }, [`preview-html-${control.dataset.previewRemove}`]); return; }

  if (control.dataset.officeAgent) { selectOfficeItem({ kind: 'agent', id: control.dataset.officeAgent }, true); return; }
  if (control.dataset.officeDepartment) { selectOfficeItem({ kind: 'department', id: control.dataset.officeDepartment }, true); return; }
  if (control.dataset.officeTask) { selectOfficeItem({ kind: 'task', id: control.dataset.officeTask }); return; }
  if (control.dataset.view) { view = control.dataset.view as View; navOpen = false; render(); if (view === 'timeline') void loadHistory(); return; }
  if (control.dataset.department) { department = control.dataset.department as DepartmentId; view = 'department'; navOpen = false; render(); return; }
  if (control.dataset.mode) { void requestAction({ type: 'set_mode', mode: control.dataset.mode as 'demo' | 'live' }); return; }
  if (control.dataset.openTask) { openModal({ kind: 'task', id: control.dataset.openTask }); return; }
  if (control.dataset.editAgent) { openModal({ kind: 'agent', id: control.dataset.editAgent }); return; }
  if (control.dataset.decision && control.dataset.option) { void requestAction({ type: 'resolve_decision', decisionId: control.dataset.decision, optionId: control.dataset.option }); return; }
  if (control.dataset.taskAction && control.dataset.taskId) { void requestAction({ type: 'task_action', taskId: control.dataset.taskId, action: control.dataset.taskAction as 'start' | 'pause' | 'resume' | 'dismiss' | 'accept' }); return; }
  if (control.dataset.copyArtifact) { const t = state?.tasks.find(t => t.id === control.dataset.copyArtifact); if (t) void navigator.clipboard.writeText(t.artifact).then(() => toast('Artifact copied.')).catch(() => toast('Clipboard unavailable. Select and copy the artifact text.', true)); return; }
  switch (control.dataset.action) {
    case 'retry': void load(); break;
    case 'toggle-nav': navOpen = !navOpen; render(); document.getElementById(navOpen ? 'nav-overview' : 'mobile-nav')?.focus(); break;
    case 'go-overview': event.preventDefault(); view = 'overview'; navOpen = false; render(); break;
    case 'go-settings': view = 'settings'; navOpen = false; render(); break;
    case 'open-chat': openModal({ kind: 'conversation' }); break;
    case 'edit-mission': openModal({ kind: 'mission' }); break;
    case 'close-modal': closeModal(); break;
    case 'add-agent': openModal({ kind: 'add-agent' }); break;
    case 'create-task': openModal({ kind: 'create-task' }); break;
    case 'history-refresh': void loadHistory(); break;
    case 'return-live': returnToLive(); break;
    case 'toggle-pause': void requestAction({ type: 'set_config', config: { paused: !state!.config.paused } }); break;
    case 'sample-step': void requestAction({ type: 'run_demo_cycle' }); break;
    case 'reset-demo': void requestAction({ type: 'reset_demo' }); break;
    case 'inspect-repo': void requestAction({ type: 'inspect_repo' }); break;
    case 'export-template': void exportTemplate(); break;
    case 'import-template': document.querySelector<HTMLInputElement>('#template-file')?.click(); break;
    case 'dismiss-notice': notice = null; render(); break;
    case 'office-clear': officeSelection = null; selectedAgentIdentity = null; render(); break;
    case 'office-decisions': view = 'overview'; render(); document.querySelector<HTMLElement>('.direction-panel')?.scrollIntoView({ block: 'start' }); break;
    case 'office-reset': officeController?.resetView(); break;
    case 'office-motion': officeMotion = !officeMotion; officeController?.setMotion(officeMotion); render(); break;
  }
});

app.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.form) return;
  event.preventDefault();
  if (!form.reportValidity() || busy || replaying()) return;
  const inputValue = (selector: string): string => form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector)!.value.trim();
  switch (form.dataset.form) {

    case 'create-task': {
      const owner = inputValue('#task-owner');
      const fields = Array.from(form.querySelectorAll<HTMLElement>('[data-draft]')).map(el => el.dataset.draft!);
      void requestAction({ type: 'create_task', title: inputValue('#task-title'), description: inputValue('#task-description'), departmentId: inputValue('#task-department') as DepartmentId, ...(owner ? { agentId: owner } : {}), priority: inputValue('#task-priority') as Priority, dependsOn: Array.from(form.querySelector<HTMLSelectElement>('#task-dependencies')!.selectedOptions).map(option => option.value), requiresDirection: form.querySelector<HTMLInputElement>('#task-direction')!.checked }, fields);
      break;
    }
    case 'preview': {
      const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
      void requestAction({ type: 'set_task_preview', taskId: form.dataset.id!, html: field.value.trim() || null }, [field.dataset.draft!]);
      filePreview = null;
      break;
    }

    case 'company': void requestAction({ type: 'rename_company', name: inputValue('#company-name') }, ['company-name']); break;
    case 'mission': {
      const field = form.querySelector<HTMLTextAreaElement>('textarea')!;
      void requestAction({ type: 'set_mission', mission: field.value.trim() }, ['settings-mission', 'modal-mission']);
      break;
    }
    case 'repository': void requestAction({ type: 'connect_repo', path: inputValue('#repo-path') }, ['repo-path']); break;
    case 'decision': void requestAction({ type: 'resolve_decision', decisionId: form.dataset.id!, answer: inputValue('textarea') }, [`direction-${form.dataset.id}`]); break;
    case 'message': void requestAction({ type: 'send_message', text: inputValue('#founder-message') }, ['founder-message']); break;
    case 'runtime': void requestAction({ type: 'set_config', config: { autoInspect: form.querySelector<HTMLInputElement>('#auto-inspect')!.checked, allowProviderRuns: form.querySelector<HTMLInputElement>('#provider-runs')!.checked, cycleSeconds: Number(inputValue('#cycle-seconds')) } }, ['auto-inspect', 'provider-runs', 'cycle-seconds']); break;
    case 'agent': {
      const inputs = Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-draft]'));
      const field = (suffix: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => inputs.find(el => el.id.endsWith('-' + suffix))!;
      const agentId = form.dataset.id;
      const clear = inputs.map(el => el.dataset.draft!);
      const action: WorkspaceAction = agentId ? { type: 'update_agent', agentId, name: field('name').value.trim(), role: field('role').value.trim(), provider: field('provider').value as ProviderId, enabled: (field('enabled') as HTMLInputElement).checked } : { type: 'add_agent', name: field('name').value.trim(), role: field('role').value.trim(), provider: field('provider').value as ProviderId, departmentId: field('department').value as DepartmentId };
      void requestAction(action, clear);
      break;
    }
  }
});


async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? 'The requested record is unavailable.');
  return payload;
}

async function loadHistory(): Promise<void> {
  if (historyLoading) return;
  historyLoading = true; historyError = ''; render();
  try { history = await getJson<HistoryResponse>('/api/history'); }
  catch (error) { historyError = error instanceof Error ? error.message : 'Could not load recorded checkpoints.'; }
  historyLoading = false; render();
}

async function selectCheckpoint(id: string): Promise<void> {
  if (!id) return;
  const request = ++historyRequest;
  historyLoadingId = id; modal = null; navOpen = false; render();
  try {
    const entry = await getJson<HistoryCheckpoint>(`/api/history/${encodeURIComponent(id)}`);
    if (request !== historyRequest) return;
    assertState(entry.snapshot);
    checkpoint = entry; state = entry.snapshot;
    selectedFilePath = null; filePreview = null;
    if (selectedMissionTask && !state.tasks.some(t => t.id === selectedMissionTask)) selectedMissionTask = null;
  } catch (error) {
    if (request !== historyRequest) return;
    toast(error instanceof Error ? error.message : 'Could not open the recorded checkpoint.', true);
  }
  if (request === historyRequest) { historyLoadingId = null; render(); }
}

function returnToLive(): void {
  historyRequest += 1; historyLoadingId = null; checkpoint = null;
  state = liveState; modal = null; selectedFilePath = null; filePreview = null;
  render();
}

async function loadTaskFiles(task: Task): Promise<void> {
  if (replaying()) return;
  const key = taskKey(task);
  fileInventories.set(key, { loading: true }); selectedFilePath = null; render();
  try {
    const response = await getJson<TaskFilesResponse>(`/api/tasks/${encodeURIComponent(task.id)}/files`);
    fileInventories.set(key, { loading: false, response });
  } catch (error) { fileInventories.set(key, { loading: false, error: error instanceof Error ? error.message : 'Could not inspect this task worktree.' }); }
  if (!replaying() && modal?.kind === 'task' && modal.id === task.id && workbenchTab === 'files') render();
}

async function loadTaskFile(task: Task, path: string): Promise<void> {
  if (replaying()) return;
  const key = taskKey(task);
  selectedFilePath = path; fileContents.set(key + ':' + path, { loading: true }); render();
  try {
    const response = await getJson<TaskFileResponse>(`/api/tasks/${encodeURIComponent(task.id)}/file?path=${encodeURIComponent(path)}`);
    fileContents.set(key + ':' + path, { loading: false, response });
  } catch (error) { fileContents.set(key + ':' + path, { loading: false, error: error instanceof Error ? error.message : 'Could not read this changed file.' }); }
  if (!replaying() && modal?.kind === 'task' && modal.id === task.id && workbenchTab === 'files') render();
}

async function exportTemplate(): Promise<void> {
  try {
    const response = await fetch('/api/template');
    if (!response.ok) throw new Error('Could not export the team template.');
    const template: unknown = await response.json();
    const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'startup-team-template.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Team template downloaded.');
  } catch (error) { toast(error instanceof Error ? error.message : 'Export failed.', true); }
}
async function importTemplate(file: File): Promise<void> {
  try {
    if (file.size > 1_000_000) throw new Error('Choose a team template smaller than 1 MB.');
    const template = JSON.parse(await file.text());
    if (template?.schemaVersion !== 1 || !Array.isArray(template.agents)) throw new Error('This file is not a supported team template.');
    await requestAction({ type: 'import_template', template });
  } catch (error) { toast(error instanceof SyntaxError ? 'This file is not valid JSON.' : error instanceof Error ? error.message : 'Import failed.', true); }
}


app.addEventListener('keydown', event => {
  const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-workbench-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = Array.from(app.querySelectorAll<HTMLButtonElement>('[data-workbench-tab]'));
  const index = tabs.indexOf(tab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length;
  const id = tabs[next]!.id;
  tabs[next]!.click(); document.getElementById(id)?.focus();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navOpen && !modal) { navOpen = false; render(); document.getElementById('mobile-nav')?.focus(); }
});
matchMedia('(max-width: 800px)').addEventListener('change', () => { navOpen = false; render(); });
window.addEventListener('pagehide', disposeOffice);
window.addEventListener('pageshow', event => { if (event.persisted && view === 'office') render(); });

const stream = new EventSource('/api/events');
stream.addEventListener('open', () => { connection = 'connected'; if (!app.querySelector('iframe[data-testid=task-app-preview]')) render(); });
stream.addEventListener('error', () => { connection = 'reconnecting'; if (!app.querySelector('iframe[data-testid=task-app-preview]')) render(); });
stream.addEventListener('state', event => {
  try {
    const oldTask = modal?.kind === 'task' ? state?.tasks.find(task => task.id === (modal as { id: string }).id) : undefined;
    liveState = assertState(JSON.parse((event as MessageEvent<string>).data));
    if (!checkpoint) state = liveState;
    loadError = '';
    if (checkpoint) return;
    const currentTask = oldTask ? state!.tasks.find(task => task.id === oldTask.id) : undefined;
    if (workbenchTab === 'preview' && app.querySelector('iframe[data-testid=task-app-preview]') && currentTask && oldTask && currentTask.preview?.html === oldTask.preview?.html && currentTask.preview?.updatedAt === oldTask.preview?.updatedAt) return;
    render();
  } catch { toast('A workspace update could not be read. Refresh to reconnect.', true); }
});
void load();
