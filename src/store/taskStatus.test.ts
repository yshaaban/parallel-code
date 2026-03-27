import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

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

vi.mock('../app/task-command-lease', () => ({
  runWithAgentTaskCommandLease: vi.fn(
    async (_agentId: string, _actionDescription: string, run: () => Promise<void>) => run(),
  ),
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
  hasHydraPromptInTail,
  hasShellPromptReadyInTail,
  hasReadyPromptInTail,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  isAgentAskingQuestion,
  markAgentSpawned,
  markAgentOutput,
  clearAgentActivity,
  resetTaskStatusStateForTests,
} from './taskStatus';
import { invoke } from '../lib/ipc';

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetTaskStatusStateForTests();
  mockAutoTrustFolders = false;
  mockActiveTaskId = 'task-1';
});

afterEach(() => {
  clearAgentActivity('agent-1');
  resetTaskStatusStateForTests();
  vi.clearAllTimers();
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

  it('removes terminal query replies instead of surfacing them as preview text', () => {
    expect(stripAnsi('\x1b[>0q\x1b[c')).toBe('');
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

  it('returns false when a Hydra prompt is the last visible line', () => {
    const tail = 'Do you trust this folder?\nhydra[gpt-5.4]>';
    expect(looksLikeQuestion(tail)).toBe(false);
  });

  it('returns true when a Hydra prompt follows an interactive choice tail', () => {
    const tail = 'Use arrow keys to cycle\nSelect an option\nhydra[gpt-5.4]>';
    expect(looksLikeQuestion(tail)).toBe(true);
  });

  it('returns false for prompt tails with shortcut-only permission footers', () => {
    const tail =
      'What would you like to work on?\n⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ';
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

describe('Hydra prompt detection', () => {
  it('detects a bare Hydra operator prompt in the tail buffer', () => {
    expect(hasHydraPromptInTail('hydra>')).toBe(true);
    expect(hasReadyPromptInTail('hydra>')).toBe(true);
  });

  it('detects model-qualified Hydra prompts despite trailing footer redraw noise', () => {
    const tail = 'workers ready\nhydra[gpt-5.4]>\nstatus: idle';
    expect(hasHydraPromptInTail(tail)).toBe(true);
    expect(hasReadyPromptInTail(tail)).toBe(true);
  });

  it('detects Hydra prompts despite repeated redraw-heavy footer updates', () => {
    const footer =
      '\x1b[s\x1b[1;29r\x1b[29;1H\x1b[30;1H\x1b[2K──────────────────────────────────────────────────────────────\x1b[31;1H\x1b[2K ↻ auto  │  0 tasks                                           \x1b[32;1H\x1b[2K● ✦ GEMINI Inact…  │  ● ֎ CODEX Inacti…  │  ● ❋ CLAUDE Inact…\x1b[33;1H\x1b[2K  ↳ awaiting events...\x1b[34;1H\x1b[2K\x1b[u';
    const tail = `hydra>\x1b[8GDescribe a task to dispatch to agents${footer.repeat(8)}`;
    expect(hasHydraPromptInTail(tail)).toBe(true);
    expect(hasReadyPromptInTail(tail)).toBe(true);
  });

  it('does not confuse normal output with a Hydra prompt', () => {
    expect(hasHydraPromptInTail('starting hydra daemon')).toBe(false);
    expect(hasReadyPromptInTail('starting hydra daemon')).toBe(false);
  });
});

describe('shell prompt detection', () => {
  it('treats common shell prompts as prompt-ready', () => {
    expect(hasShellPromptReadyInTail('user@host:~$ ')).toBe(true);
    expect(hasShellPromptReadyInTail('build % ')).toBe(true);
    expect(hasShellPromptReadyInTail('root# ')).toBe(true);
    expect(hasShellPromptReadyInTail('❯ ')).toBe(true);
    expect(hasShellPromptReadyInTail('hydra[gpt-5.4]>')).toBe(true);
  });

  it('does not treat confirmation prompts as shell-ready', () => {
    expect(hasShellPromptReadyInTail('Continue? [Y/n] ')).toBe(false);
    expect(hasShellPromptReadyInTail('Proceed? [y/N] ')).toBe(false);
  });

  it('does not treat ordinary progress or prose suffixes as prompt-ready', () => {
    expect(hasShellPromptReadyInTail('download progress 99%')).toBe(false);
    expect(hasShellPromptReadyInTail('total cost $')).toBe(false);
    expect(hasShellPromptReadyInTail('build #')).toBe(false);
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

describe('markAgentOutput', () => {
  it('auto-accepts trust dialogs when auto-trust is enabled', async () => {
    mockAutoTrustFolders = true;
    markAgentSpawned('agent-1');

    markAgentOutput('agent-1', new TextEncoder().encode('Do you trust this folder?'), 'task-1');
    vi.advanceTimersByTime(260);
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledWith(IPC.WriteToAgent, {
      agentId: 'agent-1',
      data: '\r',
    });
  });

  it('marks the agent as asking a question when a confirmation prompt appears', () => {
    markAgentSpawned('agent-1');

    markAgentOutput('agent-1', new TextEncoder().encode('Proceed? [y/N]'), 'task-1');

    expect(isAgentAskingQuestion('agent-1')).toBe(true);
  });

  it('clears the question state after normal output resumes', () => {
    markAgentSpawned('agent-1');

    markAgentOutput('agent-1', new TextEncoder().encode('Proceed? [y/N]'), 'task-1');
    expect(isAgentAskingQuestion('agent-1')).toBe(true);

    markAgentOutput('agent-1', new TextEncoder().encode('Continuing work...\n'), 'task-1');
    vi.advanceTimersByTime(250);

    expect(isAgentAskingQuestion('agent-1')).toBe(false);
  });
});
