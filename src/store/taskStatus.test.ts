import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SolidJS store before importing the module under test.
let mockAutoTrustFolders = false;
let mockActiveTaskId: string | null = null;
vi.mock('./core', () => ({
  store: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'autoTrustFolders') return mockAutoTrustFolders;
        if (prop === 'activeTaskId') return mockActiveTaskId;
        return undefined;
      },
    },
  ),
  setStore: vi.fn(),
}));

// Mock IPC so tryAutoTrust's invoke call doesn't hit Electron.
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

// Stub SolidJS reactive primitives — tests run outside a reactive root.
vi.mock('solid-js', () => {
  function createSignal<T>(initial: T): [() => T, (v: T | ((prev: T) => T)) => void] {
    let value = initial;
    const getter = () => value;
    const setter = (v: T | ((prev: T) => T)) => {
      value = typeof v === 'function' ? (v as (prev: T) => T)(value) : v;
    };
    return [getter, setter];
  }
  return {
    createSignal,
    createEffect: vi.fn(),
    onMount: vi.fn(),
    onCleanup: vi.fn(),
    untrack: (fn: () => unknown) => fn(),
  };
});

import {
  stripAnsi,
  normalizeForComparison,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  markAgentSpawned,
  markAgentOutput,
  clearAgentActivity,
} from './taskStatus';

beforeEach(() => {
  vi.useFakeTimers();
  mockAutoTrustFolders = false;
  mockActiveTaskId = 'task-1';
});

afterEach(() => {
  clearAgentActivity('agent-1');
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------
describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes cursor-positioning sequences that cause TUI garbling', () => {
    // Ink-style cursor positioning: ESC[row;colH moves cursor
    const garbled = '\x1b[1;1HI\x1b[1;2Htrust\x1b[1;8Hthis\x1b[1;13Hfolder';
    expect(stripAnsi(garbled)).toBe('Itrustthisfolder');
  });
});

// ---------------------------------------------------------------------------
// normalizeForComparison
// ---------------------------------------------------------------------------
describe('normalizeForComparison', () => {
  it('strips ANSI and collapses whitespace', () => {
    expect(normalizeForComparison('\x1b[32m  hello   world  \x1b[0m')).toBe('hello world');
  });

  it('removes control characters', () => {
    expect(normalizeForComparison('hello\x00\x01world')).toBe('helloworld');
  });
});

// ---------------------------------------------------------------------------
// looksLikeQuestion
// ---------------------------------------------------------------------------
describe('looksLikeQuestion', () => {
  it('detects Y/n confirmation prompt', () => {
    expect(looksLikeQuestion('Install packages? [Y/n] ')).toBe(true);
  });

  it('detects y/N confirmation prompt', () => {
    expect(looksLikeQuestion('Continue? [y/N] ')).toBe(true);
  });

  it('detects normal trust dialog with spaces', () => {
    expect(looksLikeQuestion('Do you trust this folder?')).toBe(true);
  });

  it('detects TUI-garbled trust dialog without word boundaries', () => {
    // After ANSI stripping, TUI text runs together
    expect(looksLikeQuestion('❯1.Yes,Itrustthisfolder')).toBe(true);
  });

  it('detects "trust.*folder" pattern in garbled text', () => {
    expect(looksLikeQuestion('Doyoutrustthisfolder?')).toBe(true);
  });

  it('returns false for bare prompt marker', () => {
    expect(looksLikeQuestion('❯ ')).toBe(false);
    expect(looksLikeQuestion('❯')).toBe(false);
  });

  it('returns false for bare prompt marker preceded by old trust text', () => {
    // When the trust dialog has been answered and the agent shows its real prompt,
    // the last line is a bare ❯ — should NOT be treated as a question.
    const tail = 'Do you trust this folder?\n❯ ';
    expect(looksLikeQuestion(tail)).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(looksLikeQuestion('')).toBe(false);
  });

  it('detects "Do you want to" pattern', () => {
    expect(looksLikeQuestion('Do you want to continue?')).toBe(true);
  });

  it('detects "Would you like to" pattern', () => {
    expect(looksLikeQuestion('Would you like to proceed?')).toBe(true);
  });

  it('detects "Are you sure" pattern', () => {
    expect(looksLikeQuestion('Are you sure you want to delete?')).toBe(true);
  });

  it('returns false for normal output without questions', () => {
    expect(looksLikeQuestion('Building project...\nCompiling files...')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTrustQuestionAutoHandled
// ---------------------------------------------------------------------------
describe('isTrustQuestionAutoHandled', () => {
  it('returns false when autoTrustFolders is disabled', () => {
    mockAutoTrustFolders = false;
    expect(isTrustQuestionAutoHandled('Do you trust this folder?')).toBe(false);
  });

  it('returns true for trust dialog when autoTrustFolders is enabled', () => {
    mockAutoTrustFolders = true;
    expect(isTrustQuestionAutoHandled('Do you trust this folder?')).toBe(true);
  });

  it('returns true for TUI-garbled trust dialog when autoTrustFolders is enabled', () => {
    mockAutoTrustFolders = true;
    expect(isTrustQuestionAutoHandled('❯1.Yes,Itrustthisfolder')).toBe(true);
  });

  it('returns false when exclusion keywords are present', () => {
    mockAutoTrustFolders = true;
    expect(isTrustQuestionAutoHandled('Do you trust deleting this folder?')).toBe(false);
  });

  it('returns false for non-trust questions even with autoTrust enabled', () => {
    mockAutoTrustFolders = true;
    expect(isTrustQuestionAutoHandled('Do you want to continue? [Y/n]')).toBe(false);
  });

  it('does not false-positive on exclusion keywords in garbled text', () => {
    // "forkeyboardshortcuts" contains "key" but \b prevents matching
    mockAutoTrustFolders = true;
    const garbled = '?forkeyboardshortcuts\nDoyoutrustthisfolder?';
    expect(isTrustQuestionAutoHandled(garbled)).toBe(true);
  });

  it('returns false when "password" exclusion keyword is present', () => {
    mockAutoTrustFolders = true;
    expect(isTrustQuestionAutoHandled('Do you trust this folder? Enter password:')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAutoTrustSettling
// ---------------------------------------------------------------------------
describe('isAutoTrustSettling', () => {
  it('returns false for unknown agent', () => {
    expect(isAutoTrustSettling('unknown-agent')).toBe(false);
  });

  it('returns true during auto-trust pending phase', () => {
    mockAutoTrustFolders = true;
    markAgentSpawned('agent-1');

    // Feed trust dialog output to trigger tryAutoTrust via markAgentOutput
    const trustDialog = new TextEncoder().encode('Do you trust this folder?');
    markAgentOutput('agent-1', trustDialog, 'task-1');

    // The 50ms timer is now pending — settling should be true
    expect(isAutoTrustSettling('agent-1')).toBe(true);
  });

  it('returns true during cooldown after auto-trust fires', () => {
    mockAutoTrustFolders = true;
    markAgentSpawned('agent-1');

    const trustDialog = new TextEncoder().encode('Do you trust this folder?');
    markAgentOutput('agent-1', trustDialog, 'task-1');

    // Advance past the 50ms auto-trust timer
    vi.advanceTimersByTime(60);

    // Now in cooldown (3s) and settling (1s) — should still be true
    expect(isAutoTrustSettling('agent-1')).toBe(true);
  });

  it('remains true after settle period lapses while cooldown is still active', () => {
    // The 3s cooldown outlasts the 1s settle period.  isAutoTrustSettling
    // should still return true because isAutoTrustPending (cooldown) is true.
    mockAutoTrustFolders = true;
    markAgentSpawned('agent-1');

    const trustDialog = new TextEncoder().encode('Do you trust this folder?');
    markAgentOutput('agent-1', trustDialog, 'task-1');

    // Advance past auto-trust timer (50ms) + past settle (1000ms) but
    // still within cooldown (3000ms).
    vi.advanceTimersByTime(1200);

    // Settle period (1s from acceptance at ~50ms) has lapsed, but cooldown
    // (3s) is still active — settling should still report true.
    expect(isAutoTrustSettling('agent-1')).toBe(true);
  });

  it('returns false after settling period expires', () => {
    mockAutoTrustFolders = true;
    markAgentSpawned('agent-1');

    const trustDialog = new TextEncoder().encode('Do you trust this folder?');
    markAgentOutput('agent-1', trustDialog, 'task-1');

    // 50ms timer + 3000ms cooldown + 1000ms settle = 4050ms total
    vi.advanceTimersByTime(4100);

    expect(isAutoTrustSettling('agent-1')).toBe(false);
  });
});
