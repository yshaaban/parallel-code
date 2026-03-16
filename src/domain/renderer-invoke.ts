import { IPC } from '../../electron/ipc/channels.js';
import type { AgentDef } from '../ipc/types.js';
import type {
  ChangedFile,
  CreateArenaWorktreeResult,
  CreateTaskResult,
  FileDiffResult,
  MergeResult,
  MergeStatus,
  ProjectDiffResult,
  ScrollbackBatchEntry,
} from '../ipc/types.js';
import type { ReviewDiffMode } from '../store/types.js';
import type { AskAboutCodeMessage } from './ask-about-code.js';
import type { AnyServerStateBootstrapSnapshot } from './server-state-bootstrap.js';
import type {
  AgentSupervisionSnapshot,
  PauseReason,
  RemoteAccessStatus,
  TaskPortExposureCandidate,
  TaskPortSnapshot,
  WorktreeStatus,
} from './server-state.js';
import type { TaskConvergenceSnapshot } from './task-convergence.js';

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
    cols?: number;
    command?: string;
    cwd?: string;
    env?: Record<string, string>;
    isShell?: boolean;
    onOutput: ChannelRefLike<string>;
    rows?: number;
    taskId: string;
  };
  [IPC.DetachAgentOutput]: {
    agentId: string;
    channelId: string;
  };
  [IPC.WriteToAgent]: {
    agentId: string;
    data: string;
  };
  [IPC.ResizeAgent]: {
    agentId: string;
    cols: number;
    rows: number;
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
  [IPC.CountRunningAgents]: undefined;
  [IPC.KillAllAgents]: undefined;
  [IPC.ListAgents]:
    | {
        hydraCommand?: string;
      }
    | undefined;
  [IPC.GetAgentSupervision]: undefined;
  [IPC.ListRunningAgentIds]: undefined;

  [IPC.CreateTask]: {
    branchPrefix?: string;
    name: string;
    projectId: string;
    projectRoot: string;
    symlinkDirs: string[];
  };
  [IPC.DeleteTask]: {
    agentIds: string[];
    branchName: string;
    deleteBranch: boolean;
    projectRoot: string;
    taskId?: string;
    worktreePath?: string;
  };
  [IPC.GetTaskPorts]: undefined;
  [IPC.GetTaskPortExposureCandidates]: {
    taskId: string;
    worktreePath: string;
  };
  [IPC.GetTaskConvergence]: undefined;
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
    worktreePath: string;
  };
  [IPC.GetChangedFilesFromBranch]: {
    branchName: string;
    projectRoot: string;
  };
  [IPC.GetFileDiff]: {
    filePath: string;
    worktreePath: string;
  };
  [IPC.GetFileDiffFromBranch]: {
    branchName: string;
    filePath: string;
    projectRoot: string;
  };
  [IPC.GetAllFileDiffs]: {
    worktreePath: string;
  };
  [IPC.GetAllFileDiffsFromBranch]: {
    branchName: string;
    projectRoot: string;
  };
  [IPC.GetGitignoredDirs]: {
    projectRoot: string;
  };
  [IPC.GetWorktreeStatus]: {
    worktreePath: string;
  };
  [IPC.CheckMergeStatus]: {
    worktreePath: string;
  };
  [IPC.MergeTask]: {
    branchName: string;
    cleanup?: boolean;
    message?: string | null;
    projectRoot: string;
    squash: boolean;
  };
  [IPC.GetBranchLog]: {
    worktreePath: string;
  };
  [IPC.PushTask]: {
    branchName: string;
    onOutput?: ChannelRefLike<string>;
    projectRoot: string;
  };
  [IPC.AskAboutCode]: {
    cwd: string;
    onOutput: ChannelRefLike<AskAboutCodeMessage>;
    prompt: string;
    requestId: string;
  };
  [IPC.CancelAskAboutCode]: {
    requestId: string;
  };
  [IPC.RebaseTask]: {
    worktreePath: string;
  };
  [IPC.GetMainBranch]: {
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
    mode: ReviewDiffMode;
    worktreePath: string;
  };

  [IPC.SaveAppState]: {
    json: string;
    sourceId?: string;
  };
  [IPC.LoadAppState]: undefined;

  [IPC.WindowIsFocused]: undefined;
  [IPC.WindowIsMaximized]: undefined;
  [IPC.WindowMinimize]: undefined;
  [IPC.WindowToggleMaximize]: undefined;
  [IPC.WindowClose]: undefined;
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

  [IPC.ListDirectory]: {
    path: string;
  };
  [IPC.GetHomePath]: undefined;
  [IPC.GetRecentProjects]: undefined;

  [IPC.StartRemoteServer]: { port?: number } | undefined;
  [IPC.StopRemoteServer]: undefined;
  [IPC.GetRemoteStatus]: undefined;

  [IPC.ReadPlanContent]: {
    relativePath?: string;
    worktreePath: string;
  };
}

export interface RendererInvokeResponseMap {
  [IPC.SpawnAgent]: undefined;
  [IPC.DetachAgentOutput]: undefined;
  [IPC.WriteToAgent]: undefined;
  [IPC.ResizeAgent]: undefined;
  [IPC.PauseAgent]: undefined;
  [IPC.ResumeAgent]: undefined;
  [IPC.KillAgent]: undefined;
  [IPC.GetAgentScrollback]: string | null;
  [IPC.GetScrollbackBatch]: ScrollbackBatchEntry[];
  [IPC.CountRunningAgents]: number;
  [IPC.KillAllAgents]: undefined;
  [IPC.ListAgents]: AgentDef[];
  [IPC.GetAgentSupervision]: AgentSupervisionSnapshot[];
  [IPC.ListRunningAgentIds]: string[];

  [IPC.CreateTask]: CreateTaskResult;
  [IPC.DeleteTask]: undefined;
  [IPC.GetTaskPorts]: TaskPortSnapshot[];
  [IPC.GetTaskPortExposureCandidates]: TaskPortExposureCandidate[];
  [IPC.GetTaskConvergence]: TaskConvergenceSnapshot[];
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
  [IPC.GetGitignoredDirs]: string[];
  [IPC.GetWorktreeStatus]: WorktreeStatus;
  [IPC.CheckMergeStatus]: MergeStatus;
  [IPC.MergeTask]: MergeResult;
  [IPC.GetBranchLog]: string;
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

  [IPC.WindowIsFocused]: boolean;
  [IPC.WindowIsMaximized]: boolean;
  [IPC.WindowMinimize]: undefined;
  [IPC.WindowToggleMaximize]: undefined;
  [IPC.WindowClose]: undefined;
  [IPC.WindowForceClose]: undefined;
  [IPC.WindowHide]: undefined;
  [IPC.WindowMaximize]: undefined;
  [IPC.WindowUnmaximize]: undefined;
  [IPC.WindowSetSize]: undefined;
  [IPC.WindowSetPosition]: undefined;
  [IPC.WindowGetPosition]: Position;
  [IPC.WindowGetSize]: Size;

  [IPC.DialogConfirm]: boolean;
  [IPC.DialogOpen]: string | string[] | null;

  [IPC.ShellReveal]: undefined;
  [IPC.ShellOpenFile]: string | undefined;
  [IPC.ShellOpenInEditor]: undefined;

  [IPC.SaveArenaData]: undefined;
  [IPC.LoadArenaData]: string | null;
  [IPC.CreateArenaWorktree]: CreateArenaWorktreeResult;
  [IPC.RemoveArenaWorktree]: undefined;
  [IPC.CheckPathExists]: boolean;

  [IPC.ListDirectory]: string[];
  [IPC.GetHomePath]: string;
  [IPC.GetRecentProjects]: string[];

  [IPC.StartRemoteServer]: RemoteAccessStartResult;
  [IPC.StopRemoteServer]: undefined;
  [IPC.GetRemoteStatus]: RemoteAccessStatus;

  [IPC.ReadPlanContent]: { content: string; fileName: string; relativePath: string } | null;
}

export type RendererInvokeChannel = keyof RendererInvokeResponseMap;
