import {
  getTaskNotesRequestErrorHttpStatus,
  isGetTaskNotesWireResponse,
  isIssueTaskNotesOperationWireResponse,
  isUpdateTaskNotesWireResponse,
  TASK_NOTES_RETRY_AFTER_MIN_MS,
  type GetTaskNotesResult,
  type IssueTaskNotesOperationResult,
  type TaskNotesRequestError,
  type TaskNotesWireResponse,
  type UpdateTaskNotesResult,
} from '../../src/domain/task-notes.js';
import type { RemoteCommandGatewayErrorCode } from '../ipc/remote-command-gateway.js';
import type {
  RemoteCommandHttpOutcome,
  RemoteCommandHttpResponse,
  RemoteCommandHttpResponseAdapter,
  RemoteCommandHttpResponseAdapterTable,
} from './remote-command-http.js';

export type TaskNotesHttpMethod = 'get' | 'issue' | 'update';

type TaskNotesMethodResult<TMethod extends TaskNotesHttpMethod> = TMethod extends 'get'
  ? GetTaskNotesResult
  : TMethod extends 'issue'
    ? IssueTaskNotesOperationResult
    : UpdateTaskNotesResult;

export interface TaskNotesHttpResponse<
  TMethod extends TaskNotesHttpMethod,
> extends RemoteCommandHttpResponse {
  body: TaskNotesWireResponse<TaskNotesMethodResult<TMethod>>;
}

function isMethodResponse<TMethod extends TaskNotesHttpMethod>(
  method: TMethod,
  value: unknown,
): value is TaskNotesWireResponse<TaskNotesMethodResult<TMethod>> {
  switch (method) {
    case 'get':
      return isGetTaskNotesWireResponse(value);
    case 'issue':
      return isIssueTaskNotesOperationWireResponse(value);
    case 'update':
      return isUpdateTaskNotesWireResponse(value);
  }
}

function getRetryAfterMs(value: object): number | undefined {
  return 'retryAfterMs' in value && typeof value.retryAfterMs === 'number'
    ? value.retryAfterMs
    : undefined;
}

/**
 * Sole Notes HTTP response policy. The service and gateway keep their own
 * typed contracts; this transport edge owns direct wire envelopes and status.
 */
export function mapTaskNotesHttpResponse<TMethod extends TaskNotesHttpMethod>(
  method: TMethod,
  value: unknown,
): TaskNotesHttpResponse<TMethod> {
  if (!isMethodResponse(method, value)) {
    return {
      body: { ok: false, error: { code: 'internal-error', retryable: false } },
      status: 500,
    };
  }
  if (value.ok) {
    const retryAfterMs = getRetryAfterMs(value.result);
    return {
      body: value,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      status: 200,
    };
  }
  const retryAfterMs = getRetryAfterMs(value.error);
  return {
    body: value,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    status: getTaskNotesRequestErrorHttpStatus(value.error),
  };
}

function taskNotesErrorForGatewayFailure(
  code: RemoteCommandGatewayErrorCode,
  retryAfterMs: number | undefined,
): TaskNotesRequestError {
  switch (code) {
    case 'bad-request':
      return { code: 'bad-request' };
    case 'unauthenticated':
      return { code: 'unauthenticated' };
    case 'csrf-rejected':
    case 'forbidden':
    case 'origin-rejected':
    case 'secure-transport-required':
    case 'untrusted-peer':
    case 'unsupported-command':
      return { code: 'forbidden' };
    case 'payload-too-large':
      return { code: 'payload-too-large' };
    case 'rate-limited':
      return { code: 'rate-limited', retryAfterMs: retryAfterMs ?? TASK_NOTES_RETRY_AFTER_MIN_MS };
    case 'gateway-draining':
      return { code: 'capacity-exhausted', retryAfterMs: TASK_NOTES_RETRY_AFTER_MIN_MS };
    case 'request-aborted':
      return { code: 'internal-error', retryable: true };
    case 'internal-error':
      return { code: 'internal-error', retryable: false };
  }
}

function taskNotesErrorForEdgeFailure(
  code: Extract<RemoteCommandHttpOutcome, { kind: 'edge-error' }>['code'],
): TaskNotesRequestError {
  switch (code) {
    case 'bad-request':
      return { code: 'bad-request' };
    case 'internal-error':
      return { code: 'internal-error', retryable: false };
    case 'payload-too-large':
      return { code: 'payload-too-large' };
    case 'unsupported-media-type':
      return { code: 'unsupported-media-type' };
  }
}

export function mapTaskNotesRemoteCommandHttpOutcome<TMethod extends TaskNotesHttpMethod>(
  method: TMethod,
  outcome: Readonly<RemoteCommandHttpOutcome>,
): TaskNotesHttpResponse<TMethod> {
  if (outcome.kind === 'edge-error') {
    return mapTaskNotesHttpResponse(method, {
      error: taskNotesErrorForEdgeFailure(outcome.code),
      ok: false,
    });
  }
  if (outcome.result.ok) return mapTaskNotesHttpResponse(method, outcome.result.result);
  return mapTaskNotesHttpResponse(method, {
    error: taskNotesErrorForGatewayFailure(
      outcome.result.error.code,
      outcome.result.error.retryAfterMs,
    ),
    ok: false,
  });
}

function createTaskNotesHttpResponseAdapter(
  method: TaskNotesHttpMethod,
): RemoteCommandHttpResponseAdapter {
  return (outcome) => mapTaskNotesRemoteCommandHttpOutcome(method, outcome);
}

export const TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS = Object.freeze({
  'task-notes.get': createTaskNotesHttpResponseAdapter('get'),
  'task-notes.issue': createTaskNotesHttpResponseAdapter('issue'),
  'task-notes.update': createTaskNotesHttpResponseAdapter('update'),
}) satisfies RemoteCommandHttpResponseAdapterTable;
