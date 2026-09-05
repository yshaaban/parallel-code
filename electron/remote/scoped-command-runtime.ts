import type { IncomingMessage, ServerResponse } from 'http';
import {
  createRemoteCommandGateway,
  mergeRemoteCommandRegistrationTables,
  type RemoteCommandAuthentication,
  type RemoteCommandGateway,
  type RemoteCommandRegistrationTable,
  type RemoteGrant,
} from '../ipc/remote-command-gateway.js';
import {
  createRemoteAuthHttpHandler,
  getRemoteConnectionEvidence,
  type RemoteAuthHttpPaths,
} from './remote-auth-http.js';
import { createRemoteCommandHttpHandler } from './remote-command-http.js';
import {
  createRemoteSessionAuthority,
  type RemoteSessionAuthority,
} from './remote-session-authority.js';
import { createRemoteTerminalCommandRegistrations } from './terminal-command-registrations.js';
import type { RemotePeerTrustPolicy } from './network.js';
import { TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS } from './task-notes-http.js';

export interface ScopedRemoteCommandRuntimeOptions {
  accessToken: string;
  authHttpPaths?: RemoteAuthHttpPaths;
  grants: ReadonlySet<RemoteGrant>;
  includeTerminalCommands?: boolean;
  mutationAdmissionInitiallyOpen?: boolean;
  onInternalError?: (error: unknown) => void;
  peerTrustPolicy: RemotePeerTrustPolicy;
  registrations: RemoteCommandRegistrationTable;
  workspacePrincipalId: string;
}

export interface ScopedRemoteReadAccess {
  authentication: RemoteCommandAuthentication;
  catalogRead: boolean;
  terminalRead: boolean;
}

export interface ScopedRemoteCommandRuntime {
  authenticateReadRequest(request: IncomingMessage): ScopedRemoteReadAccess | null;
  authenticateSocket(request: IncomingMessage): RemoteCommandAuthentication | null;
  authHttpHandler(request: IncomingMessage, response: ServerResponse): boolean;
  closeAndDrain(): Promise<void>;
  commandHttpHandler(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  gateway: RemoteCommandGateway;
  getCurrentAuthentication(
    authentication: RemoteCommandAuthentication,
  ): RemoteCommandAuthentication | null;
  refreshSocketAuthentication(
    authentication: RemoteCommandAuthentication,
  ): RemoteCommandAuthentication | null;
  revokeAll(): void;
  sessionAuthority: RemoteSessionAuthority;
  subscribeAuthenticationInvalidation(listener: () => void): () => void;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0];
}

function mergeRegistrations(
  registrations: RemoteCommandRegistrationTable,
  includeTerminalCommands: boolean,
): RemoteCommandRegistrationTable {
  if (!includeTerminalCommands) return { ...registrations };
  const terminalRegistrations = createRemoteTerminalCommandRegistrations();
  return mergeRemoteCommandRegistrationTables(registrations, terminalRegistrations);
}

/**
 * Shared secure command-plane composition for both backend hosts. Hosts own
 * sockets and static files; this owner keeps session, grant, HTTP, and
 * revocation behavior identical.
 */
export function createScopedRemoteCommandRuntime(
  options: ScopedRemoteCommandRuntimeOptions,
): ScopedRemoteCommandRuntime {
  const sessionAuthority = createRemoteSessionAuthority({
    accessToken: options.accessToken,
    grants: options.grants,
    workspacePrincipalId: options.workspacePrincipalId,
  });
  const gateway = createRemoteCommandGateway(
    mergeRegistrations(options.registrations, options.includeTerminalCommands !== false),
    {
      isAuthenticationCurrent: (authentication) =>
        sessionAuthority.getCurrentAuthentication(authentication) !== null,
      mutationAdmissionInitiallyOpen: options.mutationAdmissionInitiallyOpen === true,
      ...(options.onInternalError
        ? { onInternalError: (_command, error) => options.onInternalError?.(error) }
        : {}),
    },
  );

  function authenticateReadRequest(request: IncomingMessage): ScopedRemoteReadAccess | null {
    const evidence = getRemoteConnectionEvidence(request, options.peerTrustPolicy);
    const candidate =
      sessionAuthority.authenticateBrowserRequest(request.headers.cookie, undefined, evidence) ??
      sessionAuthority.authenticateBearerRequest(
        firstHeader(request.headers.authorization),
        evidence,
      );
    if (
      !candidate ||
      candidate.transportSecure !== true ||
      candidate.directPeerValidated !== true ||
      (candidate.kind === 'browser-session' &&
        evidence.origin !== null &&
        candidate.originValidated !== true)
    ) {
      return null;
    }
    const authentication =
      candidate.kind === 'browser-session'
        ? sessionAuthority.recordBrowserSessionActivity(candidate)
        : sessionAuthority.getCurrentAuthentication(candidate);
    if (!authentication) return null;
    return {
      authentication,
      catalogRead: authentication.grants.has('catalog:read'),
      terminalRead: authentication.grants.has('terminal:read'),
    };
  }

  const authHttpHandler = createRemoteAuthHttpHandler({
    authority: sessionAuthority,
    gateway,
    ...(options.authHttpPaths ? { paths: options.authHttpPaths } : {}),
    peerTrustPolicy: options.peerTrustPolicy,
  });
  const commandHttpHandler = createRemoteCommandHttpHandler({
    authenticate: ({ request }) => {
      const evidence = getRemoteConnectionEvidence(request, options.peerTrustPolicy);
      const csrf = firstHeader(request.headers['x-parallel-code-csrf']);
      return (
        sessionAuthority.authenticateBrowserRequest(request.headers.cookie, csrf, evidence) ??
        sessionAuthority.authenticateBearerRequest(
          firstHeader(request.headers.authorization),
          evidence,
        )
      );
    },
    gateway,
    onAcceptedAuthentication: (authentication) => {
      if (authentication.kind === 'browser-session') {
        sessionAuthority.recordBrowserSessionActivity(authentication);
      }
    },
    ...(options.onInternalError ? { onInternalError: options.onInternalError } : {}),
    responseAdapters: TASK_NOTES_REMOTE_COMMAND_HTTP_ADAPTERS,
  });

  return {
    authenticateReadRequest,
    authenticateSocket: (request) =>
      sessionAuthority.authenticateBrowserSocket(
        request.headers.cookie,
        getRemoteConnectionEvidence(request, options.peerTrustPolicy),
      ),
    authHttpHandler,
    closeAndDrain: () => gateway.closeAndDrainMutations(),
    commandHttpHandler,
    gateway,
    getCurrentAuthentication: (authentication) =>
      sessionAuthority.getCurrentAuthentication(authentication),
    refreshSocketAuthentication: (authentication) =>
      sessionAuthority.refreshSocketAuthentication(authentication),
    revokeAll: () => sessionAuthority.revokeAll(),
    sessionAuthority,
    subscribeAuthenticationInvalidation: (listener) =>
      sessionAuthority.subscribeInvalidation(listener),
  };
}
