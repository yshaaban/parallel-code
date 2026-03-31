import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildTaskContainerPreviewUrlMock } = vi.hoisted(() => ({
  buildTaskContainerPreviewUrlMock: vi.fn(),
}));

vi.mock('../app/task-containers', () => ({
  buildTaskContainerPreviewUrl: buildTaskContainerPreviewUrlMock,
}));

import { TaskContainersPanel } from './TaskContainersPanel';

function createPanelProps() {
  return {
    inspect: null,
    loading: false,
    logs: null,
    logsLoading: false,
    onDestroy: vi.fn(),
    onRefresh: vi.fn(),
    onRefreshLogs: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
  };
}

describe('TaskContainersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildTaskContainerPreviewUrlMock.mockImplementation(
      (taskId: string, preview: { port: number }) => {
        return `http://containers.local/${taskId}/${preview.port}`;
      },
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the ready state with start action and configured previews', () => {
    const props = createPanelProps();

    render(() => (
      <TaskContainersPanel
        {...props}
        inspect={{
          composeFile: '/tmp/project/compose.yaml',
          issues: [],
          observedAt: Date.now(),
          previews: [
            {
              label: 'Web',
              port: 3000,
              protocol: 'http',
              source: 'configured',
            },
          ],
          projectName: 'parallel-project-task',
          publishedPorts: [],
          runtime: 'docker-compose',
          services: [
            {
              containerId: 'abc123',
              health: null,
              name: 'web',
              publishedPorts: [],
              state: 'running',
            },
          ],
          status: 'ready',
          taskId: 'task-1',
        }}
      />
    ));

    expect(screen.getByText('Ready')).toBeDefined();
    expect(screen.getByText('Compose file: /tmp/project/compose.yaml')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Web' }).getAttribute('href')).toBe(
      'http://containers.local/task-1/3000',
    );
    expect(screen.getByText('web: running')).toBeDefined();
  });

  it('renders running actions, issues, and logs refresh controls', () => {
    const props = createPanelProps();

    render(() => (
      <TaskContainersPanel
        {...props}
        logs={{
          generatedAt: Date.now(),
          taskId: 'task-1',
          text: 'service log line',
          truncated: true,
        }}
        inspect={{
          composeFile: '/tmp/project/compose.yaml',
          issues: [
            {
              code: 'fixed_host_port_conflict',
              message: 'Host port 3000 is already in use.',
              severity: 'warning',
            },
          ],
          observedAt: Date.now(),
          previews: [],
          projectName: 'parallel-project-task',
          publishedPorts: [],
          runtime: 'docker-compose',
          services: [],
          status: 'running',
          taskId: 'task-1',
        }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load logs' }));

    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onDestroy).toHaveBeenCalledTimes(1);
    expect(props.onRefreshLogs).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Host port 3000 is already in use.')).toBeDefined();
    expect(screen.getByText('service log line')).toBeDefined();
    expect(screen.getByText('Showing the most recent container log tail.')).toBeDefined();
  });
});
