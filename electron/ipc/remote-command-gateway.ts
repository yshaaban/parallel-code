import { isRecord } from '../../src/lib/type-guards.js';

export const REMOTE_GRANTS = [
  'catalog:read',
  'notes:read',
  'notes:write',
  'task:create',
  'task:create-imported',
  'task:create-root',
  'task:permission-bypass',
  'terminal:control',
  'terminal:read',
] as const;

export type RemoteGrant = (typeof REMOTE_GRANTS)[number];
export type RemoteCommandEffect = 'read' | 'write' | 'code-execution';

const REMOTE_COMMAND_POLICIES = Object.freeze({
  'task-catalog.get-deltas': {
    effect: 'read',
    grants: ['catalog:read'],
  },
  'task-catalog.get-manifest': {
    effect: 'read',
    grants: ['catalog:read'],
  },
  'task-catalog.get-page': {
    effect: 'read',
    grants: ['catalog:read'],
  },
  'task-creation.cancel': {
    effect: 'write',
    grants: ['task:create'],
  },
  'task-creation.create': {
    effect: 'code-execution',
    grants: ['task:create'],
  },
  'task-creation.get': {
    effect: 'read',
    grants: ['task:create'],
  },
  'task-creation.get-capabilities': {
    effect: 'read',
    grants: ['task:create'],
  },
  'task-creation.get-picker-page': {
    effect: 'read',
    grants: ['task:create'],
  },
  'task-creation.get-worktree-link-candidates': {
    effect: 'read',
    grants: ['task:create'],
  },
  'task-creation.issue': {
    effect: 'write',
    grants: ['task:create'],
  },
  'task-creation.retry-shell': {
    effect: 'code-execution',
    grants: ['task:create'],
  },
  'task-notes.get': {
    effect: 'read',
    grants: ['notes:read'],
  },
  'task-notes.issue': {
    effect: 'write',
    grants: ['notes:write'],
  },
  'task-notes.update': {
    effect: 'write',
    grants: ['notes:write'],
  },
  'terminal.acquire-control': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.attach': {
    effect: 'read',
    grants: ['terminal:read'],
  },
  'terminal.detach': {
    effect: 'read',
    grants: ['terminal:read'],
  },
  'terminal.input': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.kill': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.pause': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.release-control': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.resume': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
  'terminal.resize': {
    effect: 'code-execution',
    grants: ['terminal:control'],
  },
} as const satisfies Record<
  string,
  { effect: RemoteCommandEffect; grants: readonly RemoteGrant[] }
>);

export type RemoteCommandName = keyof typeof REMOTE_COMMAND_POLICIES;

export const REMOTE_COMMAND_NAMES = Object.freeze(
  Object.keys(REMOTE_COMMAND_POLICIES) as RemoteCommandName[],
);

const REMOTE_COMMAND_NAME_SET = new Set<string>(REMOTE_COMMAND_NAMES);
const REMOTE_GRANT_SET = new Set<string>(REMOTE_GRANTS);
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_ACTIVE_MUTATIONS = 8;
const DEFAULT_MAX_ACTIVE_MUTATIONS_PER_PRINCIPAL = 2;
const DEFAULT_MAX_QUEUED_MUTATIONS = 32;
const SAFE_CONTEXT_VALUE = /^[A-Za-z0-9._:@-]+$/u;

export type RemoteAuthenticationKind = 'browser-session' | 'bearer' | 'trusted-local';

/**
 * Server-created authentication evidence. Request bodies never supply or override these fields.
 * Browser/bearer adapters must validate expiry/revocation before each dispatch.
 */
export interface RemoteCommandAuthentication {
  authEpoch: string;
  authenticationSessionGeneration: string;
  csrfValidated?: boolean;
  directPeerValidated?: boolean;
  expiresAt: number;
  grants: ReadonlySet<RemoteGrant>;
  kind: RemoteAuthenticationKind;
  originValidated?: boolean;
  principalId: string;
  sourceId?: string | null;
  transportSecure?: boolean;
}

export interface RemoteCommandExecutionContext {
  readonly authEpoch: string;
  readonly authenticationSessionGeneration: string;
  readonly principalId: string;
  readonly sourceId: string | null;
  hasGrant(grant: RemoteGrant): boolean;
}

export interface RemoteCommandRegistration<TRequest = unknown, TResult = unknown> {
  execute(
    context: RemoteCommandExecutionContext,
    request: TRequest,
    signal?: AbortSignal,
  ): Promise<TResult> | TResult;
  isRequest(value: unknown): value is TRequest;
  isResult(value: unknown): value is TResult;
  /** Composition-owned availability; false withdraws advertisement and final dispatch. */
  isAvailable?(): boolean;
  requiredGrants?(request: Readonly<TRequest>): readonly RemoteGrant[];
}

export type RemoteCommandRegistrationTable = Partial<
  Record<RemoteCommandName, RemoteCommandRegistration>
>;

export type RemoteCommandGatewayErrorCode =
  | 'bad-request'
  | 'csrf-rejected'
  | 'forbidden'
  | 'gateway-draining'
  | 'internal-error'
  | 'origin-rejected'
  | 'payload-too-large'
  | 'rate-limited'
  | 'request-aborted'
  | 'secure-transport-required'
  | 'unauthenticated'
  | 'untrusted-peer'
  | 'unsupported-command';

export type RemoteCommandGatewayResult<TResult = unknown> =
  | { ok: true; result: TResult }
  | {
      ok: false;
      error: {
        code: RemoteCommandGatewayErrorCode;
        retryAfterMs?: number;
      };
    };

export interface RemoteCommandCapabilitySnapshot {
  commands: readonly RemoteCommandName[];
  mutationAdmission: 'open' | 'draining';
}

export interface RemoteCommandGatewayOptions {
  maxActiveMutations?: number;
  maxActiveMutationsPerPrincipal?: number;
  maxBodyBytes?: number;
  maxQueuedMutations?: number;
  mutationAdmissionInitiallyOpen?: boolean;
  now?: () => number;
  isAuthenticationCurrent?: (authentication: RemoteCommandAuthentication) => boolean;
  onInternalError?: (command: RemoteCommandName, error: unknown) => void;
}

interface MutationQueueEntry {
  aborted: boolean;
  principalId: string;
  resolve: (result: MutationSlotResult) => void;
  signal?: AbortSignal;
  stopAbort?: () => void;
}

type MutationSlotResult =
  | { kind: 'acquired'; release: () => void }
  | { kind: 'gateway-draining' | 'rate-limited' | 'request-aborted' };

function requirePositiveCapacity(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return capacity;
}

function requireBodyLimit(value: number | undefined): number {
  const limit = requirePositiveCapacity(value, DEFAULT_MAX_BODY_BYTES, 'Remote body limit');
  if (limit > DEFAULT_MAX_BODY_BYTES) {
    throw new TypeError('Remote body limit cannot exceed 1 MiB');
  }
  return limit;
}

function getJsonBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return null;
  }
}

function isSafeContextValue(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    SAFE_CONTEXT_VALUE.test(value)
  );
}

function getAuthenticationError(
  authentication: RemoteCommandAuthentication | null,
  now: number,
): RemoteCommandGatewayErrorCode | null {
  if (
    !authentication ||
    (authentication.kind !== 'browser-session' &&
      authentication.kind !== 'bearer' &&
      authentication.kind !== 'trusted-local') ||
    !authentication.grants ||
    typeof authentication.grants.has !== 'function' ||
    typeof authentication.grants[Symbol.iterator] !== 'function' ||
    !isSafeContextValue(authentication.principalId, 256) ||
    !isSafeContextValue(authentication.authEpoch, 128) ||
    !isSafeContextValue(authentication.authenticationSessionGeneration, 128) ||
    !Number.isFinite(authentication.expiresAt) ||
    authentication.expiresAt <= now ||
    [...authentication.grants].some((grant) => !REMOTE_GRANT_SET.has(grant)) ||
    (authentication.sourceId !== undefined &&
      authentication.sourceId !== null &&
      !isSafeContextValue(authentication.sourceId, 128))
  ) {
    return 'unauthenticated';
  }
  return null;
}

function getRemoteTransportError(
  authentication: RemoteCommandAuthentication,
  requireBrowserRequestProof: boolean,
): RemoteCommandGatewayErrorCode | null {
  if (authentication.kind === 'trusted-local') return null;
  if (authentication.transportSecure !== true) return 'secure-transport-required';
  if (authentication.directPeerValidated !== true) return 'untrusted-peer';
  if (requireBrowserRequestProof && authentication.kind === 'browser-session') {
    if (authentication.originValidated !== true) return 'origin-rejected';
    if (authentication.csrfValidated !== true) return 'csrf-rejected';
  }
  return null;
}

function errorResult(code: RemoteCommandGatewayErrorCode): RemoteCommandGatewayResult<never> {
  return {
    ok: false,
    error: code === 'rate-limited' ? { code, retryAfterMs: 250 } : { code },
  };
}

function isMutation(effect: RemoteCommandEffect): boolean {
  return effect !== 'read';
}

function isRegistrationAvailable(registration: RemoteCommandRegistration): boolean {
  try {
    return registration.isAvailable?.() !== false;
  } catch {
    return false;
  }
}

export class RemoteCommandGateway {
  private readonly activeByPrincipal = new Map<string, number>();
  private activeMutations = 0;
  private readonly maxActiveMutations: number;
  private readonly maxActiveMutationsPerPrincipal: number;
  private readonly maxBodyBytes: number;
  private readonly maxQueuedMutations: number;
  private mutationAdmissionOpen: boolean;
  private readonly now: () => number;
  private readonly registrations = new Map<RemoteCommandName, RemoteCommandRegistration>();
  private readonly queue: MutationQueueEntry[] = [];
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    registrations: RemoteCommandRegistrationTable,
    private readonly options: RemoteCommandGatewayOptions = {},
  ) {
    this.maxActiveMutations = requirePositiveCapacity(
      options.maxActiveMutations,
      DEFAULT_MAX_ACTIVE_MUTATIONS,
      'Remote mutation capacity',
    );
    this.maxActiveMutationsPerPrincipal = requirePositiveCapacity(
      options.maxActiveMutationsPerPrincipal,
      DEFAULT_MAX_ACTIVE_MUTATIONS_PER_PRINCIPAL,
      'Remote principal mutation capacity',
    );
    this.maxBodyBytes = requireBodyLimit(options.maxBodyBytes);
    this.maxQueuedMutations = requirePositiveCapacity(
      options.maxQueuedMutations,
      DEFAULT_MAX_QUEUED_MUTATIONS,
      'Remote mutation queue capacity',
    );
    this.mutationAdmissionOpen = options.mutationAdmissionInitiallyOpen === true;
    this.now = options.now ?? Date.now;

    for (const [name, registration] of Object.entries(registrations)) {
      if (!REMOTE_COMMAND_NAME_SET.has(name) || !registration) {
        throw new TypeError(`Remote command registration ${name} is not allowlisted`);
      }
      this.registrations.set(name as RemoteCommandName, registration);
    }
  }

  getCapabilities(
    authentication: RemoteCommandAuthentication | null,
  ): RemoteCommandCapabilitySnapshot {
    const authenticationError = getAuthenticationError(authentication, this.readNow());
    if (
      authenticationError ||
      !authentication ||
      this.options.isAuthenticationCurrent?.(authentication) === false ||
      getRemoteTransportError(authentication, false)
    ) {
      return { commands: [], mutationAdmission: 'draining' };
    }
    const grants = new Set(authentication.grants);
    const commands = [...this.registrations.keys()].filter((command) => {
      const registration = this.registrations.get(command);
      return (
        registration !== undefined &&
        isRegistrationAvailable(registration) &&
        REMOTE_COMMAND_POLICIES[command].grants.every((grant) => grants.has(grant)) &&
        (this.mutationAdmissionOpen || !isMutation(REMOTE_COMMAND_POLICIES[command].effect))
      );
    });
    return {
      commands,
      mutationAdmission: this.mutationAdmissionOpen ? 'open' : 'draining',
    };
  }

  openMutationAdmission(): void {
    if (this.activeMutations !== 0 || this.drainWaiters.size !== 0) {
      throw new Error('Remote mutation admission cannot open before the current drain completes');
    }
    this.mutationAdmissionOpen = true;
    this.pumpQueue();
  }

  async closeAndDrainMutations(): Promise<void> {
    this.mutationAdmissionOpen = false;
    for (const entry of this.queue.splice(0)) {
      entry.stopAbort?.();
      entry.resolve({ kind: 'gateway-draining' });
    }
    if (this.activeMutations === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  async dispatch(
    commandValue: string,
    authentication: RemoteCommandAuthentication | null,
    body: unknown,
    signal?: AbortSignal,
    serializedBodyBytes?: number,
  ): Promise<RemoteCommandGatewayResult> {
    if (!REMOTE_COMMAND_NAME_SET.has(commandValue)) return errorResult('unsupported-command');
    const command = commandValue as RemoteCommandName;
    const registration = this.registrations.get(command);
    if (!registration || !isRegistrationAvailable(registration)) {
      return errorResult('unsupported-command');
    }

    const authenticationError = getAuthenticationError(authentication, this.readNow());
    if (
      authenticationError ||
      !authentication ||
      this.options.isAuthenticationCurrent?.(authentication) === false
    ) {
      return errorResult(authenticationError ?? 'unauthenticated');
    }
    const transportError = getRemoteTransportError(authentication, true);
    if (transportError) return errorResult(transportError);
    const grants = new Set(authentication.grants);
    const policy = REMOTE_COMMAND_POLICIES[command];
    if (policy.grants.some((grant) => !grants.has(grant))) {
      return errorResult('forbidden');
    }
    if (!isRecord(body)) return errorResult('bad-request');
    const bodyBytes =
      serializedBodyBytes === undefined
        ? getJsonBytes(body)
        : Number.isSafeInteger(serializedBodyBytes) && serializedBodyBytes >= 0
          ? serializedBodyBytes
          : null;
    if (bodyBytes === null) return errorResult('bad-request');
    if (bodyBytes > this.maxBodyBytes) return errorResult('payload-too-large');
    if (!registration.isRequest(body)) return errorResult('bad-request');
    const requiredGrants = registration.requiredGrants?.(body) ?? [];
    if (requiredGrants.some((grant) => !grants.has(grant))) {
      return errorResult('forbidden');
    }

    let releaseMutation: (() => void) | null = null;
    if (isMutation(policy.effect)) {
      const slot = await this.acquireMutationSlot(authentication.principalId, signal);
      if (slot.kind !== 'acquired') return errorResult(slot.kind);
      releaseMutation = slot.release;
      if (
        getAuthenticationError(authentication, this.readNow()) ||
        this.options.isAuthenticationCurrent?.(authentication) === false
      ) {
        releaseMutation();
        releaseMutation = null;
        return errorResult('unauthenticated');
      }
      if (!isRegistrationAvailable(registration)) {
        releaseMutation();
        releaseMutation = null;
        return errorResult('unsupported-command');
      }
    }

    const context: RemoteCommandExecutionContext = Object.freeze({
      authEpoch: authentication.authEpoch,
      authenticationSessionGeneration: authentication.authenticationSessionGeneration,
      hasGrant: (grant: RemoteGrant) => grants.has(grant),
      principalId: authentication.principalId,
      sourceId: authentication.sourceId ?? null,
    });
    try {
      const result = await registration.execute(context, body, signal);
      if (!registration.isResult(result)) {
        this.options.onInternalError?.(
          command,
          new Error('Remote command response contract failed'),
        );
        return errorResult('internal-error');
      }
      return { ok: true, result };
    } catch (error) {
      this.options.onInternalError?.(command, error);
      return errorResult('internal-error');
    } finally {
      releaseMutation?.();
    }
  }

  private acquireMutationSlot(
    principalId: string,
    signal?: AbortSignal,
  ): Promise<MutationSlotResult> {
    if (!this.mutationAdmissionOpen) {
      return Promise.resolve({ kind: 'gateway-draining' });
    }
    if (signal?.aborted) return Promise.resolve({ kind: 'request-aborted' });
    if (this.canAcquire(principalId)) {
      return Promise.resolve({ kind: 'acquired', release: this.takeSlot(principalId) });
    }
    if (this.queue.length >= this.maxQueuedMutations) {
      return Promise.resolve({ kind: 'rate-limited' });
    }
    return new Promise<MutationSlotResult>((resolve) => {
      const entry: MutationQueueEntry = {
        aborted: false,
        principalId,
        resolve,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        const handleAbort = () => {
          if (entry.aborted) return;
          entry.aborted = true;
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          resolve({ kind: 'request-aborted' });
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        entry.stopAbort = () => signal.removeEventListener('abort', handleAbort);
      }
      this.queue.push(entry);
    });
  }

  private canAcquire(principalId: string): boolean {
    return (
      this.activeMutations < this.maxActiveMutations &&
      (this.activeByPrincipal.get(principalId) ?? 0) < this.maxActiveMutationsPerPrincipal
    );
  }

  private takeSlot(principalId: string): () => void {
    this.activeMutations += 1;
    this.activeByPrincipal.set(principalId, (this.activeByPrincipal.get(principalId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeMutations -= 1;
      const principalCount = (this.activeByPrincipal.get(principalId) ?? 1) - 1;
      if (principalCount === 0) this.activeByPrincipal.delete(principalId);
      else this.activeByPrincipal.set(principalId, principalCount);
      this.pumpQueue();
      if (this.activeMutations === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  private pumpQueue(): void {
    if (!this.mutationAdmissionOpen) return;
    while (this.activeMutations < this.maxActiveMutations) {
      const index = this.queue.findIndex(
        (entry) => !entry.aborted && this.canAcquire(entry.principalId),
      );
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      if (!entry || entry.aborted) continue;
      entry.stopAbort?.();
      entry.resolve({ kind: 'acquired', release: this.takeSlot(entry.principalId) });
    }
  }

  private readNow(): number {
    const now = this.now();
    return Number.isFinite(now) ? now : Number.POSITIVE_INFINITY;
  }
}

export function createRemoteCommandGateway(
  registrations: RemoteCommandRegistrationTable,
  options: RemoteCommandGatewayOptions = {},
): RemoteCommandGateway {
  return new RemoteCommandGateway(registrations, options);
}

/** Compose independently owned command slices while rejecting shadowed policy. */
export function mergeRemoteCommandRegistrationTables(
  ...tables: readonly RemoteCommandRegistrationTable[]
): RemoteCommandRegistrationTable {
  const merged: RemoteCommandRegistrationTable = {};
  for (const table of tables) {
    for (const [name, registration] of Object.entries(table)) {
      if (!registration) continue;
      if (name in merged) {
        throw new TypeError(`Duplicate remote command registration: ${name}`);
      }
      merged[name as RemoteCommandName] = registration;
    }
  }
  return merged;
}

export function isRemoteCommandName(value: unknown): value is RemoteCommandName {
  return typeof value === 'string' && REMOTE_COMMAND_NAME_SET.has(value);
}

export function getRemoteCommandPolicy(command: RemoteCommandName): Readonly<{
  effect: RemoteCommandEffect;
  grants: readonly RemoteGrant[];
}> {
  return REMOTE_COMMAND_POLICIES[command];
}
