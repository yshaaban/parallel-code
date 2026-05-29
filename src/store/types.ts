import type { AgentDef, DiscoveredProject } from '../ipc/types.js';
import type {
  AgentSupervisionSnapshot,
  PeerPresenceSnapshot,
  RemoteAccessStatus,
  RemoteAgentStatus,
  TaskPortSnapshot,
  WorktreeStatus,
} from '../domain/server-state.js';
import type { TaskConvergenceSnapshot } from '../domain/task-convergence.js';
import type { ProjectContainerConfig } from '../domain/task-containers.js';
import type { AgentRunnerProfileConfig } from '../domain/agent-runners.js';
import type { TaskStepsSnapshot, TaskStepsSummarySnapshot } from '../domain/task-steps.js';
import type { TaskReviewSnapshot } from '../domain/task-review.js';
import type { TaskReviewSignalsSnapshot } from '../domain/task-review-signals.js';
import type { MarkdownViewerState } from '../domain/markdown-viewer-state.js';
import type { TerminalFont } from '../lib/font-types.js';
import type { HydraStartupMode } from '../lib/hydra.js';
import type { LookPreset } from '../lib/look.js';
import type { PersistedKeybindingOverrides } from '../domain/keybindings.js';

export type TaskGitIsolationMode = 'worktree' | 'current-branch' | 'existing-worktree';
export type DefaultTaskGitIsolationMode = Exclude<TaskGitIsolationMode, 'existing-worktree'>;
export type ProjectMode = 'git' | 'non-git';
export type WorktreeOwnership = 'managed' | 'external';

export interface TerminalBookmark {
  id: string;
  command: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  baseBranch?: string;
  branchPrefix?: string; // default "task" if unset
  agentRunnerConfig?: AgentRunnerProfileConfig;
  containerConfig?: ProjectContainerConfig;
  defaultTaskGitIsolation?: DefaultTaskGitIsolationMode;
  deleteBranchOnClose?: boolean; // default true if unset
  defaultDirectMode?: boolean; // default false if unset
  projectMode?: ProjectMode; // default "git" if unset
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
  terminalSessionVersion?: number;
}

export type TaskCloseState =
  | { kind: 'closing' }
  | { kind: 'removing' }
  | { kind: 'error'; message: string };

export interface Task {
  id: string;
  name: string;
  projectId: string;
  branchName: string;
  worktreePath: string;
  agentIds: string[];
  selectedAgentId?: string;
  terminalLayoutMode?: TaskTerminalLayoutMode;
  shellAgentIds: string[];
  notes: string;
  lastPrompt: string;
  initialPrompt?: string; // auto-sends when agent is ready
  savedInitialPrompt?: string;
  prefillPrompt?: string; // fills prompt input without sending
  baseBranch?: string;
  closeState?: TaskCloseState;
  gitIsolation?: TaskGitIsolationMode;
  projectMode?: ProjectMode;
  worktreeOwnership?: WorktreeOwnership;
  directMode?: boolean;
  skipPermissions?: boolean;
  githubUrl?: string;
  collapsed?: boolean;
  savedAgentDef?: AgentDef;
  savedAgentDefs?: AgentDef[];
  planContent?: string;
  planFileName?: string;
  planRelativePath?: string;
  stepsTracking?: boolean;
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
  agentIds?: string[];
  agentDefs?: AgentDef[];
  selectedAgentId?: string;
  terminalLayoutMode?: TaskTerminalLayoutMode;
  shellAgentIds?: string[];
  agentDef: AgentDef | null;
  baseBranch?: string;
  gitIsolation?: TaskGitIsolationMode;
  projectMode?: ProjectMode;
  worktreeOwnership?: WorktreeOwnership;
  directMode?: boolean;
  skipPermissions?: boolean;
  githubUrl?: string;
  savedInitialPrompt?: string;
  planFileName?: string;
  planRelativePath?: string;
  stepsTracking?: boolean;
  collapsed?: boolean;
  exposedPorts?: PersistedTaskExposedPort[];
}

export interface PersistedTaskExposedPort {
  host?: string | null;
  label?: string | null;
  port: number;
  protocol?: 'http' | 'https';
  source?: 'manual' | 'observed';
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

export type SidebarSectionKey = 'projects' | 'progress' | 'sessions' | 'tips';

export type TaskTerminalLayoutMode = 'focused' | 'split' | 'grid' | 'stacked';

export interface SidebarSectionCollapsedState {
  projects: boolean;
  progress: boolean;
  sessions: boolean;
  tips: boolean;
}

export interface PersistedState {
  projects: Project[];
  lastProjectId: string | null;
  lastAgentId: string | null;
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask>;
  terminals?: Record<string, PersistedTerminal>;
  activeTaskId?: string | null;
  sidebarVisible?: boolean;
  fontScales?: Record<string, number>;
  panelSizes?: Record<string, number>;
  globalScale?: number;
  completedTaskDate?: string;
  completedTaskCount?: number;
  mergedLinesAdded?: number;
  mergedLinesRemoved?: number;
  terminalFontSize?: number;
  terminalFont?: TerminalFont;
  fontSmoothing?: boolean;
  themePreset?: LookPreset;
  windowState?: PersistedWindowState;
  autoTrustFolders?: boolean;
  sidebarSectionCollapsed?: SidebarSectionCollapsedState;
  showPlans?: boolean;
  terminalHighLoadMode?: boolean;
  taskNotificationsEnabled?: boolean;
  taskNotificationsPreferenceInitialized?: boolean;
  desktopNotificationsEnabled?: boolean;
  verboseLogging?: boolean;
  inactiveColumnOpacity?: number;
  hasSeenDesktopIntro?: boolean;
  editorCommand?: string;
  hydraCommand?: string;
  hydraForceDispatchFromPromptPanel?: boolean;
  hydraStartupMode?: HydraStartupMode;
  keybindings?: PersistedKeybindingOverrides;
  customAgents?: AgentDef[];
}

export interface WorkspaceSharedState {
  projects: Project[];
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask>;
  terminals?: Record<string, PersistedTerminal>;
  completedTaskDate?: string;
  completedTaskCount?: number;
  mergedLinesAdded?: number;
  mergedLinesRemoved?: number;
  hydraCommand?: string;
  hydraForceDispatchFromPromptPanel?: boolean;
  hydraStartupMode?: HydraStartupMode;
  customAgents?: AgentDef[];
}

export interface ClientSessionTerminalPanels {
  taskOrder: string[];
  collapsedTaskOrder?: string[];
  terminals: Record<string, PersistedTerminal>;
}

export interface ClientSessionState {
  activeAgentId?: string | null;
  activeTaskId?: string | null;
  editorCommand?: string;
  focusedPanel?: Record<string, PanelId>;
  fontScales?: Record<string, number>;
  globalScale?: number;
  inactiveColumnOpacity?: number;
  lastAgentId?: string | null;
  lastProjectId?: string | null;
  panelSizes?: Record<string, number>;
  placeholderFocused?: boolean;
  placeholderFocusedButton?: 'add-task' | 'add-terminal';
  sidebarSectionCollapsed?: SidebarSectionCollapsedState;
  showPlans?: boolean;
  terminalHighLoadMode?: boolean;
  taskNotificationsEnabled?: boolean;
  taskNotificationsPreferenceInitialized?: boolean;
  verboseLogging?: boolean;
  terminalPanels?: ClientSessionTerminalPanels;
  sidebarFocused?: boolean;
  sidebarFocusedProjectId?: string | null;
  sidebarFocusedTaskId?: string | null;
  sidebarVisible?: boolean;
  terminalFontSize?: number;
  terminalFont?: TerminalFont;
  fontSmoothing?: boolean;
  themePreset?: LookPreset;
  windowState?: PersistedWindowState | null;
  keybindings?: PersistedKeybindingOverrides;
}

export type PersistedProjectLookup = Partial<
  Pick<Project, 'baseBranch' | 'defaultTaskGitIsolation' | 'id' | 'path' | 'projectMode'>
>;
export type PersistedTaskLookup = Partial<
  Pick<
    PersistedTask,
    | 'baseBranch'
    | 'branchName'
    | 'gitIsolation'
    | 'id'
    | 'name'
    | 'projectId'
    | 'projectMode'
    | 'githubUrl'
    | 'worktreeOwnership'
    | 'worktreePath'
  >
>;

export interface PersistedTaskLookupState {
  projects?: PersistedProjectLookup[];
  tasks?: Record<string, PersistedTaskLookup>;
}

// Panel cell IDs. Shell terminals use "shell:0", "shell:1", etc.
// Shell toolbar buttons use "shell-toolbar:0", "shell-toolbar:1", etc.
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

export const REVIEW_DIFF_MODES = ['all', 'staged', 'unstaged', 'branch'] as const;

export type ReviewDiffMode = (typeof REVIEW_DIFF_MODES)[number];

export function isReviewDiffMode(value: string): value is ReviewDiffMode {
  return REVIEW_DIFF_MODES.some((mode) => mode === value);
}

export interface TaskCommandController {
  action: string | null;
  controllerId: string;
  version: number;
}

export interface IncomingTaskTakeoverRequest {
  action: string;
  expiresAt: number;
  requestId: string;
  requesterClientId: string;
  requesterDisplayName: string;
  taskId: string;
}

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
  incomingTaskTakeoverRequests: Record<string, IncomingTaskTakeoverRequest>;
  peerSessions: Record<string, PeerPresenceSnapshot>;
  taskCommandControllers: Record<string, TaskCommandController>;
  availableAgents: AgentDef[];
  customAgents: AgentDef[];
  showNewTaskDialog: boolean;
  showAddProjectDialog: boolean;
  discoveredProjects: DiscoveredProject[];
  sidebarVisible: boolean;
  fontScales: Record<string, number>;
  panelSizes: Record<string, number>;
  globalScale: number;
  taskGitStatus: Record<string, WorktreeStatus>;
  taskPorts: Record<string, TaskPortSnapshot>;
  taskConvergence: Record<string, TaskConvergenceSnapshot>;
  taskReview: Record<string, TaskReviewSnapshot>;
  taskReviewSignals: Record<string, TaskReviewSignalsSnapshot>;
  taskSteps: Record<string, TaskStepsSnapshot>;
  taskStepSummaries: Record<string, TaskStepsSummarySnapshot>;
  focusedPanel: Record<string, PanelId>;
  sidebarFocused: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  placeholderFocused: boolean;
  placeholderFocusedButton: 'add-task' | 'add-terminal';
  sidebarSectionCollapsed: SidebarSectionCollapsedState;
  showHelpDialog: boolean;
  showSettingsDialog: boolean;
  markdownViewer: MarkdownViewerState | null;
  hasSeenDesktopIntro: boolean;
  pendingAction: PendingAction | null;
  notification: string | null;
  completedTaskDate: string;
  completedTaskCount: number;
  mergedLinesAdded: number;
  mergedLinesRemoved: number;
  terminalFontSize: number;
  terminalFont: TerminalFont;
  fontSmoothing: boolean;
  themePreset: LookPreset;
  windowState: PersistedWindowState | null;
  autoTrustFolders: boolean;
  showPlans: boolean;
  terminalHighLoadMode: boolean;
  taskNotificationsEnabled: boolean;
  taskNotificationsPreferenceInitialized: boolean;
  verboseLogging: boolean;
  inactiveColumnOpacity: number;
  editorCommand: string;
  hydraCommand: string;
  hydraForceDispatchFromPromptPanel: boolean;
  hydraStartupMode: HydraStartupMode;
  keybindings: PersistedKeybindingOverrides;
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
