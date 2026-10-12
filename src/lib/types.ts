export type DepartmentId = 'product' | 'design' | 'engineering' | 'marketing' | 'sales' | 'support' | 'operations';
export type ProviderId = 'claude' | 'codex';
export type TaskStatus = 'proposed' | 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'paused' | 'dismissed' | 'failed';
export type Priority = 'high' | 'medium' | 'low';
export type TaskStage = 'idea' | 'design' | 'build' | 'verify' | 'launch' | 'support' | 'operations';

export interface Department {
  id: DepartmentId;
  name: string;
  description: string;
  color: string;
  icon: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  departmentId: DepartmentId;
  provider: ProviderId;
  enabled: boolean;
}

export interface Evidence {
  id: string;
  label: string;
  detail: string;
  kind: 'file' | 'command' | 'report' | 'diff';
  source: 'sample' | 'observed' | 'agent';
  recordedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  departmentId: DepartmentId;
  agentId: string | null;
  status: TaskStatus;
  priority: Priority;
  source: 'sample' | 'repo' | 'founder';
  runType: 'sample' | 'audit' | 'cli';
  missionRevision: number;
  dependsOn: string[];
  handoff?: 'delivery' | 'acceptance';
  stage?: TaskStage;
  preview?: { html: string; source: 'sample' | 'founder'; updatedAt: string };
  requiresDirection: boolean;
  evidence: Evidence[];
  artifact: string;
  workspacePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
}

export interface Decision {
  id: string;
  title: string;
  context: string;
  departmentId: DepartmentId;
  options: DecisionOption[];
  recommendationId: string | null;
  taskIds: string[];
  status: 'open' | 'resolved';
  answer: string | null;
  source: 'sample' | 'repo' | 'founder';
  createdAt: string;
  answeredAt: string | null;
}

export interface Message {
  id: string;
  author: string;
  role: 'founder' | 'agent' | 'system';
  text: string;
  taskId: string | null;
  source: 'sample' | 'live';
  createdAt: string;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  departmentId: DepartmentId | null;
  source: 'sample' | 'live';
  createdAt: string;
}

export interface ProviderStatus {
  id: ProviderId;
  installed: boolean;
  authenticated: boolean | null;
  detail: string;
  checkedAt: string;
}

export interface RuntimeConfig {
  paused: boolean;
  autoInspect: boolean;
  allowProviderRuns: boolean;
  cycleSeconds: number;
}

export interface WorkspaceState {
  schemaVersion: 1;
  mode: 'demo' | 'live';
  company: {
    name: string;
    mission: string;
    missionRevision: number;
    repoPath: string | null;
  };
  departments: Department[];
  agents: Agent[];
  tasks: Task[];
  decisions: Decision[];
  messages: Message[];
  activity: Activity[];
  providers: ProviderStatus[];
  config: RuntimeConfig;
  runtime: {
    status: 'paused' | 'working' | 'scheduled' | 'waiting' | 'interrupted';
    lastCycleAt: string | null;
    nextCycleAt: string | null;
    activeTaskId: string | null;
    error: string | null;
  };
}

export interface TeamTemplate {
  schemaVersion: 1;
  name: string;
  mission: string;
  agents: Omit<Agent, 'id'>[];
}

export interface HistoryEntry {
  id: string;
  recordedAt: string;
  kind: string;
  title: string;
  detail: string;
  source: 'sample' | 'live';
  taskIds: string[];
  decisionIds: string[];
  missionRevision: number;
  limitations: string[];
}

export interface HistoryCheckpoint extends HistoryEntry {
  snapshot: WorkspaceState;
}

export interface HistoryResponse {
  entries: HistoryEntry[];
  retainedLimit: number;
  droppedCount: number;
}

export interface TaskFile {
  path: string;
  status: 'modified' | 'added' | 'deleted';
  previewable: boolean;
}

export interface TaskFilesResponse {
  taskId: string;
  files: TaskFile[];
  truncated: boolean;
}

export interface TaskFileResponse {
  taskId: string;
  path: string;
  content: string;
  language: string;
  truncated: boolean;
}

export type WorkspaceAction =
  | { type: 'set_mission'; mission: string }
  | { type: 'rename_company'; name: string }
  | { type: 'connect_repo'; path: string; mission?: string }
  | { type: 'set_mode'; mode: 'demo' | 'live' }
  | { type: 'reset_demo' }
  | { type: 'set_config'; config: Partial<RuntimeConfig> }
  | { type: 'resolve_decision'; decisionId: string; optionId?: string; answer?: string }
  | { type: 'task_action'; taskId: string; action: 'start' | 'pause' | 'resume' | 'dismiss' | 'accept' }
  | { type: 'create_task'; title: string; description: string; departmentId: DepartmentId; agentId?: string; priority?: Priority; dependsOn?: string[]; requiresDirection?: boolean }
  | { type: 'set_task_preview'; taskId: string; html: string | null }
  | { type: 'send_message'; text: string }
  | { type: 'update_agent'; agentId: string; provider?: ProviderId; role?: string; name?: string; enabled?: boolean }
  | { type: 'add_agent'; name: string; role: string; departmentId: DepartmentId; provider: ProviderId }
  | { type: 'inspect_repo' }
  | { type: 'run_demo_cycle' }
  | { type: 'import_template'; template: TeamTemplate };

export interface ActionResponse {
  state: WorkspaceState;
  notice?: string;
}
