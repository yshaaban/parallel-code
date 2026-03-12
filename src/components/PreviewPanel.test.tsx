import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTaskPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskPreviewUrlMock: vi.fn(),
}));

vi.mock('../app/task-ports', () => ({
  buildTaskPreviewUrl: buildTaskPreviewUrlMock,
}));

import { PreviewPanel } from './PreviewPanel';

describe('PreviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildTaskPreviewUrlMock.mockImplementation((taskId: string, port: number) => {
      return `http://preview.local/${taskId}/${port}`;
    });
  });

  it('renders observed and exposed ports and opens an embedded preview for the selected exposed port', () => {
    render(() => (
      <PreviewPanel
        taskId="task-1"
        snapshot={{
          taskId: 'task-1',
          observed: [
            {
              port: 5173,
              protocol: 'http',
              source: 'output',
              suggestion: 'http://127.0.0.1:5173',
              updatedAt: 1_000,
            },
          ],
          exposed: [
            {
              label: 'Frontend',
              port: 3001,
              protocol: 'http',
              source: 'manual',
              updatedAt: 1_100,
            },
          ],
          updatedAt: 1_100,
        }}
        onExposeObservedPort={vi.fn()}
        onOpenExposeDialog={vi.fn()}
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
              port: 5173,
              protocol: 'http',
              source: 'output',
              suggestion: 'http://127.0.0.1:5173',
              updatedAt: 1_000,
            },
          ],
          exposed: [
            {
              label: null,
              port: 3001,
              protocol: 'http',
              source: 'manual',
              updatedAt: 1_100,
            },
          ],
          updatedAt: 1_100,
        }}
        onExposeObservedPort={onExposeObservedPort}
        onOpenExposeDialog={vi.fn()}
        onUnexposePort={onUnexposePort}
      />
    ));

    const exposeButtons = screen.getAllByRole('button', { name: 'Expose' });
    fireEvent.click(exposeButtons[0]);
    expect(onExposeObservedPort).toHaveBeenCalledWith(5173);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose' }));
    expect(onUnexposePort).toHaveBeenCalledWith(3001);
  });
});
