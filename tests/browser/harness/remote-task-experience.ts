import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

const CSRF = 'C'.repeat(43);
const TOKEN = 'A'.repeat(43);
const TOKEN_2 = `${'E'.repeat(42)}A`;
const TOKEN_3 = `${'I'.repeat(42)}A`;
const OPERATION_ID = 'MTExMTExMTExMTExMTExMQ';
const SERVER_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';
const SNAPSHOT_ID = 'snapshot-1';

export interface RecordedCommand {
  bodyBytes: number;
  command: string;
  request: unknown;
}

export interface RemoteTaskExperienceMock {
  commands: RecordedCommand[];
  closeSocket(page: Page, code?: number): Promise<void>;
  getSubscribeCount(page: Page, sessionId: string): Promise<number>;
  getTaskCreationSubscribeCount(page: Page): Promise<number>;
}

export interface RemoteTaskExperienceMockOptions {
  creationScenario?: 'immediate' | 'pending-cancel' | 'response-loss';
  liveCreationEvents?: boolean;
  notesScenario?: 'always-saved' | 'save-conflict' | 'response-loss-replay';
  permissionBypassEnabled?: boolean;
}

export interface RemoteStaticServer {
  url: string;
  stop(): Promise<void>;
}

const REMOTE_DIST_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'dist-remote');

function getContentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

export async function startRemoteStaticServer(): Promise<RemoteStaticServer> {
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const relativePath =
        pathname === '/remote' || pathname === '/remote/' ? 'index.html' : pathname.slice(1);
      const filePath = path.resolve(REMOTE_DIST_DIR, relativePath);
      if (filePath !== REMOTE_DIST_DIR && !filePath.startsWith(`${REMOTE_DIST_DIR}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const body = await readFile(filePath);
        response.writeHead(200, { 'Content-Type': getContentType(filePath) });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Remote static browser server did not bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function project() {
  return {
    baseBranchChoiceCount: 1,
    baseBranchChoicesTruncated: false,
    id: 'project-1',
    label: 'Core project',
    labelTruncated: false,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    projectMode: 'git',
    worktreeChoiceCount: 1,
    worktreeChoicesTruncated: false,
  } as const;
}

function task() {
  return {
    branchLabel: null,
    branchLabelTruncated: false,
    creationStatus: 'ready',
    lifecycle: 'active',
    location: 'project-root',
    name: 'Mobile shell task',
    nameTruncated: false,
    ownership: 'shared',
    primarySessionId: 'shell-session-1',
    projectId: 'project-1',
    sessionCount: 1,
    taskId: 'task-1',
    taskMode: 'terminal',
  } as const;
}

function shellSession() {
  return {
    generation: 1,
    kind: 'shell',
    orderKey: '0001',
    sessionId: 'shell-session-1',
    state: 'running',
    taskId: 'task-1',
  } as const;
}

function loadedNotes(notes: string, contentVersion: string, workspaceRevision: number) {
  const snapshot = {
    contentVersion,
    notes,
    taskId: 'task-1',
    taskIncarnation: TOKEN,
    workspaceRevision,
  };
  return {
    kind: 'loaded',
    current: {
      relation: 'same-incarnation',
      currentNotes: { kind: 'present', snapshot },
      currentTask: {
        catalogVersion: workspaceRevision,
        serverInstanceId: SERVER_INSTANCE_ID,
        taskClosing: false,
        taskIncarnation: TOKEN,
        taskState: 'present',
      },
    },
  } as const;
}

function enabledCreationCapabilities(permissionBypassEnabled = true) {
  return {
    coordinator: { reason: 'coordinator-not-supported', supported: false },
    enabled: true,
    locations: {
      'existing-worktree': { enabled: true },
      'managed-worktree': { enabled: true },
      'project-root': { enabled: true },
    },
    modes: { agent: { enabled: true }, terminal: { enabled: true } },
    permissionBypass: {
      enabled: permissionBypassEnabled,
      ...(permissionBypassEnabled ? {} : { reason: 'not-authorized' }),
    },
  } as const;
}

function getCreationTaskMode(request: unknown): 'agent' | 'terminal' {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return 'terminal';
  const launch = (request as { launch?: unknown }).launch;
  return typeof launch === 'object' &&
    launch !== null &&
    (launch as { kind?: unknown }).kind === 'agent'
    ? 'agent'
    : 'terminal';
}

function createdTaskSnapshot(request: unknown) {
  const record =
    typeof request === 'object' && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : {};
  const taskMode = getCreationTaskMode(request);
  const locationRecord =
    typeof record.location === 'object' &&
    record.location !== null &&
    !Array.isArray(record.location)
      ? (record.location as { kind?: unknown })
      : {};
  const location =
    locationRecord.kind === 'managed-worktree' ||
    locationRecord.kind === 'existing-worktree' ||
    locationRecord.kind === 'project-root'
      ? locationRecord.kind
      : 'project-root';
  const createdTaskBase = {
    branchLabel: location === 'project-root' ? null : 'feature/created-task',
    branchLabelTruncated: false,
    creationStatus: 'ready' as const,
    lifecycle: 'active' as const,
    location,
    name: typeof record.name === 'string' ? record.name : 'Created terminal task',
    nameTruncated: false,
    ownership:
      location === 'managed-worktree'
        ? ('managed' as const)
        : location === 'existing-worktree'
          ? ('external' as const)
          : ('shared' as const),
    projectId: 'project-1',
    sessionCount: taskMode === 'terminal' ? 1 : 0,
    taskId: 'created-task-1',
    taskMode,
  };
  const createdTask =
    taskMode === 'terminal'
      ? { ...createdTaskBase, primarySessionId: 'created-shell-session' }
      : createdTaskBase;
  const current = {
    catalogVersion: 2,
    serverInstanceId: 'server-1',
    task: createdTask,
    taskClosing: false,
    taskState: 'present',
    workspaceRevision: 2,
  } as const;
  const snapshotBase = {
    commit: 'committed',
    committedTaskId: createdTask.taskId,
    committedWorkspaceRevision: 2,
    current,
    managedArtifactRecovery: { kind: 'none' },
    operationId: OPERATION_ID,
    phase: 'active',
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    version: 3,
  } as const;
  if (taskMode === 'agent') {
    return {
      ...snapshotBase,
      taskMode,
    } as const;
  }
  return {
    ...snapshotBase,
    shellLaunch: {
      current: {
        catalogVersion: 2,
        serverInstanceId: 'server-1',
        session: {
          generation: 1,
          sessionId: 'created-shell-session',
          state: 'running',
        },
        task: createdTask,
        taskClosing: false,
        taskState: 'present',
        workspaceRevision: 2,
      },
      disposition: { kind: 'attempted-no-replay', reason: 'running-at-ack' },
      identity: {
        committedWorkspaceRevision: 2,
        creationOperationId: OPERATION_ID,
        expectedGeneration: 1,
        operationId: 'created-shell-operation',
        sessionId: 'created-shell-session',
        taskId: createdTask.taskId,
      },
      phase: 'running',
      recordVersion: 1,
      replayKind: 'full',
    },
    taskMode,
  } as const;
}

function pendingTaskCreationSnapshot(request: unknown, cancelled = false) {
  return {
    commit: 'not-committed',
    committedTaskId: null,
    committedWorkspaceRevision: null,
    current: {
      catalogVersion: 1,
      serverInstanceId: 'server-1',
      task: null,
      taskClosing: false,
      taskState: 'not-visible',
      workspaceRevision: 1,
    },
    managedArtifactRecovery: { kind: 'none' },
    operationId: OPERATION_ID,
    phase: cancelled ? 'cancelled-before-preparation' : 'validating',
    serverInstanceId: 'server-1',
    symlinkWarnings: [],
    taskMode: getCreationTaskMode(request),
    version: cancelled ? 2 : 1,
  } as const;
}

function commandResult(result: unknown): { body: string; contentType: string; status: number } {
  return {
    body: JSON.stringify({ ok: true, result }),
    contentType: 'application/json',
    status: 200,
  };
}

export async function installRemoteTaskExperienceMock(
  page: Page,
  options: RemoteTaskExperienceMockOptions = {},
): Promise<RemoteTaskExperienceMock> {
  const commands: RecordedCommand[] = [];
  const creationScenario = options.creationScenario ?? 'immediate';
  const notesScenario = options.notesScenario ?? 'save-conflict';
  let notesUpdateCount = 0;
  let lastCreationSnapshot: unknown = null;
  let pendingCreateRequest: unknown = null;
  let resolvePendingCreate: ((snapshot: unknown) => void) | null = null;

  await page.addInitScript(
    ({ liveCreationEvents }) => {
      type SocketEventHandler<TEvent extends Event> = ((event: TEvent) => void) | null;
      type SentMessage = { agentId?: string; operationId?: string; type?: string };
      interface RemoteMockWindow extends Window {
        __remoteMockSockets?: MockWebSocket[];
        __remoteMockWsSent?: SentMessage[];
      }

      class MockWebSocket {
        static readonly CLOSED = 3;
        static readonly CLOSING = 2;
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;

        binaryType: BinaryType = 'blob';
        bufferedAmount = 0;
        extensions = '';
        onclose: SocketEventHandler<CloseEvent> = null;
        onerror: SocketEventHandler<Event> = null;
        onmessage: SocketEventHandler<MessageEvent> = null;
        onopen: SocketEventHandler<Event> = null;
        protocol = '';
        readyState = MockWebSocket.CONNECTING;
        readonly url: string;

        constructor(url: string | URL) {
          this.url = String(url);
          const mockWindow = window as RemoteMockWindow;
          (mockWindow.__remoteMockSockets ??= []).push(this);
          window.setTimeout(() => {
            if (this.readyState !== MockWebSocket.CONNECTING) return;
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event('open'));
          }, 0);
        }

        close(code = 1000, reason = ''): void {
          if (this.readyState === MockWebSocket.CLOSED) return;
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
        }

        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          if (typeof data !== 'string') return;
          const message = JSON.parse(data) as SentMessage;
          const mockWindow = window as RemoteMockWindow;
          (mockWindow.__remoteMockWsSent ??= []).push(message);
          if (
            liveCreationEvents &&
            message.type === 'subscribe-task-creation-operation' &&
            typeof message.operationId === 'string'
          ) {
            const operationId = message.operationId;
            window.setTimeout(() => {
              if (this.readyState !== MockWebSocket.OPEN) return;
              this.onmessage?.(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    operationId,
                    state: 'ready',
                    type: 'task-creation-operation-subscription-state',
                  }),
                }),
              );
              this.onmessage?.(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    snapshot: {
                      commit: 'not-committed',
                      committedTaskId: null,
                      committedWorkspaceRevision: null,
                      current: {
                        catalogVersion: 1,
                        serverInstanceId: 'server-1',
                        task: null,
                        taskClosing: false,
                        taskState: 'not-visible',
                        workspaceRevision: 1,
                      },
                      managedArtifactRecovery: { kind: 'none' },
                      operationId,
                      phase: 'validating',
                      serverInstanceId: 'server-1',
                      symlinkWarnings: [],
                      taskMode: 'agent',
                      version: 1,
                    },
                    type: 'task-creation-operation-snapshot',
                  }),
                }),
              );
            }, 0);
            return;
          }
          if (message.type !== 'subscribe' || typeof message.agentId !== 'string') return;
          const agentId = message.agentId;
          window.setTimeout(() => {
            if (this.readyState !== MockWebSocket.OPEN) return;
            const data = btoa('CATALOG_SHELL_ATTACHED');
            this.onmessage?.(
              new MessageEvent('message', {
                data: JSON.stringify({
                  agentId,
                  cols: 80,
                  data,
                  type: 'scrollback',
                }),
              }),
            );
            this.onmessage?.(
              new MessageEvent('message', {
                data: JSON.stringify({
                  agentId,
                  event: { data, type: 'Data' },
                  type: 'terminal-stream',
                }),
              }),
            );
          }, 100);
        }
      }

      Object.defineProperty(window, 'WebSocket', {
        configurable: true,
        value: MockWebSocket,
        writable: true,
      });
      window.localStorage.setItem('parallel-code-display-name', 'Browser test phone');
    },
    { liveCreationEvents: options.liveCreationEvents === true },
  );

  await page.route('**/api/remote/auth/session', async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        capabilities: {
          commands: [
            'task-catalog.get-deltas',
            'task-catalog.get-manifest',
            'task-catalog.get-page',
            'task-creation.cancel',
            'task-creation.create',
            'task-creation.get',
            'task-creation.get-capabilities',
            'task-creation.get-picker-page',
            'task-creation.get-worktree-link-candidates',
            'task-creation.issue',
            'task-notes.get',
            'task-notes.issue',
            'task-notes.update',
            'terminal.attach',
            'terminal.detach',
            'terminal.input',
            'terminal.resize',
          ],
          mutationAdmission: 'open',
        },
        csrf: CSRF,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.route('**/api/commands/**', async (route) => {
    const command = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const request = route.request().postDataJSON() as unknown;
    commands.push({
      bodyBytes: route.request().postDataBuffer()?.byteLength ?? 0,
      command,
      request,
    });

    switch (command) {
      case 'task-catalog.get-manifest':
        await route.fulfill(
          commandResult({
            kind: 'found',
            value: {
              catalogVersion: 1,
              counts: { project: 1, session: 1, 'static-agent': 1, task: 1 },
              mode: 'replace-paged',
              pageByteLimit: 49_152,
              pageItemLimit: 50,
              serverInstanceId: 'server-1',
              snapshotId: SNAPSHOT_ID,
            },
          }),
        );
        return;
      case 'task-catalog.get-page': {
        const kind =
          typeof request === 'object' && request !== null && !Array.isArray(request)
            ? (request as { kind?: unknown }).kind
            : null;
        const items =
          kind === 'project'
            ? [project()]
            : kind === 'task'
              ? [task()]
              : kind === 'session'
                ? [shellSession()]
                : kind === 'static-agent'
                  ? [
                      {
                        agentDefId: 'agent-1',
                        displayName: 'Test agent',
                        displayNameTruncated: false,
                        glyph: null,
                        glyphTruncated: false,
                        providerLabel: null,
                        providerLabelTruncated: false,
                        supportsInitialPrompt: true,
                        supportsPermissionBypass: true,
                      },
                    ]
                  : [];
        await route.fulfill(
          commandResult({
            kind: 'found',
            value: {
              catalogVersion: 1,
              items,
              kind,
              nextCursor: null,
              serverInstanceId: 'server-1',
              snapshotId: SNAPSHOT_ID,
            },
          }),
        );
        return;
      }
      case 'task-catalog.get-deltas':
        await route.fulfill(
          commandResult({
            kind: 'found',
            value: {
              events: [],
              fromCatalogVersion: 1,
              serverInstanceId: 'server-1',
              toCatalogVersion: 1,
            },
          }),
        );
        return;
      case 'task-creation.get-capabilities':
        await route.fulfill(
          commandResult(enabledCreationCapabilities(options.permissionBypassEnabled)),
        );
        return;
      case 'task-creation.get-picker-page': {
        const kind = (request as { kind?: unknown }).kind;
        await route.fulfill(
          commandResult({
            catalogVersion: 1,
            generation: 1,
            items: [],
            kind,
            nextCursor: null,
            serverInstanceId: 'server-1',
            truncated: false,
          }),
        );
        return;
      }
      case 'task-creation.get-worktree-link-candidates':
        await route.fulfill(commandResult({ candidates: [], kind: 'found', truncated: false }));
        return;
      case 'task-creation.issue': {
        const issuedAt = Date.now();
        await route.fulfill(
          commandResult({
            expiresAt: issuedAt + 600_000,
            issuedAt,
            operationId: OPERATION_ID,
            operationTicket: 'browser-ticket',
          }),
        );
        return;
      }
      case 'task-creation.create': {
        if (creationScenario === 'pending-cancel') {
          pendingCreateRequest = request;
          lastCreationSnapshot = pendingTaskCreationSnapshot(request);
          const snapshot = await new Promise<unknown>((resolve) => {
            resolvePendingCreate = resolve;
          });
          await route.fulfill(commandResult({ kind: 'snapshot', outcome: 'accepted', snapshot }));
          return;
        }
        lastCreationSnapshot = createdTaskSnapshot(request);
        if (creationScenario === 'response-loss') {
          await route.abort('connectionreset');
          return;
        }
        await route.fulfill(
          commandResult({ kind: 'snapshot', outcome: 'accepted', snapshot: lastCreationSnapshot }),
        );
        return;
      }
      case 'task-creation.cancel': {
        const cancelled = pendingTaskCreationSnapshot(pendingCreateRequest, true);
        lastCreationSnapshot = cancelled;
        await route.fulfill(
          commandResult({ kind: 'snapshot', outcome: 'cancelled', snapshot: cancelled }),
        );
        resolvePendingCreate?.(cancelled);
        resolvePendingCreate = null;
        return;
      }
      case 'task-creation.get':
        await route.fulfill(
          commandResult(
            lastCreationSnapshot
              ? { kind: 'snapshot', outcome: 'found', snapshot: lastCreationSnapshot }
              : { kind: 'operation-state-unavailable' },
          ),
        );
        return;
      case 'task-notes.get':
        await route.fulfill(commandResult(loadedNotes('base note', TOKEN, 1)));
        return;
      case 'task-notes.issue':
        await route.fulfill(
          commandResult({
            kind: 'issued',
            operation: {
              admitUntil: '2099-08-03T10:10:00.000Z',
              operationCapability: TOKEN,
              operationId: OPERATION_ID,
              replayUntil: '2099-08-04T10:00:00.000Z',
            },
          }),
        );
        return;
      case 'task-notes.update': {
        notesUpdateCount += 1;
        const submittedNotes =
          typeof request === 'object' && request !== null && !Array.isArray(request)
            ? String((request as { notes?: unknown }).notes ?? '')
            : '';
        if (notesScenario === 'response-loss-replay' && notesUpdateCount === 1) {
          await route.abort('connectionreset');
          return;
        }
        if (notesScenario === 'response-loss-replay') {
          const current = loadedNotes(submittedNotes, TOKEN_2, 2).current;
          await route.fulfill(
            commandResult({
              current,
              effectiveRetireAfter: '2099-08-04T10:00:00.000Z',
              kind: 'completed',
              originalOutcome: {
                changed: true,
                committedContentVersion: TOKEN_2,
                committedWorkspaceRevision: 2,
                kind: 'saved',
              },
              replayed: true,
            }),
          );
          return;
        }
        if (notesScenario === 'always-saved') {
          const workspaceRevision = notesUpdateCount + 1;
          const current = loadedNotes(submittedNotes, TOKEN_2, workspaceRevision).current;
          await route.fulfill(
            commandResult({
              current,
              effectiveRetireAfter: '2099-08-04T10:00:00.000Z',
              kind: 'completed',
              originalOutcome: {
                changed: true,
                committedContentVersion: TOKEN_2,
                committedWorkspaceRevision: workspaceRevision,
                kind: 'saved',
              },
              replayed: false,
            }),
          );
          return;
        }
        if (notesUpdateCount === 1) {
          const current = loadedNotes(submittedNotes, TOKEN_2, 2).current;
          await route.fulfill(
            commandResult({
              current,
              effectiveRetireAfter: '2099-08-04T10:00:00.000Z',
              kind: 'completed',
              originalOutcome: {
                changed: true,
                committedContentVersion: TOKEN_2,
                committedWorkspaceRevision: 2,
                kind: 'saved',
              },
              replayed: false,
            }),
          );
          return;
        }
        const current = loadedNotes('remote note', TOKEN_3, 3).current;
        await route.fulfill(
          commandResult({
            current,
            effectiveRetireAfter: '2099-08-04T10:00:00.000Z',
            kind: 'completed',
            originalOutcome: {
              kind: 'conflict',
              observedContentVersion: TOKEN_3,
              observedWorkspaceRevision: 3,
            },
            replayed: false,
          }),
        );
        return;
      }
      default:
        await route.fulfill({
          body: JSON.stringify({ error: { code: 'bad-request' }, ok: false }),
          contentType: 'application/json',
          status: 400,
        });
    }
  });

  return {
    commands,
    async closeSocket(currentPage, code = 4001) {
      await currentPage.evaluate((closeCode) => {
        const sockets = (
          window as typeof window & {
            __remoteMockSockets?: Array<{ close(code?: number): void }>;
          }
        ).__remoteMockSockets;
        sockets?.at(-1)?.close(closeCode);
      }, code);
    },
    getSubscribeCount(currentPage, sessionId) {
      return currentPage.evaluate((targetSessionId) => {
        const sent = (
          window as typeof window & {
            __remoteMockWsSent?: Array<{ agentId?: string; type?: string }>;
          }
        ).__remoteMockWsSent;
        return (
          sent?.filter(
            (message) => message.type === 'subscribe' && message.agentId === targetSessionId,
          ).length ?? 0
        );
      }, sessionId);
    },
    getTaskCreationSubscribeCount(currentPage) {
      return currentPage.evaluate(() => {
        const sent = (
          window as typeof window & {
            __remoteMockWsSent?: Array<{ type?: string }>;
          }
        ).__remoteMockWsSent;
        return (
          sent?.filter((message) => message.type === 'subscribe-task-creation-operation').length ??
          0
        );
      });
    },
  };
}
