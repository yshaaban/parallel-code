import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPortSnapshot } from '../domain/server-state';

const { buildTaskPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskPreviewUrlMock: vi.fn(),
}));
const { buildTaskContainerPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskContainerPreviewUrlMock: vi.fn(),
}));

vi.mock('../app/task-ports', () => ({
  buildTaskPreviewUrl: buildTaskPreviewUrlMock,
}));
vi.mock('../app/task-containers', () => ({
  buildTaskContainerPreviewUrl: buildTaskContainerPreviewUrlMock,
}));

import { PreviewPanel } from './PreviewPanel';

type PreviewPanelProps = Parameters<typeof PreviewPanel>[0];

interface PreviewPortTestOptions {
  label?: string;
  port?: number;
}

function createPreviewPanelProps(overrides: Partial<PreviewPanelProps> = {}): PreviewPanelProps {
  return {
    availableCandidates: [],
    availableScanError: null,
    availableScanning: false,
    containerActionError: null,
    containerInspect: null,
    containerInspectError: null,
    containerInspectLoading: false,
    containerLogs: null,
    containerLogsError: null,
    containerLogsLoading: false,
    taskId: 'task-1',
    snapshot: {
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_100,
    },
    onDestroyContainers: vi.fn(),
    onExposePort: vi.fn(),
    onHide: vi.fn(),
    onRefreshContainerInspect: vi.fn(),
    onRefreshContainerLogs: vi.fn(),
    onRefreshAvailablePorts: vi.fn(),
    onRefreshPort: vi.fn(),
    onStartContainers: vi.fn(),
    onStopContainers: vi.fn(),
    onUnexposePort: vi.fn(),
    ...overrides,
  };
}

function renderPreviewPanel(overrides: Partial<PreviewPanelProps> = {}): void {
  const props = createPreviewPanelProps(overrides);
  render(() => <PreviewPanel {...props} />);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

function createUnknownPreviewPort(updatedAt: number): TaskPortSnapshot['exposed'][number] {
  return {
    availability: 'unknown',
    host: null,
    label: 'Frontend',
    lastVerifiedAt: null,
    port: 3001,
    protocol: 'http',
    statusMessage: null,
    source: 'manual',
    updatedAt,
    verifiedHost: null,
  };
}

function createAvailablePreviewPort(
  updatedAt: number,
  options: PreviewPortTestOptions = {},
): TaskPortSnapshot['exposed'][number] {
  const port = options.port ?? 3001;

  return {
    availability: 'available',
    host: null,
    label: options.label ?? 'Frontend',
    lastVerifiedAt: updatedAt,
    port,
    protocol: 'http',
    statusMessage: null,
    source: 'manual',
    updatedAt,
    verifiedHost: '127.0.0.1',
  };
}

function createUnavailablePreviewPort(updatedAt: number): TaskPortSnapshot['exposed'][number] {
  return {
    availability: 'unavailable',
    host: null,
    label: 'Frontend',
    lastVerifiedAt: updatedAt,
    port: 3001,
    protocol: 'http',
    statusMessage: 'Preview target is not reachable on loopback port 3001.',
    source: 'manual',
    updatedAt,
    verifiedHost: null,
  };
}

function createPreviewSnapshot(
  exposed: TaskPortSnapshot['exposed'],
  updatedAt = exposed[0]?.updatedAt ?? 1_100,
): TaskPortSnapshot {
  return {
    taskId: 'task-1',
    observed: [],
    exposed,
    updatedAt,
  };
}

describe('PreviewPanel', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    buildTaskPreviewUrlMock.mockImplementation((taskId: string, port: number) => {
      return `http://preview.local/${taskId}/${port}`;
    });
    buildTaskContainerPreviewUrlMock.mockImplementation(
      (taskId: string, preview: { port: number }) => {
        return `http://containers.local/${taskId}/${preview.port}`;
      },
    );
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
    await waitFor(() => {
      expect(onExposePort).toHaveBeenCalledWith(5173, undefined);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));
    await waitFor(() => {
      expect(onUnexposePort).toHaveBeenCalledWith(3001);
    });
  });

  it('surfaces unexpose failures on the exposed port card', async () => {
    const onUnexposePort = vi.fn().mockRejectedValue(new Error('Failed to revoke exposure'));

    renderPreviewPanel({
      snapshot: {
        taskId: 'task-1',
        observed: [],
        exposed: [createAvailablePreviewPort(1_100)],
        updatedAt: 1_100,
      },
      onUnexposePort,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to revoke exposure')).toBeDefined();
    });
    expect(onUnexposePort).toHaveBeenCalledWith(3001);
  });

  it('clears unexpose failures when backend exposure state removes the port', async () => {
    const onUnexposePort = vi.fn().mockRejectedValue(new Error('Failed to revoke exposure'));
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>({
      taskId: 'task-1',
      observed: [],
      exposed: [createAvailablePreviewPort(1_100)],
      updatedAt: 1_100,
    });
    const props = createPreviewPanelProps({ onUnexposePort });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to revoke exposure')).toBeDefined();
    });

    setSnapshot({
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_200,
    });

    await waitFor(() => {
      expect(screen.queryByText('Failed to revoke exposure')).toBeNull();
    });
  });

  it('ignores stale unexpose failures after backend exposure state updates the same port', async () => {
    const unexposeResult = createDeferred<undefined>();
    const onUnexposePort = vi.fn().mockReturnValue(unexposeResult.promise);
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([createAvailablePreviewPort(1_100)]),
    );
    const props = createPreviewPanelProps({ onUnexposePort });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));
    expect(onUnexposePort).toHaveBeenCalledWith(3001);

    setSnapshot(createPreviewSnapshot([createAvailablePreviewPort(1_200)]));

    unexposeResult.reject(new Error('Old unexpose failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Old unexpose failed')).toBeNull();
  });

  it('clears unexpose busy state when backend exposure truth removes the port before action settles', async () => {
    const unexposeResult = createDeferred<undefined>();
    const onUnexposePort = vi.fn().mockReturnValue(unexposeResult.promise);
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([createAvailablePreviewPort(1_100)]),
    );
    const props = createPreviewPanelProps({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'Listening in this task worktree',
        },
      ],
      onUnexposePort,
    });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unexpose port 3001' }));
    expect(screen.getByRole('button', { name: 'Expose port 5173' })).toHaveProperty(
      'disabled',
      true,
    );

    setSnapshot(createPreviewSnapshot([], 1_200));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expose port 5173' })).toHaveProperty(
        'disabled',
        false,
      );
    });

    unexposeResult.reject(new Error('Old unexpose failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Old unexpose failed')).toBeNull();
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

    await waitFor(() => {
      expect(onExposePort).toHaveBeenCalledWith(5173, 'Frontend dev server');
    });
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

    await waitFor(() => {
      expect(onExposePort).toHaveBeenCalledWith(8080, 'Frontend dev server');
    });
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

    await Promise.resolve();
    await Promise.resolve();

    expect(onExposePort).toHaveBeenCalledWith(5173, undefined);
    expect(screen.getByText('Port is already exposed')).toBeDefined();
  });

  it('ignores stale expose failures after backend exposure state adds the port', async () => {
    const exposeResult = createDeferred<undefined>();
    const onExposePort = vi.fn().mockReturnValue(exposeResult.promise);
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([], 1_100),
    );
    const props = createPreviewPanelProps({
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

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expose port 5173' }));
    expect(onExposePort).toHaveBeenCalledWith(5173, undefined);

    setSnapshot(createPreviewSnapshot([createAvailablePreviewPort(1_200, { port: 5173 })]));

    exposeResult.reject(new Error('Old expose failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Old expose failed')).toBeNull();
    expect(screen.getByTitle('Task preview 5173').getAttribute('src')).toBe(
      'http://preview.local/task-1/5173',
    );
  });

  it('clears expose busy state when backend exposure truth adds the port before action settles', async () => {
    const exposeResult = createDeferred<undefined>();
    const onExposePort = vi.fn().mockReturnValue(exposeResult.promise);
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([], 1_100),
    );
    const props = createPreviewPanelProps({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'First app',
        },
        {
          host: '127.0.0.1',
          port: 3000,
          source: 'task',
          suggestion: 'Second app',
        },
      ],
      onExposePort,
    });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expose port 5173' }));
    expect(screen.getByRole('button', { name: 'Expose port 3000' })).toHaveProperty(
      'disabled',
      true,
    );

    setSnapshot(createPreviewSnapshot([createAvailablePreviewPort(1_200, { port: 5173 })]));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expose port 3000' })).toHaveProperty(
        'disabled',
        false,
      );
    });
    expect(screen.getByRole('button', { name: 'Expose custom port' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(screen.getByTitle('Task preview 5173').getAttribute('src')).toBe(
      'http://preview.local/task-1/5173',
    );

    exposeResult.reject(new Error('Old expose failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Old expose failed')).toBeNull();
  });

  it('prevents concurrent expose requests from racing selected preview state', async () => {
    const firstExpose = createDeferred<undefined>();
    const onExposePort = vi.fn((port: number) => {
      if (port === 5173) {
        return firstExpose.promise;
      }

      return Promise.resolve();
    });
    const onUnexposePort = vi.fn().mockResolvedValue(undefined);

    renderPreviewPanel({
      availableCandidates: [
        {
          host: '127.0.0.1',
          port: 5173,
          source: 'task',
          suggestion: 'First app',
        },
        {
          host: '127.0.0.1',
          port: 3000,
          source: 'task',
          suggestion: 'Second app',
        },
      ],
      snapshot: {
        taskId: 'task-1',
        observed: [],
        exposed: [createAvailablePreviewPort(1_100)],
        updatedAt: 1_100,
      },
      onExposePort,
      onUnexposePort,
    });

    const firstExposeButton = screen.getByRole('button', { name: 'Expose port 5173' });
    const secondExposeButton = screen.getByRole('button', { name: 'Expose port 3000' });
    const unexposeButton = screen.getByRole('button', { name: 'Unexpose port 3001' });

    fireEvent.click(firstExposeButton);

    expect(onExposePort).toHaveBeenCalledWith(5173, undefined);
    expect(secondExposeButton).toHaveProperty('disabled', true);
    expect(unexposeButton).toHaveProperty('disabled', true);

    fireEvent.click(secondExposeButton);
    expect(onExposePort).toHaveBeenCalledTimes(1);
    fireEvent.click(unexposeButton);
    expect(onUnexposePort).not.toHaveBeenCalled();

    firstExpose.reject(new Error('First expose failed'));

    await waitFor(() => {
      expect(screen.getByText('First expose failed')).toBeDefined();
    });
    expect(secondExposeButton).toHaveProperty('disabled', false);
    expect(unexposeButton).toHaveProperty('disabled', false);
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

  it('shows unavailable preview diagnostics and retries through the callback', () => {
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

  it('auto-refreshes an unknown preview once per exposed port revision', async () => {
    const onRefreshPort = vi.fn().mockResolvedValue(undefined);
    function createSnapshot(
      portUpdatedAt: number,
      snapshotUpdatedAt = portUpdatedAt,
    ): TaskPortSnapshot {
      return createPreviewSnapshot([createUnknownPreviewPort(portUpdatedAt)], snapshotUpdatedAt);
    }

    const [snapshot, setSnapshot] = createSignal(createSnapshot(1_100));
    const props = createPreviewPanelProps({
      onRefreshPort,
    });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    await waitFor(() => {
      expect(onRefreshPort).toHaveBeenCalledTimes(1);
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onRefreshPort).toHaveBeenCalledTimes(1);

    setSnapshot(createSnapshot(1_100, 1_200));
    await Promise.resolve();
    await Promise.resolve();
    expect(onRefreshPort).toHaveBeenCalledTimes(1);

    setSnapshot(createSnapshot(1_300));

    await waitFor(() => {
      expect(onRefreshPort).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps the selected preview stable when backend snapshots update another exposed port', async () => {
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([
        createAvailablePreviewPort(1_100),
        createAvailablePreviewPort(1_100, { label: 'Docs', port: 5173 }),
      ]),
    );
    const props = createPreviewPanelProps();

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    fireEvent.click(screen.getByRole('button', { name: /Docs/ }));

    await waitFor(() => {
      expect(screen.getByTitle('Task preview 5173').getAttribute('src')).toBe(
        'http://preview.local/task-1/5173',
      );
    });

    setSnapshot(
      createPreviewSnapshot([
        createAvailablePreviewPort(1_200),
        createAvailablePreviewPort(1_100, { label: 'Docs', port: 5173 }),
      ]),
    );

    await waitFor(() => {
      expect(screen.getByTitle('Task preview 5173').getAttribute('src')).toBe(
        'http://preview.local/task-1/5173',
      );
    });
  });

  it('surfaces preview refresh failures without retrying the same unknown snapshot', async () => {
    const onRefreshPort = vi.fn().mockRejectedValue(new Error('Preview refresh failed'));

    renderPreviewPanel({
      snapshot: createPreviewSnapshot([createUnknownPreviewPort(1_100)]),
      onRefreshPort,
    });

    await waitFor(() => {
      expect(screen.getByText('Preview refresh failed')).toBeDefined();
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onRefreshPort).toHaveBeenCalledTimes(1);
  });

  it('does not let a stale refresh failure block a newer preview revision', async () => {
    const firstRefresh = createDeferred<undefined>();
    const secondRefresh = createDeferred<undefined>();
    const refreshResults = [firstRefresh.promise, secondRefresh.promise];
    const onRefreshPort = vi.fn(() => refreshResults.shift() ?? Promise.resolve());
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([createUnknownPreviewPort(1_100)]),
    );
    const props = createPreviewPanelProps({
      onRefreshPort,
    });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    await waitFor(() => {
      expect(onRefreshPort).toHaveBeenCalledTimes(1);
    });

    setSnapshot(createPreviewSnapshot([createUnknownPreviewPort(1_200)]));

    await waitFor(() => {
      expect(onRefreshPort).toHaveBeenCalledTimes(2);
    });

    firstRefresh.reject(new Error('Old preview refresh failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByText('Old preview refresh failed')).toBeNull();

    secondRefresh.reject(new Error('Current preview refresh failed'));

    await waitFor(() => {
      expect(screen.getByText('Current preview refresh failed')).toBeDefined();
    });
  });

  it('clears preview refresh failures when backend availability changes', async () => {
    const onRefreshPort = vi.fn().mockRejectedValue(new Error('Preview refresh failed'));
    const [snapshot, setSnapshot] = createSignal<TaskPortSnapshot>(
      createPreviewSnapshot([createUnknownPreviewPort(1_100)]),
    );
    const props = createPreviewPanelProps({
      onRefreshPort,
    });

    render(() => <PreviewPanel {...props} snapshot={snapshot()} />);

    await waitFor(() => {
      expect(screen.getByText('Preview refresh failed')).toBeDefined();
    });

    setSnapshot(createPreviewSnapshot([createUnavailablePreviewPort(1_200)]));

    await waitFor(() => {
      expect(screen.queryByText('Preview refresh failed')).toBeNull();
    });
    expect(
      screen.getAllByText('Preview target is not reachable on loopback port 3001.').length,
    ).toBeGreaterThan(0);
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

    const hidePreviewButton = screen.getByRole('button', { name: 'Hide preview manager' });
    fireEvent.click(hidePreviewButton as HTMLButtonElement);
    await waitFor(() => {
      expect(onHide).toHaveBeenCalledTimes(1);
    });
  });

  it('renders task container actions and previews inside the preview manager', () => {
    const onStartContainers = vi.fn();

    renderPreviewPanel({
      containerInspect: {
        composeFile: '/repo/compose.yaml',
        issues: [],
        observedAt: 1_000,
        previews: [{ label: 'Web app', port: 3000, protocol: 'http', source: 'configured' }],
        projectName: 'parallel-repo-task',
        publishedPorts: [],
        runtime: 'docker-compose',
        services: [
          {
            containerId: 'container-1',
            health: 'healthy',
            name: 'web',
            publishedPorts: [],
            state: 'running',
          },
        ],
        status: 'ready',
        taskId: 'task-1',
      },
      onStartContainers,
    });

    expect(screen.getByText('Containers')).toBeDefined();
    expect(screen.getByText('Compose file: /repo/compose.yaml')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStartContainers).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Web app').getAttribute('href')).toBe(
      'http://containers.local/task-1/3000',
    );
  });

  it('surfaces task container errors in the preview manager', () => {
    renderPreviewPanel({
      containerActionError: 'Failed to update the task container.',
      containerInspectError: 'Failed to inspect the task container.',
      containerLogsError: 'Failed to load task container logs.',
    });

    expect(screen.getByText('Failed to inspect the task container.')).toBeDefined();
    expect(screen.getByText('Failed to load task container logs.')).toBeDefined();
    expect(screen.getByText('Failed to update the task container.')).toBeDefined();
  });
});
