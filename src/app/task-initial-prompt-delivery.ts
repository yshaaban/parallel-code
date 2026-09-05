import {
  TASK_INITIAL_PROMPT_READINESS_POLICY,
  deriveManualInitialPromptSendOperationId,
  deriveTaskInitialPromptDraftFingerprint,
  type ManualInitialPromptSendOperationSnapshot,
  type ReviseTaskInitialPromptDraftRequest,
  type ReviseTaskInitialPromptDraftResult,
  type SendTaskInitialPromptManuallyRequest,
  type TaskInitialPromptDeliveryProjection,
  type TaskInitialPromptDraftSnapshot,
} from '../domain/task-initial-prompt-delivery.js';
import { canDispatchToTask, reduceTaskRemovalCurrentProjection } from '../domain/task-catalog.js';

export type TaskInitialPromptManualAction =
  | { kind: 'send' }
  | { failedAttempt: number; kind: 'retry-proven-not-sent' }
  | { expectedOperationVersion: number; kind: 'mark-observed-sent' }
  | { expectedOperationVersion: number; kind: 'abandon-to-terminal' }
  | { kind: 'inspect-and-copy' }
  | { kind: 'none' };

export interface TaskInitialPromptPresentation {
  action: TaskInitialPromptManualAction;
  actionAllowed: boolean;
  message: string;
  tone: 'neutral' | 'progress' | 'warning' | 'success';
}

export interface TaskInitialPromptDraftControllerSnapshot {
  acknowledged: TaskInitialPromptDraftSnapshot | null;
  conflict: TaskInitialPromptDraftSnapshot | null;
  inFlight: boolean;
  saveError: string | null;
  trailingEditQueued: boolean;
  visibleText: string;
}

export interface TaskInitialPromptDraftController {
  acknowledge(snapshot: TaskInitialPromptDraftSnapshot | null): void;
  flush(): Promise<void>;
  getSnapshot(): TaskInitialPromptDraftControllerSnapshot;
  replaceConflictWithMine(): Promise<void>;
  reviewCurrent(): void;
  setVisibleText(text: string): void;
  useCurrent(): void;
}

export interface TaskInitialPromptDraftControllerOptions {
  createEditOperationId(): string;
  deliveryId: string;
  initialDraft: TaskInitialPromptDraftSnapshot | null;
  onChange?(snapshot: TaskInitialPromptDraftControllerSnapshot): void;
  submit(request: ReviseTaskInitialPromptDraftRequest): Promise<ReviseTaskInitialPromptDraftResult>;
  taskId: string;
}

export function isManualInitialPromptOperationForDraft(
  operation: ManualInitialPromptSendOperationSnapshot,
  draft: TaskInitialPromptDraftSnapshot | null,
): boolean {
  if (!draft) return false;
  return (
    operation.acknowledgedDraftFingerprint === draft.fingerprint &&
    operation.acknowledgedEditRevision === draft.editRevision &&
    operation.manualSendOperationId ===
      deriveManualInitialPromptSendOperationId({
        acknowledgedDraftFingerprint: draft.fingerprint,
        acknowledgedEditRevision: draft.editRevision,
        deliveryId: operation.deliveryId,
      })
  );
}

function chooseManualOperation(
  current: ManualInitialPromptSendOperationSnapshot | undefined,
  incoming: ManualInitialPromptSendOperationSnapshot | undefined,
): ManualInitialPromptSendOperationSnapshot | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  if (current.manualSendOperationId === incoming.manualSendOperationId) {
    return incoming.version >= current.version ? incoming : current;
  }
  if (incoming.acknowledgedEditRevision !== current.acknowledgedEditRevision) {
    return incoming.acknowledgedEditRevision > current.acknowledgedEditRevision
      ? incoming
      : current;
  }
  return incoming.createdAt >= current.createdAt ? incoming : current;
}

function chooseDraft(
  current: TaskInitialPromptDraftSnapshot | null,
  incoming: TaskInitialPromptDraftSnapshot | null,
  operationProgressed: boolean,
): TaskInitialPromptDraftSnapshot | null {
  if (!current) return incoming && operationProgressed ? incoming : null;
  if (!incoming) return operationProgressed ? null : current;
  return incoming.workspaceRevision >= current.workspaceRevision ? incoming : current;
}

/**
 * Prompt operation versions and catalog cursors deliberately reduce on
 * separate axes. A new server instance resets only the catalog baseline.
 */
export function reduceTaskInitialPromptDeliveryProjection(
  current: TaskInitialPromptDeliveryProjection | null,
  incoming: TaskInitialPromptDeliveryProjection,
): TaskInitialPromptDeliveryProjection {
  if (!current || current.delivery.deliveryId !== incoming.delivery.deliveryId) return incoming;
  const delivery =
    incoming.delivery.version >= current.delivery.version ? incoming.delivery : current.delivery;
  const manualSendOperation = chooseManualOperation(
    current.manualSendOperation,
    incoming.manualSendOperation,
  );
  const deliveryProgressed = incoming.delivery.version > current.delivery.version;
  const manualOperationProgressed =
    incoming.manualSendOperation !== undefined &&
    (current.manualSendOperation === undefined ||
      incoming.manualSendOperation.manualSendOperationId !==
        current.manualSendOperation.manualSendOperationId ||
      incoming.manualSendOperation.version > current.manualSendOperation.version);
  const manualHighWaterProgressed =
    incoming.manualSendHighWater !== undefined &&
    (current.manualSendHighWater === undefined ||
      incoming.manualSendHighWater.highestAcknowledgedEditRevision >
        current.manualSendHighWater.highestAcknowledgedEditRevision);
  const manualSendHighWater =
    !current.manualSendHighWater ||
    (incoming.manualSendHighWater?.highestAcknowledgedEditRevision ?? -1) >=
      current.manualSendHighWater.highestAcknowledgedEditRevision
      ? incoming.manualSendHighWater
      : current.manualSendHighWater;
  return {
    current: reduceTaskRemovalCurrentProjection(current.current, incoming.current),
    currentDraft: chooseDraft(
      current.currentDraft,
      incoming.currentDraft,
      deliveryProgressed || manualOperationProgressed || manualHighWaterProgressed,
    ),
    delivery,
    ...(manualSendHighWater ? { manualSendHighWater } : {}),
    ...(manualSendOperation ? { manualSendOperation } : {}),
  };
}

export function getTaskInitialPromptPresentation(
  projection: TaskInitialPromptDeliveryProjection,
): TaskInitialPromptPresentation {
  const actionAllowed = canDispatchToTask(projection.current);
  const operation = projection.manualSendOperation;
  const operationMatchesDraft =
    operation !== undefined &&
    isManualInitialPromptOperationForDraft(operation, projection.currentDraft);
  if (operation?.phase === 'confirmation-required' && operationMatchesDraft) {
    return {
      action: { kind: 'send' },
      actionAllowed,
      message: 'This prompt may already have been sent. Check the terminal before confirming.',
      tone: 'warning',
    };
  }
  if (operation?.phase === 'failed-before-write' && operationMatchesDraft) {
    return {
      action: { failedAttempt: operation.attempt, kind: 'retry-proven-not-sent' },
      actionAllowed,
      message: 'No prompt bytes were accepted. Retry when the agent is ready.',
      tone: 'warning',
    };
  }
  if (operation?.phase === 'manual-reconciliation-required') {
    return {
      action: { kind: 'inspect-and-copy' },
      actionAllowed: false,
      message: 'The write outcome is uncertain. Inspect the terminal before reconciling.',
      tone: 'warning',
    };
  }
  if (operation?.phase === 'write-accepted') {
    return {
      action: { kind: 'none' },
      actionAllowed: false,
      message: 'Prompt accepted. Finalizing the saved draft…',
      tone: 'progress',
    };
  }
  if (operation?.phase === 'completed' || projection.delivery.status === 'delivered') {
    return {
      action: { kind: 'none' },
      actionAllowed: false,
      message: 'Initial prompt sent.',
      tone: 'success',
    };
  }
  if (!projection.currentDraft) {
    return {
      action: { kind: 'none' },
      actionAllowed: false,
      message: 'No pending initial prompt.',
      tone: 'neutral',
    };
  }
  return {
    action: { kind: 'send' },
    actionAllowed,
    message:
      projection.delivery.status === 'manual-required'
        ? 'Automatic delivery stopped. Send the acknowledged draft manually.'
        : 'Waiting for the agent to become ready.',
    tone: projection.delivery.status === 'manual-required' ? 'warning' : 'progress',
  };
}

export function createManualInitialPromptSendRequest(args: {
  action?: SendTaskInitialPromptManuallyRequest['action'];
  agentId: string;
  confirmPossiblePriorAutomaticWrite: boolean;
  draft: TaskInitialPromptDraftSnapshot;
  deliveryId: string;
  expectedAgentGeneration: number;
  taskId: string;
}): SendTaskInitialPromptManuallyRequest {
  const manualSendOperationId = deriveManualInitialPromptSendOperationId({
    acknowledgedDraftFingerprint: args.draft.fingerprint,
    acknowledgedEditRevision: args.draft.editRevision,
    deliveryId: args.deliveryId,
  });
  return {
    action: args.action ?? { kind: 'send' },
    agentId: args.agentId,
    confirmPossiblePriorAutomaticWrite: args.confirmPossiblePriorAutomaticWrite,
    deliveryId: args.deliveryId,
    expectedAgentGeneration: args.expectedAgentGeneration,
    expectedDraftFingerprint: args.draft.fingerprint,
    expectedEditRevision: args.draft.editRevision,
    manualSendOperationId,
    taskId: args.taskId,
  };
}

export function createTaskInitialPromptDraftController(
  options: TaskInitialPromptDraftControllerOptions,
): TaskInitialPromptDraftController {
  let acknowledged = options.initialDraft;
  let visibleText = options.initialDraft?.text ?? '';
  let conflict: TaskInitialPromptDraftSnapshot | null = null;
  let saveError: string | null = null;
  let inFlight: Promise<void> | null = null;
  let retainedRequest: ReviseTaskInitialPromptDraftRequest | null = null;
  let trailingText: string | null = null;

  function snapshot(): TaskInitialPromptDraftControllerSnapshot {
    return {
      acknowledged,
      conflict,
      inFlight: inFlight !== null,
      saveError,
      trailingEditQueued: trailingText !== null,
      visibleText,
    };
  }

  function publish(): void {
    options.onChange?.(snapshot());
  }

  function createEditRequest(
    base: TaskInitialPromptDraftSnapshot,
    revisedText: string,
  ): ReviseTaskInitialPromptDraftRequest {
    return {
      editOperationId: options.createEditOperationId(),
      expectedDraftFingerprint: base.fingerprint,
      expectedEditRevision: base.editRevision,
      revisedText,
      sourceDeliveryId: options.deliveryId,
      taskId: options.taskId,
    };
  }

  async function submitRetainedRequest(
    request: ReviseTaskInitialPromptDraftRequest,
  ): Promise<void> {
    try {
      const result = await options.submit(request);
      if (result.kind === 'saved-manual-draft' || result.kind === 'replayed') {
        retainedRequest = null;
        acknowledged = result.current;
        conflict = null;
        saveError = null;
        const queued = trailingText;
        trailingText = null;
        if (queued !== null && queued !== acknowledged?.text && acknowledged) {
          visibleText = queued;
          const nextRequest = createEditRequest(acknowledged, queued);
          retainedRequest = nextRequest;
          await submitRetainedRequest(nextRequest);
        }
        return;
      }
      if (
        result.kind === 'draft-conflict' ||
        result.kind === 'stale-edit' ||
        result.kind === 'draft-changed'
      ) {
        retainedRequest = null;
        conflict = result.current;
        saveError =
          'The draft changed in another session. Review both versions before replacing it.';
        trailingText = null;
        return;
      }
      if (result.kind === 'admission-unavailable') {
        saveError = 'Draft saving is temporarily unavailable. Your text remains local.';
      } else {
        retainedRequest = null;
        conflict = result.current;
        saveError = 'This initial-prompt delivery is closed. Your text remains local.';
        trailingText = null;
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error);
    }
  }

  async function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (conflict) return;
    let request = retainedRequest;
    if (!request) {
      if (!acknowledged || visibleText === acknowledged.text) return;
      request = createEditRequest(acknowledged, visibleText);
      retainedRequest = request;
    }
    const run = submitRetainedRequest(request).finally(() => {
      inFlight = null;
      publish();
    });
    inFlight = run;
    publish();
    return run;
  }

  return {
    acknowledge(next) {
      const visibleMatchedAcknowledged = acknowledged === null || visibleText === acknowledged.text;
      acknowledged = next;
      if (next && !inFlight && !conflict && visibleMatchedAcknowledged) {
        visibleText = next.text;
      }
      publish();
    },
    flush,
    getSnapshot: snapshot,
    async replaceConflictWithMine() {
      if (!conflict) return;
      acknowledged = conflict;
      conflict = null;
      saveError = null;
      await flush();
    },
    reviewCurrent() {
      publish();
    },
    setVisibleText(text) {
      visibleText = text;
      saveError = null;
      if (retainedRequest) {
        trailingText = text === retainedRequest.revisedText ? null : text;
      }
      publish();
    },
    useCurrent() {
      if (!conflict) return;
      acknowledged = conflict;
      visibleText = conflict.text;
      conflict = null;
      saveError = null;
      trailingText = null;
      publish();
    },
  };
}

export function isVisibleInitialPromptDraftAcknowledged(args: {
  agentId: string;
  draft: TaskInitialPromptDraftSnapshot | null;
  taskId: string;
  visibleText: string;
}): boolean {
  if (!args.draft || args.visibleText !== args.draft.text) return false;
  return (
    deriveTaskInitialPromptDraftFingerprint({
      agentId: args.agentId,
      readinessPolicy: TASK_INITIAL_PROMPT_READINESS_POLICY,
      taskId: args.taskId,
      text: args.visibleText,
    }) === args.draft.fingerprint
  );
}
