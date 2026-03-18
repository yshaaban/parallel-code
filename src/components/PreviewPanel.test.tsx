import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTaskPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskPreviewUrlMock: vi.fn(),
}));

vi.mock('../app/task-ports', () => ({
  buildTaskPreviewUrl: buildTaskPreviewUrlMock,
}));

import { PreviewPanel } from './PreviewPanel';

type PreviewPanelProps = Parameters<typeof PreviewPanel>[0];

function createPreviewPanelProps(overrides: Partial<PreviewPanelProps> = {}): PreviewPanelProps {
  return {
    availableCandidates: [],
    availableScanError: null,
    availableScanning: false,
    taskId: 'task-1',
    snapshot: {
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_100,
    },
    onExposePort: vi.fn(),
    onHide: vi.fn(),
    onRefreshAvailablePorts: vi.fn(),
    onRefreshPort: vi.fn(),
    onUnexposePort: vi.fn(),
    ...overrides,
  };
}

function renderPreviewPanel(overrides: Partial<PreviewPanelProps> = {}): void {
  const props = createPreviewPanelProps(overrides);
  render(() => <PreviewPanel {...props} />);
}

describe('PreviewPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    buildTaskPreviewUrlMock.mockImplementation((taskId: string, port: number) => {
      return `http://preview.local/${taskId}/${port}`;
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders observed and exposed ports and opens an embedded preview for the selected exposed port', () => {
    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      snapshot: {
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
      },
    });

    expect(screen.getByText('Frontend')).toBeDefined();
    expect(screen.getByText('Listening in this task worktree')).toBeDefined();
    expect(screen.getByTitle('Task preview 3001').getAttribute('src')).toBe(
      'http://preview.local/task-1/3001',
    );
  });

  it('exposes available ports and unexposes mapped ports through callbacks', async () => {
    const onExposePort = vi.fn().mockResolvedValue(undefined);
    const onUnexposePort = vi.fn().mockResolvedValue(undefined);

    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      snapshot: {
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
      },
      onExposePort,
      onUnexposePort,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expose port 5173' }));
    expect(onExposePort).toHaveBeenCalledWith(5173, undefined);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));
    expect(onUnexposePort).toHaveBeenCalledWith(3001);
  });

  it('applies the shared label draft when exposing a detected port', async () => {
    const onExposePort = vi.fn().mockResolvedValue(undefined);

    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      onExposePort,
    });

    const [, labelInput] = screen.getAllByRole('textbox');
    fireEvent.input(labelInput, {
      currentTarget: { value: 'Frontend dev server' },
      target: { value: 'Frontend dev server' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expose port 5173' }));

    expect(onExposePort).toHaveBeenCalledWith(5173, 'Frontend dev server');
  });

  it('exposes a custom port inline', async () => {
    const onExposePort = vi.fn().mockResolvedValue(undefined);

    renderPreviewPanel({ onExposePort });

    const [portInput, labelInput] = screen.getAllByRole('textbox');
    fireEvent.input(portInput, { currentTarget: { value: '8080' }, target: { value: '8080' } });
    fireEvent.input(labelInput, {
      currentTarget: { value: 'Frontend dev server' },
      target: { value: 'Frontend dev server' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expose custom port' }));

    expect(onExposePort).toHaveBeenCalledWith(8080, 'Frontend dev server');
  });

  it('shows expose errors without leaking rejected candidate actions', async () => {
    const onExposePort = vi.fn().mockRejectedValue(new Error('Port is already exposed'));

    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      onExposePort,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Expose port 5173' }));

    await waitFor(() => {
      expect(screen.getByText('Port is already exposed')).toBeDefined();
    });
  });

  it('keeps available ports visible when rescans fail and shows the scan error', () => {
    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      availableScanError: 'Scan failed',
    });

    expect(screen.getByText('Listening in this task worktree')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Scan failed');
  });

  it('marks output-detected ports as suggestions when no current listeners were found', () => {
    renderPreviewPanel({
      snapshot: {
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
        exposed: [],
        updatedAt: 1_100,
      },
    });

    expect(screen.getByRole('status').textContent).toContain(
      'No active local listeners were found in the latest scan.',
    );
  });

  it('shows unavailable preview diagnostics and retries through the callback', async () => {
    const onRefreshPort = vi.fn().mockResolvedValue(undefined);

    renderPreviewPanel({
      snapshot: {
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
      },
      onRefreshPort,
    });

    expect(
      screen.getAllByText('Preview target is not reachable on loopback port 3001.').length,
    ).toBeGreaterThan(0);
    const retryButton = screen.getByRole('button', { name: 'Retry preview for port 3001' });
    expect(retryButton).toBeDefined();
    fireEvent.click(retryButton as HTMLButtonElement);
    expect(onRefreshPort).toHaveBeenCalledWith(3001);
  });

  it('hides the preview through the callback', async () => {
    const onHide = vi.fn();

    renderPreviewPanel({
      snapshot: {
        taskId: 'task-1',
        observed: [],
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
      },
      onHide,
    });

    const hidePreviewButton = screen.getByRole('button', { name: 'Hide preview' });
    fireEvent.click(hidePreviewButton as HTMLButtonElement);
    await waitFor(() => {
      expect(onHide).toHaveBeenCalledTimes(1);
    });
  });
});
