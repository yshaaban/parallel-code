import { describe, expect, it, vi } from 'vitest';
import { createServerStateBootstrapGate } from './server-state-bootstrap';

function createBootstrapDescriptors() {
  return {
    'agent-supervision': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'git-status': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'peer-presence': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'task-command-controller': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'remote-status': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'task-convergence': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'task-review': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
    'task-ports': {
      applyEvent: vi.fn(),
      applySnapshot: vi.fn(),
    },
  };
}

describe('server-state bootstrap gate', () => {
  it('applies hydrated snapshots before buffered events when startup completes', () => {
    const descriptors = createBootstrapDescriptors();
    const applyRemoteStatus = descriptors['remote-status'].applyEvent;
    const applyGitStatus = descriptors['git-status'].applyEvent;
    descriptors['remote-status'].applySnapshot = applyRemoteStatus;

    const gate = createServerStateBootstrapGate(descriptors);

    gate.handle('git-status', { worktreePath: '/tmp/task-1' });
    gate.handle('remote-status', {
      enabled: false,
      connectedClients: 0,
      peerClients: 0,
      port: 7777,
      tailscaleUrl: null,
      token: null,
      url: null,
      wifiUrl: null,
    });
    gate.hydrate('remote-status', {
      enabled: true,
      connectedClients: 2,
      peerClients: 1,
      port: 7777,
      tailscaleUrl: null,
      token: 'token',
      url: 'http://127.0.0.1:7777',
      wifiUrl: null,
    });

    gate.complete();

    expect(applyRemoteStatus.mock.calls).toEqual([
      [
        {
          enabled: true,
          connectedClients: 2,
          peerClients: 1,
          port: 7777,
          tailscaleUrl: null,
          token: 'token',
          url: 'http://127.0.0.1:7777',
          wifiUrl: null,
        },
      ],
      [
        {
          enabled: false,
          connectedClients: 0,
          peerClients: 0,
          port: 7777,
          tailscaleUrl: null,
          token: null,
          url: null,
          wifiUrl: null,
        },
      ],
    ]);
    expect(applyGitStatus).toHaveBeenCalledWith({ worktreePath: '/tmp/task-1' });
  });

  it('applies events directly after startup is ready', () => {
    const descriptors = createBootstrapDescriptors();
    const applyTaskPorts = descriptors['task-ports'].applyEvent;
    const applyTaskPortSnapshots = descriptors['task-ports'].applySnapshot;

    const gate = createServerStateBootstrapGate(descriptors);

    gate.complete();
    gate.hydrate('task-ports', []);
    gate.handle('task-ports', {
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_000,
    });

    expect(applyTaskPortSnapshots).toHaveBeenCalledWith([]);
    expect(applyTaskPorts).toHaveBeenCalledWith({
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_000,
    });
  });

  it('drops buffered snapshots and events when startup is disposed before completion', () => {
    const descriptors = createBootstrapDescriptors();
    const applyRemoteStatus = descriptors['remote-status'].applySnapshot;
    const applyTaskPorts = descriptors['task-ports'].applyEvent;

    const gate = createServerStateBootstrapGate(descriptors);

    gate.hydrate('remote-status', {
      enabled: true,
      connectedClients: 1,
      peerClients: 0,
      port: 7777,
      tailscaleUrl: null,
      token: 'token',
      url: 'http://127.0.0.1:7777',
      wifiUrl: null,
    });
    gate.handle('task-ports', {
      taskId: 'task-1',
      observed: [],
      exposed: [],
      updatedAt: 1_000,
    });
    gate.dispose();
    gate.complete();

    expect(applyRemoteStatus).not.toHaveBeenCalled();
    expect(applyTaskPorts).not.toHaveBeenCalled();
  });

  it('ignores hydrate and handle calls after disposal', () => {
    const descriptors = createBootstrapDescriptors();
    const applyTaskConvergence = descriptors['task-convergence'].applyEvent;
    descriptors['task-convergence'].applySnapshot = applyTaskConvergence;

    const gate = createServerStateBootstrapGate(descriptors);

    gate.dispose();
    gate.hydrate('task-convergence', []);
    gate.handle('task-convergence', {
      removed: true,
      taskId: 'task-1',
    });

    expect(applyTaskConvergence).not.toHaveBeenCalled();
  });
});
