export type { WorktreeStatus } from '../domain/server-state.js';
import type { ChangedFileStatus } from '../domain/git-status.js';
import type { TaskCreationSnapshotIssue, TaskCreationPhase } from '../domain/task-creation.js';
import type {
  TaskCreationOperationLink,
  TaskCreationProvenance,
  TaskInitialShellOwnership,
  TaskCreationWriterEpoch,
} from '../domain/task-creation-provenance.js';

export type DiscoveredProjectSource = 'claude' | 'codex' | 'git';

export interface DiscoveredProject {
  path: string;
  name: string;
  source: DiscoveredProjectSource;
  updatedAtMs: number;
}

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
export type AgentResumeFailureClassifier = 'claude-no-conversation-v1';
export type AgentResumeFailureFallback = 'fresh-start' | 'none';

export interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  resume_failure_classifier?: AgentResumeFailureClassifier;
  resume_failure_fallback?: AgentResumeFailureFallback;
  resume_strategy?: AgentResumeStrategy;
  skip_permissions_args: string[];
  description: string;
  adapter?: 'hydra';
  env?: Record<string, string>;
  available?: boolean;
  availabilityReason?: string;
  availabilitySource?: 'path' | 'bundled' | 'override' | 'unavailable';
  availabilityStatus?: 'probing' | 'known';
}

export interface CreateTaskResult {
  agent_def_id?: string;
  agent_def_name?: string;
  id: string;
  branch_name: string;
  worktree_path: string;
  base_branch?: string;
  coordinator_credential_path?: string;
  coordinator_run_id?: string;
  coordinator_tool_command?: string;
  creation_issue?: TaskCreationSnapshotIssue;
  creation_operation_id?: string;
  creation_phase?: TaskCreationPhase;
  creation_writer_epoch?: TaskCreationWriterEpoch;
  git_isolation?: 'worktree' | 'current-branch' | 'existing-worktree';
  initial_prompt?: string;
  initial_prompt_delivery_id?: string;
  launch_operation_id?: string;
  project_mode?: 'git' | 'non-git';
  session_id?: string;
  symlink_warnings?: WorktreeSymlinkWarning[];
  task_creation_operation_link?: TaskCreationOperationLink;
  task_creation_provenance?: TaskCreationProvenance;
  task_initial_shell_ownership?: TaskInitialShellOwnership;
  task_name?: string;
  workspace_revision?: number;
}

export interface WorktreeSymlinkCandidate {
  name: string;
  isDefault: boolean;
}

export interface WorktreeSymlinkCandidatesResult {
  candidates: WorktreeSymlinkCandidate[];
  truncated: boolean;
}

export type WorktreeSymlinkWarningReason =
  | 'candidate_query_failed'
  | 'not_current_candidate'
  | 'invalid_name'
  | 'reserved_name'
  | 'source_missing'
  | 'source_symlink'
  | 'unsupported_source_kind'
  | 'destination_exists'
  | 'link_failed'
  | 'exclude_update_failed'
  | 'ignore_postcondition_failed';

export interface WorktreeSymlinkWarning {
  name: string;
  reason: WorktreeSymlinkWarningReason;
  message: string;
}

export interface GitBranchInfo {
  current: boolean;
  local: boolean;
  name: string;
  remote: boolean;
  remoteRef?: string;
  upstream?: string;
}

export interface GitBranchListResult {
  branches: GitBranchInfo[];
  defaultBranch: string;
  generatedAt: number;
}

export interface ImportableWorktree {
  branchName: string;
  has_committed_changes: boolean;
  has_uncommitted_changes: boolean;
  path: string;
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
  commitHash?: string;
  path: string;
  lines_added: number;
  lines_removed: number;
  status: ChangedFileStatus;
  committed: boolean;
}

export interface ProjectDiffResult {
  files: ChangedFile[];
  revisionId?: string;
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
  visibleTerminalCount: number;
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
    }
  | {
      // Cursor miss where a capped snapshot would destroy renderer history the
      // backend cannot prove. The client may answer with one bounded rendered
      // tail (phase two) so the backend can return a delta instead.
      kind: 'tail-needed';
    }
  | {
      kind: 'terminal-state';
      data: string;
    };

export interface TerminalRecoveryBatchEntry {
  agentId: string;
  // Present when the backend kept the restore pause alive after responding;
  // the client releases it (ReleaseTerminalRecoveryPause) after applying the
  // entry, with a server-side auto-resume timer as the safety net.
  batchPauseId?: string;
  cols: number;
  outputCursor: number;
  recovery: TerminalRecoveryPayload;
  requestId: string;
  rows: number;
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
