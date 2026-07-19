import type { PtyExitData } from '../../ipc/types';
import type { ProjectMode } from '../../store/types';
import type { AgentRunnerProfileConfig } from '../../domain/agent-runners.js';
import type {
  TerminalPresentationMode,
  TerminalPresentationModeKind,
} from '../../lib/terminal-presentation-mode';

export type TerminalViewStatus = 'binding' | 'attaching' | 'restoring' | 'ready' | 'error';
export type { TerminalPresentationMode, TerminalPresentationModeKind };

export interface TerminalViewProps {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  adapter?: 'hydra';
  baseBranch?: string;
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  resumeOnStart?: boolean;
  runnerProfile?: AgentRunnerProfileConfig;
  onExit?: (exitInfo: PtyExitData) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  projectMode?: ProjectMode;
  replaceExistingSession?: boolean;
  startsTaskWatchers?: boolean;
  onReady?: (focusFn: () => void) => void;
  onSpawnResolved?: () => void;
  onBufferReady?: (getBuffer: () => string) => void;
  fontSize?: number;
  focusPanelId?: string;
  initialCommand?: string;
  isCommandTarget?: boolean;
  isFocused?: boolean;
  manageTaskSwitchWindowLifecycle?: boolean;
}
