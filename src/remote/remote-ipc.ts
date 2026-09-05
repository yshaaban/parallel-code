import { IPC } from '../../electron/ipc/channels';
import type {
  RendererInvokeRequestMap,
  RendererInvokeResponseMap,
} from '../domain/renderer-invoke';
import { BROWSER_CLIENT_ID_HEADER } from '../domain/browser-ipc';
import { getRemoteCsrfToken, getToken, initializeRemoteAuthSession } from './auth';
import { getRemoteClientId } from './client-id';
import {
  getTaskNotesRequestErrorHttpStatus,
  isGetTaskNotesRequest,
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationRequest,
  isIssueTaskNotesOperationWireResponse,
  isUpdateTaskNotesRequest,
  isUpdateTaskNotesWireResponse,
  type TaskNotesWireResponse,
} from '../domain/task-notes';
import type { TaskNotesTransport } from '../components/task-notes/task-notes-transport';
import {
  isTaskCatalogDeltaBatch,
  isTaskCatalogFetchResult,
  isTaskCatalogPage,
  isTaskCatalogReplaceManifest,
  type TaskCatalogClientFacade,
} from '../domain/task-catalog';
import { isTaskCreationCapabilities } from '../domain/task-creation';

type RemoteIpcChannel =
  | IPC.AcquireTaskCommandLease
  | IPC.ReleaseTaskCommandLease
  | IPC.RenewTaskCommandLease
  | IPC.ResizeAgent
  | IPC.WriteToAgent;

function allowsEmptyResult(channel: RemoteIpcChannel): boolean {
  switch (channel) {
    case IPC.ResizeAgent:
    case IPC.WriteToAgent:
      return true;
    default:
      return false;
  }
}

async function invokeRemoteIpc<TChannel extends RemoteIpcChannel>(
  channel: TChannel,
  args: RendererInvokeRequestMap[TChannel],
  signal?: AbortSignal,
): Promise<RendererInvokeResponseMap[TChannel]> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [BROWSER_CLIENT_ID_HEADER]: getRemoteClientId(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`/api/ipc/${encodeURIComponent(channel)}`, {
    body: JSON.stringify(args),
    credentials: 'same-origin',
    headers,
    method: 'POST',
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    result?: RendererInvokeResponseMap[TChannel];
  };

  if (!response.ok) {
    throw new Error(payload.error ?? `IPC request failed (${response.status})`);
  }

  if (!('result' in payload)) {
    if (allowsEmptyResult(channel)) {
      return undefined as RendererInvokeResponseMap[TChannel];
    }

    throw new Error(`IPC response for ${channel} did not include a result`);
  }

  return payload.result as RendererInvokeResponseMap[TChannel];
}

export type ScopedRemoteTaskCommand =
  | 'task-catalog.get-deltas'
  | 'task-catalog.get-manifest'
  | 'task-catalog.get-page'
  | 'task-creation.cancel'
  | 'task-creation.create'
  | 'task-creation.get'
  | 'task-creation.get-capabilities'
  | 'task-creation.get-picker-page'
  | 'task-creation.get-worktree-link-candidates'
  | 'task-creation.issue'
  | 'task-creation.retry-shell'
  | 'task-notes.get'
  | 'task-notes.issue'
  | 'task-notes.update';

interface RemoteCommandErrorEnvelope {
  error: { code: string; retryAfterMs?: number };
  ok: false;
}

function isRemoteCommandErrorEnvelope(value: unknown): value is RemoteCommandErrorEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 2 ||
    envelope.ok !== false ||
    typeof envelope.error !== 'object' ||
    envelope.error === null ||
    Array.isArray(envelope.error)
  ) {
    return false;
  }
  const error = envelope.error as Record<string, unknown>;
  return (
    (Object.keys(error).length === 1 || Object.keys(error).length === 2) &&
    typeof error.code === 'string' &&
    (error.retryAfterMs === undefined ||
      (Number.isSafeInteger(error.retryAfterMs) && (error.retryAfterMs as number) >= 0))
  );
}

export class RemoteCommandClientError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Remote command failed (${code})`);
    this.name = 'RemoteCommandClientError';
  }
}

interface ScopedRemoteCommandFetchResult {
  response: Response;
  value: unknown;
}

async function fetchScopedRemoteCommand(
  command: ScopedRemoteTaskCommand,
  request: unknown,
  signal?: AbortSignal,
): Promise<ScopedRemoteCommandFetchResult> {
  if (!getRemoteCsrfToken()) await initializeRemoteAuthSession();
  const csrf = getRemoteCsrfToken();
  if (!csrf) throw new RemoteCommandClientError('secure-session-required');
  const response = await fetch(`/api/commands/${command}`, {
    body: JSON.stringify(request),
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Parallel-Code-CSRF': csrf,
    },
    method: 'POST',
    signal,
  });
  const value: unknown = await response.json().catch(() => null);
  return { response, value };
}

export async function invokeScopedRemoteCommand<TResult>(
  command: ScopedRemoteTaskCommand,
  request: unknown,
  guard: (value: unknown) => value is TResult,
  signal?: AbortSignal,
): Promise<TResult> {
  const { response, value } = await fetchScopedRemoteCommand(command, request, signal);
  if (isRemoteCommandErrorEnvelope(value)) {
    throw new RemoteCommandClientError(value.error.code, value.error.retryAfterMs);
  }
  if (
    !response.ok ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    (value as { ok?: unknown }).ok !== true ||
    !guard((value as { result?: unknown }).result)
  ) {
    throw new RemoteCommandClientError('invalid-response');
  }
  return (value as { result: TResult }).result;
}

type TaskNotesRemoteCommand = Extract<ScopedRemoteTaskCommand, `task-notes.${string}`>;

async function invokeTaskNotesRemoteCommand<TResult>(
  command: TaskNotesRemoteCommand,
  request: unknown,
  guard: (value: unknown) => value is TaskNotesWireResponse<TResult>,
  signal?: AbortSignal,
): Promise<TaskNotesWireResponse<TResult>> {
  const { response, value } = await fetchScopedRemoteCommand(command, request, signal);
  if (guard(value)) {
    const expectedStatus = value.ok ? 200 : getTaskNotesRequestErrorHttpStatus(value.error);
    if (response.status !== expectedStatus) {
      throw new RemoteCommandClientError('invalid-response');
    }
    return value;
  }
  throw new RemoteCommandClientError('invalid-response');
}

export const remoteTaskCatalogFacade: TaskCatalogClientFacade = {
  getDeltasSince: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-catalog.get-deltas',
      request,
      (value) => isTaskCatalogFetchResult(value, isTaskCatalogDeltaBatch),
      signal,
    ),
  getManifest: (signal) =>
    invokeScopedRemoteCommand(
      'task-catalog.get-manifest',
      {},
      (value) => isTaskCatalogFetchResult(value, isTaskCatalogReplaceManifest),
      signal,
    ),
  getPage: (request, signal) =>
    invokeScopedRemoteCommand(
      'task-catalog.get-page',
      request,
      (value) => isTaskCatalogFetchResult(value, isTaskCatalogPage),
      signal,
    ),
};

export const remoteTaskCreationCapabilitiesFacade = {
  getCapabilities: (signal?: AbortSignal) =>
    invokeScopedRemoteCommand(
      'task-creation.get-capabilities',
      {},
      isTaskCreationCapabilities,
      signal,
    ),
};

export const remoteTaskNotesTransport: TaskNotesTransport = {
  async get(request, signal) {
    if (!isGetTaskNotesRequest(request)) throw new Error('Invalid task-notes get request');
    return invokeTaskNotesRemoteCommand(
      'task-notes.get',
      request,
      isGetTaskNotesWireResponse,
      signal,
    );
  },
  async issue(request) {
    if (!isIssueTaskNotesOperationRequest(request)) {
      throw new Error('Invalid task-notes issue request');
    }
    return invokeTaskNotesRemoteCommand(
      'task-notes.issue',
      request,
      isIssueTaskNotesOperationWireResponse,
    );
  },
  async update(request) {
    if (!isUpdateTaskNotesRequest(request)) throw new Error('Invalid task-notes update request');
    return invokeTaskNotesRemoteCommand(
      'task-notes.update',
      request,
      isUpdateTaskNotesWireResponse,
    );
  },
};

export function acquireRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.AcquireTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.AcquireTaskCommandLease]> {
  return invokeRemoteIpc(IPC.AcquireTaskCommandLease, args);
}

export function renewRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.RenewTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.RenewTaskCommandLease]> {
  return invokeRemoteIpc(IPC.RenewTaskCommandLease, args);
}

export function releaseRemoteTaskCommandLease(
  args: RendererInvokeRequestMap[IPC.ReleaseTaskCommandLease],
): Promise<RendererInvokeResponseMap[IPC.ReleaseTaskCommandLease]> {
  return invokeRemoteIpc(IPC.ReleaseTaskCommandLease, args);
}

export function writeRemoteAgent(
  args: RendererInvokeRequestMap[IPC.WriteToAgent],
): Promise<RendererInvokeResponseMap[IPC.WriteToAgent]> {
  return invokeRemoteIpc(IPC.WriteToAgent, args);
}

export function resizeRemoteAgent(
  args: RendererInvokeRequestMap[IPC.ResizeAgent],
): Promise<RendererInvokeResponseMap[IPC.ResizeAgent]> {
  return invokeRemoteIpc(IPC.ResizeAgent, args);
}
