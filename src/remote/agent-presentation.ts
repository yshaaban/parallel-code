import type { RemoteAgentStatus } from '../domain/server-state';
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

function getFallbackPreview(status: RemoteAgentStatus): string {
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

  return getFallbackPreview(status);
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

function normalizePreviewLine(line: string): string {
  return stripControlCharacters(line).replace(/\s+/g, ' ').trim();
}

export function formatRemoteAgentId(agentId: string): string {
  if (agentId.length <= 14) {
    return agentId;
  }

  return `${agentId.slice(0, 6)}…${agentId.slice(-4)}`;
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

export function formatRemoteLastPrompt(lastPrompt: string | null): string | null {
  if (!lastPrompt || lastPrompt.trim().length === 0) return null;
  const trimmed = lastPrompt.trim();
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
