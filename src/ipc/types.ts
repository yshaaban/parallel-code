export type { WorktreeStatus } from '../domain/server-state.js';
import type { ChangedFileStatus } from '../domain/git-status.js';

export type PtyOutput =
  | { type: 'Data'; data: string | Uint8Array } // base64 fallback or raw bytes
  | { type: 'RecoveryRequired'; reason: 'attach' | 'backpressure' }
  | {
      type: 'Exit';
      data: { exit_code: number | null; signal: string | null; last_output: string[] };
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
