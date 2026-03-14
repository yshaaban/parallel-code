import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTaskPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskPreviewUrlMock: vi.fn(),
}));

vi.mock('../app/task-ports', () => ({
  buildTaskPreviewUrl: buildTaskPreviewUrlMock,
}));

import { PreviewPanel } from './PreviewPanel';

describe('PreviewPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    buildTaskPreviewUrlMock.mockImplementation((taskId: string, port: number) => {
      return `http://preview.local/${taskId}/${port}`;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders observed and exposed ports and opens an embedded preview for the selected exposed port', () => {
    render(() => (
      <PreviewPanel
        taskId="task-1"
        snapshot={{
          taskId: 'task-1',
          observed: [
            {
              host: '127.0.0.1',
              port: 5173,
              protocol: 'http',
              source: 'output',
              suggestion: 'http://127.0.0.1:5173',
              updatedAt: 1_000,
            },
          ],
          exposed: [
            {
              availability: 'available',
              host: null,
              label: 'Frontend',
              lastVerifiedAt: 1_100,
              port: 3001,
              protocol: 'http',
              statusMessage: null,
              source: 'manual',
              updatedAt: 1_100,
              verifiedHost: '127.0.0.1',
            },
          ],
          updatedAt: 1_100,
        }}
        onExposeObservedPort={vi.fn()}
        onOpenExposeDialog={vi.fn()}
        onRefreshPort={vi.fn()}
        onUnexposePort={vi.fn()}
      />
    ));

    expect(screen.getByText('Frontend')).toBeDefined();
    expect(screen.getByText('http://127.0.0.1:5173')).toBeDefined();
    expect(screen.getByTitle('Task preview 3001').getAttribute('src')).toBe(
      'http://preview.local/task-1/3001',
    );
  });

  it('exposes observed ports and unexposes mapped ports through callbacks', async () => {
    const onExposeObservedPort = vi.fn().mockResolvedValue(undefined);
    const onUnexposePort = vi.fn().mockResolvedValue(undefined);

    render(() => (
      <PreviewPanel
        taskId="task-1"
        snapshot={{
          taskId: 'task-1',
          observed: [
            {
              host: '127.0.0.1',
              port: 5173,
              protocol: 'http',
              source: 'output',
              suggestion: 'http://127.0.0.1:5173',
              updatedAt: 1_000,
            },
          ],
          exposed: [
            {
              availability: 'available',
              host: null,
              label: null,
              lastVerifiedAt: 1_100,
              port: 3001,
              protocol: 'http',
              statusMessage: null,
              source: 'manual',
              updatedAt: 1_100,
              verifiedHost: '127.0.0.1',
            },
          ],
          updatedAt: 1_100,
        }}
        onExposeObservedPort={onExposeObservedPort}
        onOpenExposeDialog={vi.fn()}
        onRefreshPort={vi.fn()}
        onUnexposePort={onUnexposePort}
      />
    ));

    const exposeButtons = screen.getAllByRole('button', { name: 'Expose' });
    fireEvent.click(exposeButtons[exposeButtons.length - 1] as HTMLButtonElement);
    expect(onExposeObservedPort).toHaveBeenCalledWith(5173);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose' }));
    expect(onUnexposePort).toHaveBeenCalledWith(3001);
  });

  it('shows unavailable preview diagnostics and retries through the callback', async () => {
    const onRefreshPort = vi.fn().mockResolvedValue(undefined);

    render(() => (
      <PreviewPanel
        taskId="task-1"
        snapshot={{
          taskId: 'task-1',
          observed: [],
          exposed: [
            {
              availability: 'unavailable',
              host: null,
              label: 'Frontend',
              lastVerifiedAt: 1_100,
              port: 3001,
              protocol: 'http',
              statusMessage: 'Preview target is not reachable on loopback port 3001.',
              source: 'manual',
              updatedAt: 1_100,
              verifiedHost: null,
            },
          ],
          updatedAt: 1_100,
        }}
        onExposeObservedPort={vi.fn()}
        onOpenExposeDialog={vi.fn()}
        onRefreshPort={onRefreshPort}
        onUnexposePort={vi.fn()}
      />
    ));

    expect(
      screen.getAllByText('Preview target is not reachable on loopback port 3001.').length,
    ).toBeGreaterThan(0);
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons[0]).toBeDefined();
    fireEvent.click(retryButtons[0] as HTMLButtonElement);
    expect(onRefreshPort).toHaveBeenCalledWith(3001);
  });
});
