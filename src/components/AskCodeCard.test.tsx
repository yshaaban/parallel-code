import { cleanup, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AskCodeCard } from './AskCodeCard';

const { startAskAboutCodeSessionMock } = vi.hoisted(() => ({
  startAskAboutCodeSessionMock: vi.fn(),
}));

vi.mock('../app/task-workflows', () => ({
  startAskAboutCodeSession: startAskAboutCodeSessionMock,
}));

describe('AskCodeCard', () => {
  beforeEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('announces each loading phase once while keeping the streamed dot decorative', async () => {
    let emit: ((message: { type: string; text?: string }) => void) | undefined;
    startAskAboutCodeSessionMock.mockImplementation(
      (
        _requestId,
        _prompt,
        _cwd,
        onMessage: (message: { type: string; text?: string }) => void,
      ) => {
        emit = onMessage;
        return new Promise(() => {});
      },
    );

    const result = render(() => (
      <AskCodeCard
        endLine={8}
        onDismiss={vi.fn()}
        question="Why is this cached?"
        requestId="question-loading"
        selectedText="return cache.get(key);"
        source="src/example.ts"
        startLine={8}
        startSession={startAskAboutCodeSessionMock}
        worktreePath="/tmp/task"
      />
    ));

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Thinking...');
    expect(screen.getByRole('status').classList.contains('askcode-loading-pulse')).toBe(true);

    emit?.({ type: 'chunk', text: 'First chunk' });
    await waitFor(() => expect(screen.getByText('Still receiving response')).toBeTruthy());

    expect(screen.getAllByRole('status')).toHaveLength(1);
    const tail = result.container.querySelector<HTMLElement>(
      '.askcode-loading-pulse[aria-hidden="true"]',
    );
    expect(tail).not.toBeNull();
    expect(tail?.style.getPropertyValue('--askcode-pulse-duration')).toBe('1s');

    emit?.({ type: 'done' });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(result.container.querySelector('.askcode-loading-pulse')).toBeNull();
  });

  it('renders streamed ask-about-code output and dismisses through the session', async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    startAskAboutCodeSessionMock.mockImplementation(
      async (
        _requestId,
        _prompt,
        _cwd,
        onMessage: (message: { type: string; text?: string }) => void,
      ) => {
        onMessage({ type: 'chunk', text: 'First chunk' });
        onMessage({ type: 'done' });
        return {
          cancel: cancelMock,
          cleanup: vi.fn(),
        };
      },
    );

    const onDismiss = vi.fn();
    render(() => (
      <AskCodeCard
        endLine={8}
        onDismiss={onDismiss}
        question="Why is this cached?"
        requestId="question-1"
        selectedText="return cache.get(key);"
        source="src/example.ts"
        startLine={8}
        startSession={startAskAboutCodeSessionMock}
        worktreePath="/tmp/task"
      />
    ));

    await waitFor(() => {
      expect(screen.getByText('First chunk')).toBeTruthy();
    });

    expect(startAskAboutCodeSessionMock).toHaveBeenCalled();
    expect(screen.getByText(/Q: Why is this cached\?/)).toBeTruthy();
  });
});
