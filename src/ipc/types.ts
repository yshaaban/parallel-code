export type { WorktreeStatus } from '../domain/server-state.js';
import type { ChangedFileStatus } from '../domain/git-status.js';

export interface PtyExitData {
  exit_code: number | null;
  signal: string | null;
  last_output: string[];
}

export type PtyOutput =
  | { type: 'Data'; data: string | Uint8Array } // base64 fallback or raw bytes
  | { type: 'RecoveryRequired'; reason: 'attach' | 'backpressure' }
  | {
      type: 'Exit';
      data: PtyExitData;
    };

export type AgentResumeStrategy = 'cli-args' | 'hydra-session' | 'none';

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  resume_strategy?: AgentResumeStrategy;
  skip_permissions_args: string[];
  description: string;
  adapter?: 'hydra';
  available?: boolean;
  availabilityReason?: string;
  availabilitySource?: 'path' | 'bundled' | 'override' | 'unavailable';
}

export interface CreateTaskResult {
  id: string;
  branch_name: string;
  worktree_path: string;
  base_branch?: string;
  git_isolation?: 'worktree' | 'current-branch';
}

export interface TaskInfo {
  id: string;
  name: string;
  branch_name: string;
  worktree_path: string;
  agent_ids: string[];
  status: 'Active' | 'Closed';
}

export interface ChangedFile {
  path: string;
  lines_added: number;
  lines_removed: number;
  status: ChangedFileStatus;
  committed: boolean;
}

export interface ProjectDiffResult {
  files: ChangedFile[];
  totalAdded: number;
  totalRemoved: number;
}

export interface MergeStatus {
  current_branch: string | null;
  main_ahead_count: number;
  conflicting_files: string[];
}

export interface MergeResult {
  main_branch: string;
  lines_added: number;
  lines_removed: number;
}

export interface FileDiffResult {
  diff: string;
  oldContent: string;
  newContent: string;
}

export interface ScrollbackBatchEntry {
  agentId: string;
  scrollback: string | null;
  cols: number;
}

export interface TerminalRecoveryRequestEntry {
  agentId: string;
  outputCursor: number | null;
  renderedTail: string | null;
  requestId: string;
  snapshotByteLimit: number | null;
}

export type TerminalStartupRecoveryRole = 'selected' | 'visible-sibling';

export interface TerminalStartupRecoveryRequestEntry {
  agentId: string;
  requestId: string;
  role: TerminalStartupRecoveryRole;
}

export type TerminalRecoveryPayload =
  | {
      kind: 'delta';
      data: string;
      overlapBytes: number;
      source: 'cursor' | 'tail';
    }
  | {
      kind: 'noop';
    }
  | {
      kind: 'snapshot';
      data: string | null;
    };

export interface TerminalRecoveryBatchEntry {
  agentId: string;
  cols: number;
  outputCursor: number;
  recovery: TerminalRecoveryPayload;
  requestId: string;
}

export interface CreateArenaWorktreeResult {
  path: string;
  branch: string;
}

export type ArenaCompetitorInspectStatus =
  | 'ready'
  | 'missing_command'
  | 'missing_auth'
  | 'unsupported_runtime'
  | 'invalid_command';

export interface ArenaCompetitorInspectIssue {
  code:
    | 'invalid_empty_command'
    | 'missing_command'
    | 'missing_gemini_api_key'
    | 'missing_claude_auth'
    | 'missing_codex_auth'
    | 'unsupported_runtime'
    | 'quiet_noninteractive_output';
  message: string;
  severity: 'error' | 'warning';
}

export interface ArenaCompetitorInspectResult {
  executable: string | null;
  issues: ArenaCompetitorInspectIssue[];
  status: ArenaCompetitorInspectStatus;
}
