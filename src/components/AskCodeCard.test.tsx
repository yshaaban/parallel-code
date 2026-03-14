import { render, screen, waitFor } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';

import { AskCodeCard } from './AskCodeCard';

const { startAskAboutCodeSessionMock } = vi.hoisted(() => ({
  startAskAboutCodeSessionMock: vi.fn(),
}));

vi.mock('../app/task-workflows', () => ({
  startAskAboutCodeSession: startAskAboutCodeSessionMock,
}));

describe('AskCodeCard', () => {
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
