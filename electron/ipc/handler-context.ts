import { IPC } from './channels.js';
import { BadRequestError } from './errors.js';
import {
  isPauseReason,
  type GitStatusSyncEvent,
  type PauseReason,
} from '../../src/domain/server-state.js';
import type { StorageEnv } from './storage.js';
import type { WorkspaceStorageKind } from './workspace-state-storage.js';
import type { RemoteAccessController } from './remote-access-workflows.js';
import type { AppUpdateStatus } from '../../src/domain/app-update.js';
import type { TaskStructureMutationService } from './task-structure-mutations.js';
import type { WorkspaceTaskMergeLegacyWriterGate } from './task-merge-legacy-writer-gate.js';
import type { WorkspaceTaskRemovalLegacyWriterGate } from './task-removal-legacy-writer-gate.js';
import type { WorkspaceMutationService } from './workspace-state-mutations.js';
import type { AgentSessionWriterRuntime } from './agent-session-writer-authority.js';
import type { TrustedLocalTaskCreationCommand } from './task-creation-local-command.js';
import type { TaskMergeWorkflow } from './task-merge-workflow.js';
import type { TaskNotesService } from './task-notes-service.js';
import type { TaskNotesWriterEntitlements } from './task-notes-writer-entitlements.js';
import type { TaskPromptInputAdmissionService } from './task-prompt-input-admission.js';
import type {
  ManagedAgentSessionRestoreRequest,
  ManagedAgentSessionRestoreResult,
} from '../../src/domain/agent-session-operation.js';
import type {
  ManagedTaskShellSessionRestoreRequest,
  ManagedTaskShellSessionRestoreResult,
} from '../../src/domain/task-shell-session-operation.js';

export type ActiveTaskMergeWorkflow = Pick<TaskMergeWorkflow, 'issue' | 'start' | 'status'>;
export type ActiveTaskNotesService = Pick<
  TaskNotesService,
  'getTaskNotes' | 'issueTaskNotesOperation' | 'updateTaskNotes'
>;

export interface WorkspaceMutationHost {
  getTaskMergeLegacyWriterGate: () => Promise<WorkspaceTaskMergeLegacyWriterGate>;
  getTaskRemovalLegacyWriterGate: () => Promise<WorkspaceTaskRemovalLegacyWriterGate>;
  getTaskStructureService: () => Promise<TaskStructureMutationService>;
  getWorkspaceService: () => Promise<WorkspaceMutationService>;
}

export type HandlerArgs = Record<string, unknown> | undefined;
export type IpcHandler = (args?: HandlerArgs) => Promise<unknown> | unknown;

export interface WindowController {
  isFocused: () => boolean;
  isMaximized: () => boolean;
  focus: () => void;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  closeHandled: () => void;
  forceClose: () => void;
  hide: () => void;
  show: () => void;
  maximize: () => void;
  unmaximize: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  getPosition: () => { x: number; y: number };
  getSize: () => { width: number; height: number };
}

export interface DialogController {
  choose: (args: {
    cancelIndex?: number;
    choices: string[];
    defaultIndex?: number;
    kind?: string;
    message: string;
    title?: string;
  }) => Promise<number>;
  confirm: (args: {
    message: string;
    title?: string;
    kind?: string;
    okLabel?: string;
    cancelLabel?: string;
  }) => Promise<boolean>;
  open: (args?: { directory?: boolean; multiple?: boolean }) => Promise<string | string[] | null>;
}

export interface ShellController {
  reveal: (filePath: string) => void;
  openFile: (worktreePath: string, filePath: string) => Promise<string | undefined>;
  openInEditor: (editorCommand: string, worktreePath: string) => Promise<void>;
}

export type ClipboardPasteResult =
  | { kind: 'empty' }
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string };

export interface ClipboardController {
  resolveClipboardPaste?: () => Promise<ClipboardPasteResult>;
  saveClipboardImage: () => Promise<string | null>;
  saveDroppedImage?: (args: { data: string; name?: string }) => Promise<string | null>;
}

export interface UpdateController {
  checkForUpdates: () => Promise<AppUpdateStatus>;
  getStatus: () => AppUpdateStatus;
  installUpdate: () => Promise<AppUpdateStatus>;
}

/** Internal attach context; browser client identity is supplied by the transport normalizer. */
export interface CanonicalTaskShellRestoreOptions {
  clientId?: string;
  compatibilityIntent?: 'create';
}

export type CanonicalTaskShellRestoreResult = ManagedTaskShellSessionRestoreResult & {
  /** Backend-only classification; never accepted from an attach request. */
  standalone?: true;
};

export interface HandlerContext extends StorageEnv {
  getTaskCollapseWorkflow?: () => Promise<
    import('./task-collapse-workflow.js').TaskCollapseWorkflow
  >;
  agentSessionWriter?: AgentSessionWriterRuntime;
  /** Identity-only bridge to the canonical managed agent-session owner. */
  restoreCanonicalAgentSession?: (
    request: Readonly<ManagedAgentSessionRestoreRequest>,
  ) => Promise<ManagedAgentSessionRestoreResult>;
  /** Read-only canonical identity check used before any compatibility spawn. */
  classifyCanonicalAgentSessionIdentity?: (
    request: Readonly<ManagedAgentSessionRestoreRequest>,
  ) => Promise<'managed-agent' | 'unmanaged' | 'unavailable'>;
  /** Identity-only bridge to the canonical terminal-task initial-shell owner. */
  restoreCanonicalTaskShellSession?: (
    request: Readonly<ManagedTaskShellSessionRestoreRequest>,
    options?: Readonly<CanonicalTaskShellRestoreOptions>,
  ) => Promise<CanonicalTaskShellRestoreResult>;
  /** One server-lifecycle queue owns byte admission for every task-prompt producer. */
  taskPromptInputAdmission?: TaskPromptInputAdmissionService;
  /** Awaits managed creation activation before any task-creation effect. */
  getTaskCreationCommand?: () => Promise<TrustedLocalTaskCreationCommand>;
  /** Awaits the merge-owner cutover before any typed task-merge admission. */
  getTaskMergeWorkflow?: () => Promise<ActiveTaskMergeWorkflow>;
  /** Awaits the single canonical notes owner; adapters never accept caller-supplied authority. */
  getTaskNotesService?: () => Promise<ActiveTaskNotesService>;
  /** Immutable, proof-bound desktop/remote writer cutovers; absent means both surfaces stay dark. */
  taskNotesWriterEntitlements?: TaskNotesWriterEntitlements;
  sendToChannel: (channelId: string, msg: unknown) => void;
  awaitCoordinatorRuntimeReady?: () => Promise<void>;
  // Binds the output channel for the requesting client as part of the
  // single-round-trip AttachTerminalSession RPC. Browser mode implements it
  // via the channel manager plus the control-plane clientId lookup; Electron
  // leaves it undefined (channel binding is implicit in the IPC bridge).
  bindChannelForClient?: (clientId: string | null, channelId: string) => boolean;
  coordinatorToolCallTlsCertificate?: string | (() => string);
  coordinatorToolCallUrl?: string | (() => string);
  emitIpcEvent?: (channel: IPC, payload: unknown) => void;
  emitGitStatusChanged?: (payload: GitStatusSyncEvent) => void;
  isChannelActive?: (channelId: string) => boolean;
  remoteAccess?: RemoteAccessController;
  registerWorkspaceMutationCleanup?: (cleanup: () => Promise<void>) => void;
  window?: WindowController;
  dialog?: DialogController;
  shell?: ShellController;
  clipboard?: ClipboardController;
  update?: UpdateController;
  workspaceMutations?: WorkspaceMutationHost;
  workspaceStorageKind?: WorkspaceStorageKind;
}

function requireContextFeature<K extends keyof HandlerContext>(
  context: HandlerContext,
  key: K,
  description: string,
): NonNullable<HandlerContext[K]> {
  const feature = context[key];
  if (!feature) {
    throw new Error(`${description} is unavailable in this mode`);
  }
  return feature as NonNullable<HandlerContext[K]>;
}

export function requireWindow(context: HandlerContext): WindowController {
  return requireContextFeature(context, 'window', 'Window management');
}

export function requireDialog(context: HandlerContext): DialogController {
  return requireContextFeature(context, 'dialog', 'Dialog operations');
}

export function requireShell(context: HandlerContext): ShellController {
  return requireContextFeature(context, 'shell', 'Shell operations');
}

export function requireRemoteAccess(context: HandlerContext): RemoteAccessController {
  return requireContextFeature(context, 'remoteAccess', 'Remote access');
}

export function assertOptionalPauseReason(
  value: unknown,
): asserts value is PauseReason | undefined {
  if (value !== undefined && (typeof value !== 'string' || !isPauseReason(value))) {
    throw new BadRequestError('reason must be a valid pause reason');
  }
}
