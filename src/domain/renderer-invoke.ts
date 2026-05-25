import { IPC } from '../../electron/ipc/channels.js';
import type { BackendRuntimeDiagnosticsSnapshot } from '../../electron/ipc/runtime-diagnostics.js';
import type { AgentDef } from '../ipc/types.js';
import type { BrowserColdBootstrapProjection } from './browser-cold-bootstrap.js';
import type {
  ChangedFile,
  ArenaCompetitorInspectResult,
  CreateArenaWorktreeResult,
  CreateTaskResult,
  FileDiffResult,
  GitBranchListResult,
  ImportableWorktree,
  MergeResult,
  MergeStatus,
  ProjectDiffResult,
  ScrollbackBatchEntry,
  TerminalRecoveryBatchEntry,
  TerminalRecoveryRequestEntry,
  TerminalStartupRecoveryRequestEntry,
} from '../ipc/types.js';
import type { ProjectMode, ReviewDiffMode, TaskGitIsolationMode } from '../store/types.js';
import type { AskAboutCodeMessage, AskAboutCodeProviderId } from './ask-about-code.js';
import type { AppUpdateStatus } from './app-update.js';
import type { AgentRunnerProfileConfig } from './agent-runners.js';
import type { BranchCommitHistoryResult } from './review-commit-history.js';
import type { AnyServerStateBootstrapSnapshot } from './server-state-bootstrap.js';
import type {
  AgentSupervisionSnapshot,
  PauseReason,
  RemoteAccessStatus,
  TaskCommandControllerSnapshot,
  TaskPortExposureCandidate,
  TaskPortSnapshot,
  WorktreeStatus,
} from './server-state.js';
import type {
  ProjectContainerConfig,
  TaskContainerInspectResult,
  TaskContainerLogsResult,
} from './task-containers.js';
import type { TaskConvergenceSnapshot } from './task-convergence.js';
import type { TaskReviewSignalsSnapshot } from './task-review-signals.js';
import type { TaskStepsSnapshot } from './task-steps.js';
import type { TaskNotificationRequest } from './task-notification.js';
import type { TerminalInputTraceMessage } from './terminal-input-tracing.js';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  height: number;
  width: number;
}

export interface RemoteAccessStartResult {
  port: number;
  tailscaleUrl: string | null;
  token: string;
  url: string;
  wifiUrl: string | null;
}

export interface BrowserReconnectSnapshot {
  agentGenerations?: Record<string, number>;
  appStateJson: string | null;
  taskCommandControllers?: TaskCommandControllerSnapshot[];
  taskCommandControllerVersion?: number;
  workspaceRevision?: number;
  workspaceStateJson?: string | null;
  runningAgentIds: string[];
}

export interface BrowserReconnectStatus {
  runningAgentIds: string[];
  taskCommandControllerVersion?: number;
  workspaceRevision?: number;
}

export interface BrowserColdBootstrapSnapshot {
  serverStateBootstrap: AnyServerStateBootstrapSnapshot[];
  workspaceRevision?: number;
  workspaceProjection: BrowserColdBootstrapProjection;
}

export interface TaskCommandControllersResult {
  controllers: TaskCommandControllerSnapshot[];
  version: number;
}

export interface ChannelRef<TMessage = unknown> {
  __CHANNEL_ID__: string;
  // Preserve the message type at compile time without affecting runtime shape.
  __MESSAGE_TYPE__?: TMessage;
}

export type ChannelRefLike<TMessage = unknown> =
  | ChannelRef<TMessage>
  | {
      toJSON: () => ChannelRef<TMessage>;
    };

export interface RendererInvokeRequestMap {
  [IPC.SpawnAgent]: {
    adapter?: 'hydra';
    agentId: string;
    args: string[];
    baseBranch?: string;
    cols?: number;
    command?: string;
    controllerId?: string;
    cwd?: string;
    env?: Record<string, string>;
    isShell?: boolean;
    onOutput: ChannelRefLike<string>;
    projectMode?: ProjectMode;
    resumeOnStart?: boolean;
    runnerProfile?: AgentRunnerProfileConfig;
    rows?: number;
    taskId: string;
  };
  [IPC.DetachAgentOutput]: {
    agentId: string;
    channelId: string;
  };
  [IPC.WriteToAgent]: {
    agentId: string;
    controllerId?: string;
    data: string;
    inputEpoch?: string;
    inputSeq?: number;
    requestId?: string;
    taskId?: string;
    trace?: TerminalInputTraceMessage;
  };
  [IPC.ResizeAgent]: {
    agentId: string;
    cols: number;
    controllerId?: string;
    requestId?: string;
    resizeEpoch?: string;
    resizeSeq?: number;
    rows: number;
    taskId?: string;
  };
  [IPC.PauseAgent]: {
    agentId: string;
    channelId?: string;
    reason?: PauseReason;
  };
  [IPC.ResumeAgent]: {
    agentId: string;
    channelId?: string;
    reason?: PauseReason;
  };
  [IPC.KillAgent]: {
    agentId: string;
  };
  [IPC.GetAgentScrollback]: {
    agentId: string;
  };
  [IPC.GetScrollbackBatch]: {
    agentIds: string[];
  };
  [IPC.GetTerminalRecoveryBatch]: {
    requests: TerminalRecoveryRequestEntry[];
  };
  [IPC.GetTerminalStartupRecoveryBatch]: {
    requests: TerminalStartupRecoveryRequestEntry[];
  };
  [IPC.CountRunningAgents]: undefined;
  [IPC.KillAllAgents]: undefined;
  [IPC.ListAgents]:
    | {
        hydraCommand?: string;
      }
    | undefined;
  [IPC.GetAgentSupervision]: undefined;
  [IPC.ListRunningAgentIds]: undefined;
  [IPC.GetBackendRuntimeDiagnostics]: undefined;
  [IPC.ResetBackendRuntimeDiagnostics]: undefined;
  [IPC.GetBrowserColdBootstrap]: undefined;
  [IPC.GetBrowserReconnectStatus]: undefined;
  [IPC.GetBrowserReconnectSnapshot]: undefined;
  [IPC.GetNotificationCapability]: undefined;
  [IPC.ShowNotification]: TaskNotificationRequest;

  [IPC.CreateTask]: {
    agentDefId?: string;
    agentDefName?: string;
    baseBranch?: string;
    branchPrefix?: string;
    existingWorktreePath?: string;
    gitIsolation?: TaskGitIsolationMode;
    githubUrl?: string;
    name: string;
    projectMode?: ProjectMode;
    projectId: string;
    projectRoot: string;
    symlinkDirs: string[];
    stepsTracking?: boolean;
  };
  [IPC.DeleteTask]: {
    agentIds: string[];
    branchName: string;
    controllerId: string;
    deleteBranch: boolean;
    projectRoot: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.CleanupTaskRuntime]: {
    agentIds: string[];
    controllerId: string;
    projectMode?: ProjectMode;
    removeTaskState?: boolean;
    taskId: string;
    worktreePath?: string;
  };
  [IPC.AcquireTaskCommandLease]: {
    action: string;
    clientId: string;
    ownerId: string;
    takeover?: boolean;
    taskId: string;
  };
  [IPC.RenewTaskCommandLease]: {
    clientId: string;
    ownerId: string;
    leaseGeneration?: number;
    taskId: string;
  };
  [IPC.ReleaseTaskCommandLease]: {
    clientId: string;
    ownerId: string;
    leaseGeneration?: number;
    taskId: string;
  };
  [IPC.GetTaskCommandControllers]: undefined;
  [IPC.GetTaskPorts]: undefined;
  [IPC.GetTaskPortExposureCandidates]: {
    taskId: string;
    worktreePath: string;
  };
  [IPC.GetTaskConvergence]: undefined;
  [IPC.GetTaskReviewSignals]: undefined;
  [IPC.GetTaskStepsSnapshot]: {
    taskId: string;
  };
  [IPC.ContainersInspectTask]: {
    projectContainerConfig?: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.ContainersStartTask]: {
    projectContainerConfig?: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.ContainersStopTask]: {
    projectContainerConfig?: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.ContainersDestroyTask]: {
    projectContainerConfig?: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.ContainersGetTaskLogs]: {
    lines?: number;
    projectContainerConfig?: ProjectContainerConfig;
    projectPath: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.GetServerStateBootstrap]: undefined;
  [IPC.ExposePort]: {
    label?: string;
    port: number;
    taskId: string;
  };
  [IPC.RefreshTaskPortPreview]: {
    port: number;
    taskId: string;
  };
  [IPC.UnexposePort]: {
    port: number;
    taskId: string;
  };

  [IPC.GetChangedFiles]: {
    baseBranch?: string;
    worktreePath: string;
  };
  [IPC.GetChangedFilesFromBranch]: {
    baseBranch?: string;
    branchName: string;
    projectRoot: string;
  };
  [IPC.GetFileDiff]: {
    baseBranch?: string;
    filePath: string;
    status?: ChangedFile['status'];
    worktreePath: string;
  };
  [IPC.GetFileDiffFromBranch]: {
    baseBranch?: string;
    branchName: string;
    commitHash?: string;
    filePath: string;
    projectRoot: string;
    status?: ChangedFile['status'];
  };
  [IPC.GetAllFileDiffs]: {
    baseBranch?: string;
    worktreePath: string;
  };
  [IPC.GetAllFileDiffsFromBranch]: {
    baseBranch?: string;
    branchName: string;
    projectRoot: string;
  };
  [IPC.GetGitRepoRoot]: {
    path: string;
  };
  [IPC.GetGitignoredDirs]: {
    projectRoot: string;
  };
  [IPC.ListBranches]: {
    projectRoot: string;
  };
  [IPC.ListImportableWorktrees]: {
    baseBranch?: string;
    projectRoot: string;
    registeredWorktreePaths?: string[];
  };
  [IPC.GetWorktreeStatus]: {
    baseBranch?: string;
    worktreePath: string;
  };
  [IPC.CheckMergeStatus]: {
    baseBranch?: string;
    worktreePath: string;
  };
  [IPC.MergeTask]: {
    baseBranch?: string;
    branchName: string;
    cleanup?: boolean;
    controllerId: string;
    message?: string | null;
    projectRoot: string;
    squash: boolean;
    taskId: string;
    worktreePath: string;
  };
  [IPC.MergeArenaWorktree]: {
    baseBranch?: string;
    branchName: string;
    cleanup?: boolean;
    message?: string | null;
    projectRoot: string;
    squash: boolean;
    worktreePath: string;
  };
  [IPC.GetBranchLog]: {
    baseBranch?: string;
    worktreePath: string;
  };
  [IPC.GetBranchCommitHistory]: {
    baseBranch?: string;
    branchName: string;
    projectRoot: string;
  };
  [IPC.PushTask]: {
    branchName: string;
    controllerId: string;
    onOutput?: ChannelRefLike<string>;
    projectRoot: string;
    taskId: string;
  };
  [IPC.AskAboutCode]: {
    cwd: string;
    onOutput: ChannelRefLike<AskAboutCodeMessage>;
    prompt: string;
    providerId?: AskAboutCodeProviderId;
    requestId: string;
  };
  [IPC.CancelAskAboutCode]: {
    requestId: string;
  };
  [IPC.RebaseTask]: {
    baseBranch?: string;
    controllerId: string;
    taskId: string;
    worktreePath: string;
  };
  [IPC.GetMainBranch]: {
    baseBranch?: string;
    projectRoot: string;
  };
  [IPC.GetCurrentBranch]: {
    projectRoot: string;
  };
  [IPC.CommitAll]: {
    message: string;
    worktreePath: string;
  };
  [IPC.DiscardUncommitted]: {
    worktreePath: string;
  };
  [IPC.GetProjectDiff]: {
    baseBranch?: string;
    mode: ReviewDiffMode;
    worktreePath: string;
  };

  [IPC.SaveAppState]: {
    json: string;
    sourceId?: string;
  };
  [IPC.LoadAppState]: undefined;
  [IPC.SaveWorkspaceState]: {
    baseRevision?: number | null;
    json: string;
    sourceId?: string;
  };
  [IPC.LoadWorkspaceState]: undefined;

  [IPC.WindowIsFocused]: undefined;
  [IPC.WindowIsMaximized]: undefined;
  [IPC.WindowMinimize]: undefined;
  [IPC.WindowToggleMaximize]: undefined;
  [IPC.WindowClose]: undefined;
  [IPC.WindowCloseHandled]: undefined;
  [IPC.WindowForceClose]: undefined;
  [IPC.WindowHide]: undefined;
  [IPC.WindowMaximize]: undefined;
  [IPC.WindowUnmaximize]: undefined;
  [IPC.WindowSetSize]: {
    height: number;
    width: number;
  };
  [IPC.WindowSetPosition]: {
    x: number;
    y: number;
  };
  [IPC.WindowGetPosition]: undefined;
  [IPC.WindowGetSize]: undefined;

  [IPC.GetUpdateStatus]: undefined;
  [IPC.CheckForUpdates]: undefined;
  [IPC.InstallUpdate]: undefined;

  [IPC.DialogChoose]: {
    cancelIndex?: number;
    choices: string[];
    defaultIndex?: number;
    kind?: string;
    message: string;
    title?: string;
  };
  [IPC.DialogConfirm]: {
    cancelLabel?: string;
    kind?: string;
    message: string;
    okLabel?: string;
    title?: string;
  };
  [IPC.DialogOpen]:
    | {
        directory?: boolean;
        multiple?: boolean;
      }
    | undefined;

  [IPC.ShellReveal]: {
    filePath: string;
  };
  [IPC.ShellOpenFile]: {
    filePath: string;
    worktreePath: string;
  };
  [IPC.ShellOpenInEditor]: {
    editorCommand: string;
    worktreePath: string;
  };

  [IPC.SaveArenaData]: {
    filename: string;
    json: string;
  };
  [IPC.LoadArenaData]: {
    filename: string;
  };
  [IPC.InspectArenaCompetitor]: {
    commandTemplate: string;
  };
  [IPC.CreateArenaWorktree]: {
    branchName: string;
    projectRoot: string;
    symlinkDirs?: string[];
  };
  [IPC.RemoveArenaWorktree]: {
    branchName: string;
    projectRoot: string;
  };
  [IPC.CheckPathExists]: {
    path: string;
  };
  [IPC.CheckPathsExist]: {
    paths: string[];
  };

  [IPC.ListDirectory]: {
    path: string;
  };
  [IPC.GetHomePath]: undefined;
  [IPC.GetProjectBasePath]: undefined;
  [IPC.GetRecentProjects]: undefined;
  [IPC.CloneGitRepo]: {
    acceptHostKey?: boolean;
    url: string;
  };

  [IPC.StartRemoteServer]: { port?: number } | undefined;
  [IPC.StopRemoteServer]: undefined;
  [IPC.GetRemoteStatus]: undefined;

  [IPC.ReadPlanContent]: {
    relativePath?: string;
    worktreePath: string;
  };
  [IPC.ReadMarkdownFile]: {
    relativePath: string;
    worktreePath: string;
  };
  [IPC.ResolveClipboardPaste]: undefined;
  [IPC.SaveClipboardImage]: undefined;
  [IPC.SaveDroppedImage]: {
    data: string;
    name?: string;
  };
  [IPC.LogFromRenderer]: {
    category: string;
    ctx?: Record<string, unknown>;
    level: 'debug' | 'error' | 'info' | 'warn';
    level_min: 'debug' | 'error' | 'info' | 'warn';
    msg: string;
    ts: number;
  };
}

export interface RendererInvokeResponseMap {
  [IPC.SpawnAgent]: {
    attachedExistingSession: boolean;
  };
  [IPC.DetachAgentOutput]: undefined;
  [IPC.WriteToAgent]: undefined;
  [IPC.ResizeAgent]: undefined;
  [IPC.PauseAgent]: undefined;
  [IPC.ResumeAgent]: undefined;
  [IPC.KillAgent]: undefined;
  [IPC.GetAgentScrollback]: string | null;
  [IPC.GetScrollbackBatch]: ScrollbackBatchEntry[];
  [IPC.GetTerminalRecoveryBatch]: TerminalRecoveryBatchEntry[];
  [IPC.GetTerminalStartupRecoveryBatch]: TerminalRecoveryBatchEntry[];
  [IPC.CountRunningAgents]: number;
  [IPC.KillAllAgents]: undefined;
  [IPC.ListAgents]: AgentDef[];
  [IPC.GetAgentSupervision]: AgentSupervisionSnapshot[];
  [IPC.ListRunningAgentIds]: string[];
  [IPC.GetBackendRuntimeDiagnostics]: BackendRuntimeDiagnosticsSnapshot;
  [IPC.ResetBackendRuntimeDiagnostics]: undefined;
  [IPC.GetBrowserColdBootstrap]: BrowserColdBootstrapSnapshot;
  [IPC.GetBrowserReconnectStatus]: BrowserReconnectStatus;
  [IPC.GetBrowserReconnectSnapshot]: BrowserReconnectSnapshot;

  [IPC.CreateTask]: CreateTaskResult;
  [IPC.DeleteTask]: undefined;
  [IPC.CleanupTaskRuntime]: undefined;
  [IPC.AcquireTaskCommandLease]: TaskCommandControllerSnapshot & {
    acquired: boolean;
    leaseGeneration: number;
  };
  [IPC.RenewTaskCommandLease]: TaskCommandControllerSnapshot & {
    renewed: boolean;
    leaseGeneration: number;
  };
  [IPC.ReleaseTaskCommandLease]: TaskCommandControllerSnapshot;
  [IPC.GetTaskCommandControllers]: TaskCommandControllersResult;
  [IPC.GetTaskPorts]: TaskPortSnapshot[];
  [IPC.GetTaskPortExposureCandidates]: TaskPortExposureCandidate[];
  [IPC.GetTaskConvergence]: TaskConvergenceSnapshot[];
  [IPC.GetTaskReviewSignals]: TaskReviewSignalsSnapshot[];
  [IPC.GetTaskStepsSnapshot]: TaskStepsSnapshot | null;
  [IPC.ContainersInspectTask]: TaskContainerInspectResult;
  [IPC.ContainersStartTask]: TaskContainerInspectResult;
  [IPC.ContainersStopTask]: TaskContainerInspectResult;
  [IPC.ContainersDestroyTask]: TaskContainerInspectResult;
  [IPC.ContainersGetTaskLogs]: TaskContainerLogsResult;
  [IPC.GetServerStateBootstrap]: AnyServerStateBootstrapSnapshot[];
  [IPC.ExposePort]: TaskPortSnapshot;
  [IPC.RefreshTaskPortPreview]: TaskPortSnapshot | undefined;
  [IPC.UnexposePort]: TaskPortSnapshot | undefined;

  [IPC.GetChangedFiles]: ChangedFile[];
  [IPC.GetChangedFilesFromBranch]: ChangedFile[];
  [IPC.GetFileDiff]: FileDiffResult;
  [IPC.GetFileDiffFromBranch]: FileDiffResult;
  [IPC.GetAllFileDiffs]: string;
  [IPC.GetAllFileDiffsFromBranch]: string;
  [IPC.GetGitRepoRoot]: string | null;
  [IPC.GetGitignoredDirs]: string[];
  [IPC.ListBranches]: GitBranchListResult;
  [IPC.ListImportableWorktrees]: ImportableWorktree[];
  [IPC.GetWorktreeStatus]: WorktreeStatus;
  [IPC.CheckMergeStatus]: MergeStatus;
  [IPC.MergeTask]: MergeResult;
  [IPC.MergeArenaWorktree]: MergeResult;
  [IPC.GetBranchLog]: string;
  [IPC.GetBranchCommitHistory]: BranchCommitHistoryResult;
  [IPC.PushTask]: undefined;
  [IPC.AskAboutCode]: null;
  [IPC.CancelAskAboutCode]: null;
  [IPC.RebaseTask]: undefined;
  [IPC.GetMainBranch]: string;
  [IPC.GetCurrentBranch]: string;
  [IPC.CommitAll]: undefined;
  [IPC.DiscardUncommitted]: undefined;
  [IPC.GetProjectDiff]: ProjectDiffResult;

  [IPC.SaveAppState]: undefined;
  [IPC.LoadAppState]: string | null;
  [IPC.SaveWorkspaceState]: {
    revision: number;
  };
  [IPC.LoadWorkspaceState]: {
    json: string | null;
    revision: number;
  };

  [IPC.WindowIsFocused]: boolean;
  [IPC.WindowIsMaximized]: boolean;
  [IPC.WindowMinimize]: undefined;
  [IPC.WindowToggleMaximize]: undefined;
  [IPC.WindowClose]: undefined;
  [IPC.WindowCloseHandled]: undefined;
  [IPC.WindowForceClose]: undefined;
  [IPC.WindowHide]: undefined;
  [IPC.WindowMaximize]: undefined;
  [IPC.WindowUnmaximize]: undefined;
  [IPC.WindowSetSize]: undefined;
  [IPC.WindowSetPosition]: undefined;
  [IPC.WindowGetPosition]: Position;
  [IPC.WindowGetSize]: Size;

  [IPC.GetUpdateStatus]: AppUpdateStatus;
  [IPC.CheckForUpdates]: AppUpdateStatus;
  [IPC.InstallUpdate]: AppUpdateStatus;

  [IPC.DialogChoose]: number;
  [IPC.DialogConfirm]: boolean;
  [IPC.DialogOpen]: string | string[] | null;

  [IPC.ShellReveal]: undefined;
  [IPC.ShellOpenFile]: string | undefined;
  [IPC.ShellOpenInEditor]: undefined;

  [IPC.SaveArenaData]: undefined;
  [IPC.LoadArenaData]: string | null;
  [IPC.InspectArenaCompetitor]: ArenaCompetitorInspectResult;
  [IPC.CreateArenaWorktree]: CreateArenaWorktreeResult;
  [IPC.RemoveArenaWorktree]: undefined;
  [IPC.CheckPathExists]: boolean;
  [IPC.CheckPathsExist]: Record<string, boolean>;

  [IPC.ListDirectory]: string[];
  [IPC.GetHomePath]: string;
  [IPC.GetProjectBasePath]: string;
  [IPC.GetRecentProjects]: string[];
  [IPC.CloneGitRepo]:
    | { status: 'cloned'; repoRoot: string }
    | {
        status: 'host_key_confirmation_required';
        hostname: string;
        port: number;
        fingerprint: string;
      };

  [IPC.StartRemoteServer]: RemoteAccessStartResult;
  [IPC.StopRemoteServer]: undefined;
  [IPC.GetRemoteStatus]: RemoteAccessStatus;

  [IPC.ReadPlanContent]: { content: string; fileName: string; relativePath: string } | null;
  [IPC.ReadMarkdownFile]: { content: string; fileName: string; relativePath: string } | null;
  [IPC.ResolveClipboardPaste]:
    | { kind: 'empty' }
    | { kind: 'file'; path: string }
    | { kind: 'image'; path: string }
    | { kind: 'text'; text: string };
  [IPC.SaveClipboardImage]: string | null;
  [IPC.SaveDroppedImage]: string | null;
  [IPC.LogFromRenderer]: undefined;
  [IPC.GetNotificationCapability]: boolean;
  [IPC.ShowNotification]: undefined;
}

export type RendererInvokeChannel = keyof RendererInvokeResponseMap;
