import type { AgentDef } from '../ipc/types';
import type {
  AgentSupervisionSnapshot,
  RemoteAccessStatus,
  RemoteAgentStatus,
  TaskPortSnapshot,
  WorktreeStatus,
} from '../domain/server-state';
import type { TaskConvergenceSnapshot } from '../domain/task-convergence';
import type { TaskReviewSnapshot } from '../domain/task-review';
import type { TerminalFont } from '../lib/fonts';
import type { HydraStartupMode } from '../lib/hydra';
import type { LookPreset } from '../lib/look';

export interface TerminalBookmark {
  id: string;
  command: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  branchPrefix?: string; // default "task" if unset
  deleteBranchOnClose?: boolean; // default true if unset
  defaultDirectMode?: boolean; // default false if unset
  terminalBookmarks?: TerminalBookmark[];
}

export type AgentStatus = RemoteAgentStatus;

export interface Agent {
  id: string;
  taskId: string;
  def: AgentDef;
  resumed: boolean;
  status: AgentStatus;
  exitCode: number | null;
  signal: string | null;
  lastOutput: string[];
  generation: number;
}

export interface Task {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  agentIds: string[];
  shellAgentIds: string[];
  notes: string;
  lastPrompt: string;
  initialPrompt?: string; // auto-sends when agent is ready
  savedInitialPrompt?: string;
  prefillPrompt?: string; // fills prompt input without sending
  closingStatus?: 'closing' | 'removing' | 'error';
  closingError?: string;
  directMode?: boolean;
  skipPermissions?: boolean;
  githubUrl?: string;
  collapsed?: boolean;
  savedAgentDef?: AgentDef;
  planContent?: string;
  planFileName?: string;
}

export interface Terminal {
  id: string;
  name: string;
  agentId: string;
  closingStatus?: 'closing' | 'removing';
}

export interface PersistedTask {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  notes: string;
  lastPrompt: string;
  shellCount: number;
  agentId?: string | null;
  shellAgentIds?: string[];
  agentDef: AgentDef | null;
  directMode?: boolean;
  skipPermissions?: boolean;
  githubUrl?: string;
  savedInitialPrompt?: string;
  collapsed?: boolean;
}

export interface PersistedTerminal {
  id: string;
  name: string;
  agentId?: string;
}

export interface PersistedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface PersistedState {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask>;
  terminals?: Record<string, PersistedTerminal>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  fontScales?: Record<string, number>;
  panelSizes?: Record<string, number>;
  globalScale?: number;
  completedTaskDate?: string;
  completedTaskCount?: number;
  mergedLinesAdded?: number;
  mergedLinesRemoved?: number;
  terminalFont?: TerminalFont;
  themePreset?: LookPreset;
  windowState?: PersistedWindowState;
  autoTrustFolders?: boolean;
  showPlans?: boolean;
  inactiveColumnOpacity?: number;
  editorCommand?: string;
  hydraCommand?: string;
  hydraForceDispatchFromPromptPanel?: boolean;
  hydraStartupMode?: HydraStartupMode;
  customAgents?: AgentDef[];
}

// Panel cell IDs. Shell terminals use "shell:0", "shell:1", etc.
// The shell toolbar is "shell-toolbar".
export type PanelId = string;

export interface PendingAction {
  type: 'close' | 'merge' | 'push';
  taskId: string;
}

export type RemoteAccess = RemoteAccessStatus;

// --- Permission approval types ---

export interface PermissionRequest {
  id: string;
  agentId: string;
  taskId: string;
  tool: string;
  description: string;
  arguments: string;
  detectedAt: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  resolvedAt?: number;
  autoApproved?: boolean;
}

export interface PermissionAutoRule {
  tool: string; // "*" for all, or specific tool name
  taskId?: string; // scope to task, or global if omitted
  action: 'approve' | 'deny';
}

// --- Diff comment / review types ---

export interface DiffLineAnchor {
  filePath: string;
  hunkKey: string;
  side: 'old' | 'new' | 'unified';
  startLine: number;
  endLine: number;
  diffKind: 'add' | 'delete' | 'context';
}

export interface DiffComment {
  id: string;
  taskId: string;
  agentId: string;
  anchor: DiffLineAnchor;
  text: string;
  status: 'draft' | 'sent' | 'stale';
  createdAt: number;
  sentAt?: number;
}

export type ReviewDiffMode = 'all' | 'staged' | 'unstaged' | 'branch';

export interface AppStore {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  collapsedTaskOrder: string[];
  tasks: Record<string, Task>;
  terminals: Record<string, Terminal>;
  agents: Record<string, Agent>;
  agentSupervision: Record<string, AgentSupervisionSnapshot>;
  agentActive: Record<string, boolean>;
  activeTaskId: string | null;
  activeAgentId: string | null;
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
  showNewTaskDialog: boolean;
  sidebarVisible: boolean;
  fontScales: Record<string, number>;
  panelSizes: Record<string, number>;
  globalScale: number;
  taskGitStatus: Record<string, WorktreeStatus>;
  taskPorts: Record<string, TaskPortSnapshot>;
  taskConvergence: Record<string, TaskConvergenceSnapshot>;
  taskReview: Record<string, TaskReviewSnapshot>;
  focusedPanel: Record<string, PanelId>;
  sidebarFocused: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  placeholderFocused: boolean;
  placeholderFocusedButton: 'add-task' | 'add-terminal';
  showHelpDialog: boolean;
  showSettingsDialog: boolean;
  pendingAction: PendingAction | null;
  notification: string | null;
  completedTaskDate: string;
  completedTaskCount: number;
  mergedLinesAdded: number;
  mergedLinesRemoved: number;
  terminalFont: TerminalFont;
  themePreset: LookPreset;
  windowState: PersistedWindowState | null;
  autoTrustFolders: boolean;
  showPlans: boolean;
  inactiveColumnOpacity: number;
  editorCommand: string;
  hydraCommand: string;
  hydraForceDispatchFromPromptPanel: boolean;
  hydraStartupMode: HydraStartupMode;
  newTaskDropUrl: string | null;
  newTaskPrefillPrompt: { prompt: string; projectId: string | null } | null;
  missingProjectIds: Record<string, true>;
  remoteAccess: RemoteAccess;
  showArena: boolean;

  // Permission approvals
  permissionRequests: Record<string, PermissionRequest[]>; // keyed by agentId
  permissionAutoRules: PermissionAutoRule[];

  // Review comments
  reviewComments: Record<string, DiffComment[]>; // keyed by taskId
  reviewPanelOpen: Record<string, boolean>; // keyed by taskId
}
