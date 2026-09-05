import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const remoteCollaborationSource = readFileSync(
  path.resolve(projectRoot, 'src/remote/remote-collaboration.ts'),
  'utf8',
);
const remoteWsSource = readFileSync(path.resolve(projectRoot, 'src/remote/ws.ts'), 'utf8');
const remoteProtocolSource = readFileSync(
  path.resolve(projectRoot, 'electron/remote/protocol.ts'),
  'utf8',
);
const taskCatalogMessageSource = readFileSync(
  path.resolve(projectRoot, 'electron/remote/remote-base-message.ts'),
  'utf8',
);

describe('remote state boundary architecture guardrails', () => {
  it('keeps remote bootstrap validation delegated to domain-owned guards', () => {
    expect(remoteCollaborationSource).toContain('filterServerStateBootstrapSnapshots');
    expect(remoteCollaborationSource).toContain('isAgentSupervisionEvent');
    expect(remoteCollaborationSource).toContain('isTaskCommandControllerSnapshot');
    expect(remoteCollaborationSource).toContain('isTaskReviewEvent');

    expect(remoteCollaborationSource).not.toContain('isServerStateBootstrapCategory');
    expect(remoteCollaborationSource).not.toContain('TASK_PREVIEW_AVAILABILITY_SET');
    expect(remoteCollaborationSource).not.toContain('TASK_PORT_PROTOCOL_SET');
    expect(remoteCollaborationSource).not.toContain('TASK_REVIEW_SOURCE_SET');
    expect(remoteCollaborationSource).not.toContain('isTaskReviewSnapshotPayload');
    expect(remoteCollaborationSource).not.toContain('isTaskPortsSnapshotPayload');
    expect(remoteCollaborationSource).not.toContain('isAgentSupervisionSnapshotPayload');
  });

  it('keeps websocket task-port validation delegated to the task-port domain event guard', () => {
    expect(remoteWsSource).toContain('isRemoteBaseServerMessage');
    expect(remoteProtocolSource).toContain('isTaskPortsEvent');
    expect(remoteWsSource).not.toContain('TASK_PREVIEW_AVAILABILITY_SET');
    expect(remoteWsSource).not.toContain('TASK_PORT_PROTOCOL_SET');
    expect(remoteWsSource).not.toContain('isTaskExposedPortMessagePayload');
    expect(remoteWsSource).not.toContain('isTaskObservedPortMessagePayload');
  });

  it('keeps task-catalog validation out of the core browser protocol runtime', () => {
    expect(remoteProtocolSource).toContain('import type { TaskCatalogDeltaBatch }');
    expect(remoteProtocolSource).not.toContain('isTaskCatalogDeltaBatch');
    expect(taskCatalogMessageSource).toContain('isTaskCatalogDeltaBatch');
    expect(remoteWsSource).toContain("from '../../electron/remote/remote-base-message'");
  });
});
