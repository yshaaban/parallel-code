import type {
  AgentSupervisionSnapshot,
  RemoteAgentStatus,
  TaskExposedPort,
  TaskPortSnapshot,
} from '../domain/server-state';
import type { TaskReviewSnapshot } from '../domain/task-review';
import { stripAnsi } from '../lib/prompt-detection';
import {
  getRecentVisibleLines,
  isMeaningfulPreviewLine,
  truncatePreview,
} from '../lib/preview-heuristics';

const PREVIEW_LIMIT = 96;
const TAIL_LIMIT = 1200;
const PREVIEW_KEYWORD_PATTERN =
  /(?:use arrow keys|select an option|shift\+tab|ctrl\+c|build|error|ready|waiting)/i;

export function truncateRemoteAgentTail(rawTail: string): string {
  if (rawTail.length <= TAIL_LIMIT) {
    return rawTail;
  }

  return rawTail.slice(-TAIL_LIMIT);
}

export interface RemoteAgentStatusPresentation {
  accent: string;
  badgeBackground: string;
  badgeBorder: string;
  badgeLabel: string;
  description: string;
}

export type RemoteAgentListState =
  | 'busy'
  | 'done'
  | 'failed'
  | 'paused'
  | 'protected'
  | 'quiet'
  | 'ready'
  | 'syncing'
  | 'waiting';

export interface RemoteAgentListStatePresentation {
  accent: string;
  badgeBackground: string;
  badgeBorder: string;
  badgeLabel: string;
  key: RemoteAgentListState;
  sortOrder: number;
}

export interface RemoteTaskReviewSummary {
  conflictCount: number;
  fileCount: number;
  source: TaskReviewSnapshot['source'];
}

function stripControlCharacters(text: string): string {
  let normalized = '';

  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 8) || (code >= 11 && code <= 31) || code === 127) {
      normalized += ' ';
      continue;
    }

    normalized += character;
  }

  return normalized;
}

export function getRemoteFallbackPreview(status: RemoteAgentStatus): string {
  switch (status) {
    case 'running':
      return 'Working in the terminal';
    case 'paused':
      return 'Paused and waiting for input';
    case 'flow-controlled':
      return 'Output paused to protect the terminal';
    case 'restoring':
      return 'Restoring the terminal view';
    case 'exited':
      return 'Finished running';
  }
}

function getPreviewLines(rawTail: string): string[] {
  return getRecentVisibleLines(stripAnsi(rawTail), normalizePreviewLine);
}

export function appendRemoteAgentTail(previousTail: string, chunk: string): string {
  return truncateRemoteAgentTail(`${previousTail}${chunk}`);
}

export function deriveRemoteAgentPreview(rawTail: string, status: RemoteAgentStatus): string {
  const lines = getPreviewLines(rawTail);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && isMeaningfulPreviewLine(line, { keywordPattern: PREVIEW_KEYWORD_PATTERN })) {
      return truncatePreview(line, PREVIEW_LIMIT);
    }
  }

  return getRemoteFallbackPreview(status);
}

export function shouldShowRemoteAgentPreview(preview: string, status: RemoteAgentStatus): boolean {
  const normalizedPreview = preview.trim();
  if (normalizedPreview.length === 0) {
    return false;
  }

  if (normalizedPreview === getRemoteFallbackPreview(status)) {
    return false;
  }

  if (normalizedPreview === getRemoteAgentStatusPresentation(status).description) {
    return false;
  }

  if (normalizedPreview.length < 8) {
    return false;
  }

  const wordCount = normalizedPreview.split(/\s+/u).filter(Boolean).length;
  return wordCount >= 2 || normalizedPreview.length >= 14;
}

export function formatRemoteAgentActivity(
  status: RemoteAgentStatus,
  lastActivityAt: number | null,
  now: number,
): string {
  if (lastActivityAt === null) {
    switch (status) {
      case 'running':
        return 'Live now';
      case 'paused':
        return 'Paused';
      case 'flow-controlled':
        return 'Protected';
      case 'restoring':
        return 'Syncing';
      case 'exited':
        return 'Recent output';
    }
  }

  const ageMs = Math.max(0, now - lastActivityAt);
  if (ageMs < 10_000) {
    return status === 'running' ? 'Live now' : 'Updated just now';
  }
  if (ageMs < 60_000) {
    return `${Math.round(ageMs / 1000)}s ago`;
  }
  if (ageMs < 3_600_000) {
    return `${Math.round(ageMs / 60_000)}m ago`;
  }

  return `${Math.round(ageMs / 3_600_000)}h ago`;
}

function getRemoteAgentListState(
  status: RemoteAgentStatus,
  exitCode: number | null,
  supervision: Pick<AgentSupervisionSnapshot, 'attentionReason' | 'state'> | null,
): RemoteAgentListState {
  if (supervision) {
    if (supervision.attentionReason === 'quiet-too-long') {
      return 'quiet';
    }

    switch (supervision.state) {
      case 'awaiting-input':
        return 'waiting';
      case 'idle-at-prompt':
        return 'ready';
      case 'quiet':
        return 'quiet';
      case 'paused':
        return 'paused';
      case 'flow-controlled':
        return 'protected';
      case 'restoring':
        return 'syncing';
      case 'active':
        return 'busy';
      case 'exited-clean':
        return 'done';
      case 'exited-error':
        return 'failed';
    }
  }

  switch (status) {
    case 'running':
      return 'busy';
    case 'paused':
      return 'paused';
    case 'flow-controlled':
      return 'protected';
    case 'restoring':
      return 'syncing';
    case 'exited':
      return exitCode && exitCode !== 0 ? 'failed' : 'done';
  }
}

export function getRemoteAgentListStatePresentation(
  status: RemoteAgentStatus,
  exitCode: number | null,
  supervision: Pick<AgentSupervisionSnapshot, 'attentionReason' | 'state'> | null,
): RemoteAgentListStatePresentation {
  const state = getRemoteAgentListState(status, exitCode, supervision);

  switch (state) {
    case 'failed':
      return {
        accent: 'var(--danger)',
        badgeBackground: 'rgba(255, 95, 115, 0.12)',
        badgeBorder: 'rgba(255, 95, 115, 0.24)',
        badgeLabel: exitCode && exitCode !== 0 ? `Exit ${exitCode}` : 'Failed',
        key: state,
        sortOrder: 0,
      };
    case 'waiting':
      return {
        accent: 'var(--warning)',
        badgeBackground: 'rgba(255, 197, 105, 0.12)',
        badgeBorder: 'rgba(255, 197, 105, 0.24)',
        badgeLabel: 'Waiting',
        key: state,
        sortOrder: 1,
      };
    case 'ready':
      return {
        accent: 'var(--success)',
        badgeBackground: 'rgba(47, 209, 152, 0.12)',
        badgeBorder: 'rgba(47, 209, 152, 0.24)',
        badgeLabel: 'Ready',
        key: state,
        sortOrder: 2,
      };
    case 'quiet':
      return {
        accent: 'var(--text-muted)',
        badgeBackground: 'rgba(103, 129, 151, 0.12)',
        badgeBorder: 'rgba(103, 129, 151, 0.2)',
        badgeLabel: 'Quiet',
        key: state,
        sortOrder: 3,
      };
    case 'paused':
      return {
        accent: 'var(--warning)',
        badgeBackground: 'rgba(255, 197, 105, 0.12)',
        badgeBorder: 'rgba(255, 197, 105, 0.24)',
        badgeLabel: 'Paused',
        key: state,
        sortOrder: 4,
      };
    case 'busy':
      return {
        accent: 'var(--accent)',
        badgeBackground: 'rgba(46, 200, 255, 0.12)',
        badgeBorder: 'rgba(46, 200, 255, 0.24)',
        badgeLabel: 'Busy',
        key: state,
        sortOrder: 5,
      };
    case 'protected':
      return {
        accent: 'var(--accent)',
        badgeBackground: 'rgba(46, 200, 255, 0.12)',
        badgeBorder: 'rgba(46, 200, 255, 0.24)',
        badgeLabel: 'Protected',
        key: state,
        sortOrder: 6,
      };
    case 'syncing':
      return {
        accent: 'var(--accent)',
        badgeBackground: 'rgba(46, 200, 255, 0.12)',
        badgeBorder: 'rgba(46, 200, 255, 0.24)',
        badgeLabel: 'Syncing',
        key: state,
        sortOrder: 7,
      };
    case 'done':
      return {
        accent: 'var(--text-muted)',
        badgeBackground: 'rgba(103, 129, 151, 0.12)',
        badgeBorder: 'rgba(103, 129, 151, 0.2)',
        badgeLabel: 'Done',
        key: state,
        sortOrder: 8,
      };
  }
}

function normalizePreviewLine(line: string): string {
  return stripControlCharacters(line).replace(/\s+/g, ' ').trim();
}

export function formatRemoteAgentId(agentId: string): string {
  if (agentId.length <= 14) {
    return agentId;
  }

  return `${agentId.slice(0, 6)}…${agentId.slice(-4)}`;
}

export function getRemoteAgentViewTransitionName(agentId: string | null | undefined): string {
  const normalizedAgentId = agentId && agentId.length > 0 ? agentId : 'unknown';
  return `remote-agent-${normalizedAgentId.replace(/[^a-z0-9_-]/giu, '-')}`;
}

export type RemoteAgentGlyphKind = 'claude' | 'codex' | 'gemini' | 'generic' | 'hydra' | 'opencode';

export function normalizeRemoteAgentGlyphKind(
  agentDefId: string | null,
  agentDefName: string | null,
): RemoteAgentGlyphKind {
  const haystack = `${agentDefId ?? ''} ${agentDefName ?? ''}`.toLowerCase();
  if (haystack.includes('claude')) return 'claude';
  if (haystack.includes('gemini')) return 'gemini';
  if (haystack.includes('codex')) return 'codex';
  if (haystack.includes('opencode') || haystack.includes('open code')) return 'opencode';
  if (haystack.includes('hydra')) return 'hydra';
  return 'generic';
}

function getRemoteAgentGlyphLabel(kind: RemoteAgentGlyphKind): string | null {
  switch (kind) {
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    case 'hydra':
      return 'Hydra';
    case 'generic':
      return null;
  }
}

export function getRemoteAgentTypeLabel(
  agentDefId: string | null,
  agentDefName: string | null,
): string | null {
  if (agentDefName && agentDefName.trim().length > 0) {
    return agentDefName.trim();
  }

  return getRemoteAgentGlyphLabel(normalizeRemoteAgentGlyphKind(agentDefId, agentDefName));
}

export function formatRemoteTaskContext(
  branchName: string | null,
  folderName: string | null,
  directMode: boolean,
): string | null {
  const parts: string[] = [];

  if (branchName) {
    parts.push(directMode ? `${branchName} (direct)` : branchName);
  } else if (directMode) {
    parts.push('Direct');
  }

  if (folderName) {
    parts.push(folderName);
  }

  return parts.length > 0 ? parts.join(' \u00B7 ') : null;
}

const LAST_PROMPT_DISPLAY_LIMIT = 80;

function isMeaningfulRemotePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < 8) {
    return false;
  }

  const words = trimmed.split(/\s+/u).filter(Boolean);
  if (words.length >= 2) {
    return true;
  }

  return /[./:_-]/u.test(trimmed);
}

export function formatRemoteLastPrompt(lastPrompt: string | null): string | null {
  if (!lastPrompt || lastPrompt.trim().length === 0) return null;
  const trimmed = lastPrompt.trim();
  if (!isMeaningfulRemotePrompt(trimmed)) {
    return null;
  }
  if (trimmed.length <= LAST_PROMPT_DISPLAY_LIMIT) return trimmed;
  return `${trimmed.slice(0, LAST_PROMPT_DISPLAY_LIMIT - 1)}…`;
}

export function getRemoteAgentStatusPresentation(
  status: RemoteAgentStatus,
): RemoteAgentStatusPresentation {
  switch (status) {
    case 'running':
      return {
        accent: 'var(--success)',
        badgeBackground: 'rgba(47, 209, 152, 0.12)',
        badgeBorder: 'rgba(47, 209, 152, 0.26)',
        badgeLabel: 'Live',
        description: 'Streaming output right now',
      };
    case 'paused':
      return {
        accent: 'var(--warning)',
        badgeBackground: 'rgba(255, 197, 105, 0.12)',
        badgeBorder: 'rgba(255, 197, 105, 0.24)',
        badgeLabel: 'Paused',
        description: 'Waiting for the next step',
      };
    case 'flow-controlled':
      return {
        accent: 'var(--warning)',
        badgeBackground: 'rgba(255, 197, 105, 0.12)',
        badgeBorder: 'rgba(255, 197, 105, 0.24)',
        badgeLabel: 'Throttled',
        description: 'Output is being protected',
      };
    case 'restoring':
      return {
        accent: 'var(--accent)',
        badgeBackground: 'rgba(46, 200, 255, 0.12)',
        badgeBorder: 'rgba(46, 200, 255, 0.26)',
        badgeLabel: 'Syncing',
        description: 'Recovering the terminal view',
      };
    case 'exited':
      return {
        accent: 'var(--text-muted)',
        badgeBackground: 'rgba(103, 129, 151, 0.12)',
        badgeBorder: 'rgba(103, 129, 151, 0.2)',
        badgeLabel: 'Finished',
        description: 'Review the final output',
      };
  }
}

export function summarizeRemoteTaskReview(
  snapshot: TaskReviewSnapshot | null,
): RemoteTaskReviewSummary | null {
  if (!snapshot) {
    return null;
  }

  let conflictCount = 0;
  for (const file of snapshot.files) {
    if (file.status === 'U') {
      conflictCount += 1;
    }
  }

  return {
    conflictCount,
    fileCount: snapshot.files.length,
    source: snapshot.source,
  };
}

export function getRemotePrimaryPreviewPort(
  snapshot: TaskPortSnapshot | null,
): TaskExposedPort | null {
  if (!snapshot) {
    return null;
  }

  return (
    snapshot.exposed.find((port) => port.availability === 'available') ??
    snapshot.exposed.find((port) => port.verifiedHost !== null) ??
    null
  );
}
