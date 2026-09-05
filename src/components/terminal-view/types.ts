import type { PtyExitData } from '../../ipc/types';
import type { ProjectMode } from '../../store/types';
import type { AgentRunnerProfileConfig } from '../../domain/agent-runners.js';
import type { TerminalSessionOwner } from '../../domain/renderer-invoke.js';
import type { TerminalSessionUnavailableReason } from '../../domain/renderer-invoke.js';
import type {
  TerminalPresentationMode,
  TerminalPresentationModeKind,
} from '../../lib/terminal-presentation-mode';

export type TerminalViewStatus = 'binding' | 'attaching' | 'restoring' | 'ready' | 'error';
export type TerminalSessionAttachUnavailableReason =
  | TerminalSessionUnavailableReason
  | 'attach-transport-unavailable'
  | 'task-control-unavailable';
export type { TerminalPresentationMode, TerminalPresentationModeKind };

export function getTerminalRestoreUnavailableMessage(
  reason: TerminalSessionAttachUnavailableReason,
): string {
  const messages: Record<TerminalSessionAttachUnavailableReason, string> = {
    'attach-transport-unavailable': 'The terminal connection was interrupted while attaching.',
    'channel-unavailable': 'The terminal connection is unavailable.',
    'clean-restart-permit-unavailable': 'This task terminal is not ready to restore.',
    'identity-unavailable': 'This terminal is no longer available.',
    'initial-shell-reconciliation-required': 'This task terminal needs backend reconciliation.',
    'restore-failed': 'The terminal could not be restored.',
    'session-state-unavailable': 'Session restore is still starting.',
    'task-shell-restore-unavailable': 'This task terminal cannot be restored yet.',
    'task-control-unavailable': 'Another client currently controls this task terminal.',
    'task-unavailable': 'This terminal is no longer available.',
  };
  return messages[reason];
}

export interface TerminalViewProps {
  taskId: string;
  agentId: string;
  arenaLaunchToken?: string;
  command: string;
  args: string[];
  adapter?: 'hydra';
  baseBranch?: string;
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  resumeOnStart?: boolean;
  runnerProfile?: AgentRunnerProfileConfig;
  /** Explicit backend lifecycle owner; production call sites must provide it. */
  sessionOwner?: TerminalSessionOwner;
  onExit?: (exitInfo: PtyExitData) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  projectMode?: ProjectMode;
  replaceExistingSession?: boolean;
  startsTaskWatchers?: boolean;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  fontSize?: number;
  focusPanelId?: string;
  initialCommand?: string;
  isCommandTarget?: boolean;
  isFocused?: boolean;
  manageTaskSwitchWindowLifecycle?: boolean;
}
