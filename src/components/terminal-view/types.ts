import type { PtyExitData } from '../../ipc/types';
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
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  resumeOnStart?: boolean;
  onExit?: (exitInfo: PtyExitData) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  fontSize?: number;
  initialCommand?: string;
  isFocused?: boolean;
  manageTaskSwitchWindowLifecycle?: boolean;
}
