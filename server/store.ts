import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryCheckpoint, HistoryEntry, TaskStatus, WorkspaceState } from '../src/lib/types.ts';
import { createState } from './seed.ts';

export interface PersistedWorkspace {
  schemaVersion: 1;
  activeMode: 'demo' | 'live';
  demo: WorkspaceState;
  live: WorkspaceState;
  findingTaskIds: Record<string, string>;
  dismissedFindingKeys: string[];
  pausedFrom: Record<string, TaskStatus>;
  unstartedTaskIds?: string[];
  history?: Record<'demo' | 'live', { checkpoints: HistoryCheckpoint[]; droppedCount: number }>;
}

export const HISTORY_RETAINED_LIMIT = 80;
export const HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const CHECKPOINT_BYTE_LIMIT = 1024 * 1024;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Historical snippets are deliberately bounded. The current workspace is never clipped. */
export function createCheckpoint(state: WorkspaceState, entry: HistoryEntry): HistoryCheckpoint {
  const snapshot = structuredClone(state), limitations = [...entry.limitations];
  const clipped = new Set<string>();
  const snippet = (text: string, maximum: number, label: string): string => {
    if (text.length <= maximum) return text;
    clipped.add(label); return `${text.slice(0, maximum)}\n[Historical excerpt clipped; current workspace may contain more.]`;
  };
  for (const task of snapshot.tasks) {
    task.artifact = snippet(task.artifact, 8192, 'task output');
    if (task.evidence.length > 32) { clipped.add('evidence records'); task.evidence = task.evidence.slice(-32); }
    for (const evidence of task.evidence) evidence.detail = snippet(evidence.detail, 2048, 'evidence detail');
    if (task.preview && task.preview.html.length > 16384) { delete task.preview; clipped.add('large HTML previews'); }
  }
  if (snapshot.messages.length > 80) { snapshot.messages = snapshot.messages.slice(-80); clipped.add('older conversation messages'); }
  if (snapshot.activity.length > 80) { snapshot.activity = snapshot.activity.slice(0, 80); clipped.add('older activity records'); }
  for (const message of snapshot.messages) message.text = snippet(message.text, 4000, 'conversation text');
  for (const activity of snapshot.activity) activity.detail = snippet(activity.detail, 4000, 'activity detail');
  const checkpoint: HistoryCheckpoint = { ...entry, limitations, snapshot };
  if (bytes(checkpoint) > CHECKPOINT_BYTE_LIMIT) {
    for (const task of snapshot.tasks) {
      task.description = snippet(task.description, 512, 'task descriptions'); task.artifact = snippet(task.artifact, 1024, 'task output');
      if (task.evidence.length > 4) { task.evidence = task.evidence.slice(-4); clipped.add('evidence records'); }
      for (const evidence of task.evidence) evidence.detail = snippet(evidence.detail, 512, 'evidence detail');
      if (task.preview) { delete task.preview; clipped.add('HTML previews'); }
    }
    for (const decision of snapshot.decisions) { decision.context = snippet(decision.context, 1024, 'decision context'); if (decision.answer) decision.answer = snippet(decision.answer, 1024, 'direction answers'); }
    snapshot.messages = snapshot.messages.slice(-20); snapshot.activity = snapshot.activity.slice(0, 20); clipped.add('older conversation and activity records');
  }
  // Even unusually large workspaces retain their changed records first. Omission is explicit.
  if (bytes(checkpoint) > CHECKPOINT_BYTE_LIMIT) {
    const focused = new Set(entry.taskIds);
    snapshot.tasks.sort((a, b) => Number(focused.has(b.id)) - Number(focused.has(a.id)));
    while (snapshot.tasks.length > 1 && bytes(checkpoint) > CHECKPOINT_BYTE_LIMIT) { snapshot.tasks.pop(); clipped.add('task records outside the retained snapshot budget'); }
    const decisions = new Set(entry.decisionIds);
    snapshot.decisions.sort((a, b) => Number(decisions.has(b.id)) - Number(decisions.has(a.id)));
    while (snapshot.decisions.length > 1 && bytes(checkpoint) > CHECKPOINT_BYTE_LIMIT) { snapshot.decisions.pop(); clipped.add('decision records outside the retained snapshot budget'); }
  }
  if (clipped.size) limitations.push(`Historical snapshot contains excerpts or omissions: ${[...clipped].join(', ')}. It is not a complete archive of files, outputs, or verification evidence.`);
  return checkpoint;
}

export function appendCheckpoint(data: PersistedWorkspace, mode: 'demo' | 'live', checkpoint: HistoryCheckpoint): void {
  data.history ??= { demo: { checkpoints: [], droppedCount: 0 }, live: { checkpoints: [], droppedCount: 0 } };
  const archive = data.history[mode]; archive.checkpoints.unshift(checkpoint);
  while (archive.checkpoints.length > HISTORY_RETAINED_LIMIT || bytes(archive) > HISTORY_BYTE_LIMIT) {
    archive.checkpoints.pop(); archive.droppedCount++;
  }
}

export function freshWorkspace(): PersistedWorkspace {
  return { schemaVersion: 1, activeMode: 'demo', demo: createState('demo'), live: createState('live'), findingTaskIds: {}, dismissedFindingKeys: [], pausedFrom: {} };
}

export class WorkspaceStore {
  readonly filePath: string;
  constructor(readonly directory: string) { this.filePath = join(directory, 'workspace.json'); }

  async load(): Promise<PersistedWorkspace> {
    try {
      const data: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!data || typeof data !== 'object') throw new Error('Invalid saved workspace');
      const value = data as PersistedWorkspace;
      if (value.schemaVersion !== 1 || !['demo', 'live'].includes(value.activeMode) || value.demo?.mode !== 'demo' || value.live?.mode !== 'live' || !Array.isArray(value.demo.tasks) || !Array.isArray(value.live.tasks) || !value.findingTaskIds || !Array.isArray(value.dismissedFindingKeys) || !value.pausedFrom) throw new Error('Unsupported or invalid saved workspace. The original state has been left intact.');
      if (value.history) for (const mode of ['demo', 'live'] as const) {
        const history = value.history[mode];
        if (!history || !Array.isArray(history.checkpoints) || !Number.isInteger(history.droppedCount) || history.droppedCount < 0 || history.checkpoints.some((item) => !item || typeof item.id !== 'string' || item.snapshot?.mode !== mode || !Array.isArray(item.limitations))) throw new Error('Invalid saved checkpoint history. The original state has been left intact.');
        while (history.checkpoints.length > HISTORY_RETAINED_LIMIT || bytes(history) > HISTORY_BYTE_LIMIT) { history.checkpoints.pop(); history.droppedCount++; }
      }
      if (value.unstartedTaskIds !== undefined && (!Array.isArray(value.unstartedTaskIds) || value.unstartedTaskIds.some((id) => typeof id !== 'string'))) throw new Error('Invalid saved task authoring state. The original state has been left intact.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return freshWorkspace();
      throw error;
    }
  }

  async save(value: PersistedWorkspace): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.workspace-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.filePath);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
