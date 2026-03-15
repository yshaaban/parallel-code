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
  [IPC.SpawnAgent]:
    | {
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
      }
    | undefined;
  [IPC.DetachAgentOutput]:
    | {
        agentId: string;
        channelId: string;
      }
    | undefined;
  [IPC.WriteToAgent]:
    | {
        agentId: string;
        data: string;
      }
    | undefined;
  [IPC.ResizeAgent]:
    | {
        agentId: string;
        cols: number;
        rows: number;
      }
    | undefined;
  [IPC.PauseAgent]:
    | {
        agentId: string;
        channelId?: string;
        reason?: PauseReason;
      }
    | undefined;
  [IPC.ResumeAgent]:
    | {
        agentId: string;
        channelId?: string;
        reason?: PauseReason;
      }
    | undefined;
  [IPC.KillAgent]:
    | {
        agentId: string;
      }
    | undefined;
  [IPC.GetAgentScrollback]:
    | {
        agentId: string;
      }
    | undefined;
  [IPC.GetScrollbackBatch]:
    | {
        agentIds: string[];
      }
    | undefined;
  [IPC.CountRunningAgents]: undefined;
  [IPC.KillAllAgents]: undefined;
  [IPC.ListAgents]:
    | {
        hydraCommand?: string;
      }
    | undefined;
  [IPC.GetAgentSupervision]: undefined;
  [IPC.ListRunningAgentIds]: undefined;

  [IPC.CreateTask]:
    | {
        branchPrefix?: string;
        name: string;
        projectId: string;
        projectRoot: string;
        symlinkDirs: string[];
      }
    | undefined;
  [IPC.DeleteTask]:
    | {
        agentIds: string[];
        branchName: string;
        deleteBranch: boolean;
        projectRoot: string;
        taskId?: string;
        worktreePath?: string;
      }
    | undefined;
  [IPC.GetTaskPorts]: undefined;
  [IPC.GetTaskPortExposureCandidates]:
    | {
        taskId: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.GetTaskConvergence]: undefined;
  [IPC.GetServerStateBootstrap]: undefined;
  [IPC.ExposePort]:
    | {
        label?: string;
        port: number;
        taskId: string;
      }
    | undefined;
  [IPC.RefreshTaskPortPreview]:
    | {
        port: number;
        taskId: string;
      }
    | undefined;
  [IPC.UnexposePort]:
    | {
        port: number;
        taskId: string;
      }
    | undefined;

  [IPC.GetChangedFiles]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.GetChangedFilesFromBranch]:
    | {
        branchName: string;
        projectRoot: string;
      }
    | undefined;
  [IPC.GetFileDiff]:
    | {
        filePath: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.GetFileDiffFromBranch]:
    | {
        branchName: string;
        filePath: string;
        projectRoot: string;
      }
    | undefined;
  [IPC.GetAllFileDiffs]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.GetAllFileDiffsFromBranch]:
    | {
        branchName: string;
        projectRoot: string;
      }
    | undefined;
  [IPC.GetGitignoredDirs]:
    | {
        projectRoot: string;
      }
    | undefined;
  [IPC.GetWorktreeStatus]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.CheckMergeStatus]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.MergeTask]:
    | {
        branchName: string;
        cleanup?: boolean;
        message?: string | null;
        projectRoot: string;
        squash: boolean;
      }
    | undefined;
  [IPC.GetBranchLog]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.PushTask]:
    | {
        branchName: string;
        onOutput?: ChannelRefLike<string>;
        projectRoot: string;
      }
    | undefined;
  [IPC.AskAboutCode]:
    | {
        cwd: string;
        onOutput: ChannelRefLike<AskAboutCodeMessage>;
        prompt: string;
        requestId: string;
      }
    | undefined;
  [IPC.CancelAskAboutCode]:
    | {
        requestId: string;
      }
    | undefined;
  [IPC.RebaseTask]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.GetMainBranch]:
    | {
        projectRoot: string;
      }
    | undefined;
  [IPC.GetCurrentBranch]:
    | {
        projectRoot: string;
      }
    | undefined;
  [IPC.CommitAll]:
    | {
        message: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.DiscardUncommitted]:
    | {
        worktreePath: string;
      }
    | undefined;
  [IPC.GetProjectDiff]:
    | {
        mode: ReviewDiffMode;
        worktreePath: string;
      }
    | undefined;

  [IPC.SaveAppState]:
    | {
        json: string;
        sourceId?: string;
      }
    | undefined;
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
  [IPC.WindowSetSize]:
    | {
        height: number;
        width: number;
      }
    | undefined;
  [IPC.WindowSetPosition]:
    | {
        x: number;
        y: number;
      }
    | undefined;
  [IPC.WindowGetPosition]: undefined;
  [IPC.WindowGetSize]: undefined;

  [IPC.DialogConfirm]:
    | {
        cancelLabel?: string;
        kind?: string;
        message: string;
        okLabel?: string;
        title?: string;
      }
    | undefined;
  [IPC.DialogOpen]:
    | {
        directory?: boolean;
        multiple?: boolean;
      }
    | undefined;

  [IPC.ShellReveal]:
    | {
        filePath: string;
      }
    | undefined;
  [IPC.ShellOpenFile]:
    | {
        filePath: string;
        worktreePath: string;
      }
    | undefined;
  [IPC.ShellOpenInEditor]:
    | {
        editorCommand: string;
        worktreePath: string;
      }
    | undefined;

  [IPC.SaveArenaData]:
    | {
        filename: string;
        json: string;
      }
    | undefined;
  [IPC.LoadArenaData]:
    | {
        filename: string;
      }
    | undefined;
  [IPC.CreateArenaWorktree]:
    | {
        branchName: string;
        projectRoot: string;
        symlinkDirs?: string[];
      }
    | undefined;
  [IPC.RemoveArenaWorktree]:
    | {
        branchName: string;
        projectRoot: string;
      }
    | undefined;
  [IPC.CheckPathExists]:
    | {
        path: string;
      }
    | undefined;

  [IPC.ListDirectory]:
    | {
        path: string;
      }
    | undefined;
  [IPC.GetHomePath]: undefined;
  [IPC.GetRecentProjects]: undefined;

  [IPC.StartRemoteServer]: { port?: number } | undefined;
  [IPC.StopRemoteServer]: undefined;
  [IPC.GetRemoteStatus]: undefined;

  [IPC.ReadPlanContent]:
    | {
        relativePath?: string;
        worktreePath: string;
      }
    | undefined;
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
