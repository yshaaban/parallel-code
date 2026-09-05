import { TASK_INITIAL_PROMPT_HOOK_SET_VERSION } from '../../src/domain/task-initial-prompt-delivery.js';
import type { TaskRemovalOwnerParticipant } from './task-removal-owner.js';
import type { TaskInitialPromptDeliveryService } from './task-initial-prompt-delivery.js';
import type { WorkspaceTaskInitialPromptPersistence } from './task-initial-prompt-delivery-persistence.js';

/**
 * Composes D01's dark persistence and hook owners for the generic Commit 5
 * registrar. It deliberately exposes no queue/send/edit method.
 */
export function createTaskInitialPromptRemovalParticipant(args: {
  persistence: WorkspaceTaskInitialPromptPersistence;
  service: TaskInitialPromptDeliveryService;
}): TaskRemovalOwnerParticipant {
  return {
    async activateLegacyEffectCutover(cutoverEpoch) {
      const result =
        await args.persistence.activatePromptProtectionAndDisableLegacyWriters(cutoverEpoch);
      if (
        result.cutoverEpoch !== cutoverEpoch ||
        result.hookSetVersion !== TASK_INITIAL_PROMPT_HOOK_SET_VERSION ||
        !result.legacyWritersDisabled
      ) {
        throw new Error('Initial prompt cutover returned a mismatched capability');
      }
    },
    drainTaskForRemoval: (request) => args.service.drainTaskForRemoval(request),
    finalizeRemovedTaskState: (request) =>
      args.service.finalizeRemovedTaskInitialPromptState(request),
    hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
    id: 'initial-prompt',
    async probe() {
      await args.persistence.ensureDarkJournalReady();
      const hooks = args.service.probeRemovalHooks();
      return hooks.drainHookVersion === TASK_INITIAL_PROMPT_HOOK_SET_VERSION &&
        hooks.finalizerHookVersion === TASK_INITIAL_PROMPT_HOOK_SET_VERSION
        ? { hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION, kind: 'ready' }
        : {
            hookSetVersion: TASK_INITIAL_PROMPT_HOOK_SET_VERSION,
            kind: 'unavailable',
            reason: 'hook-version-mismatch',
          };
    },
    verifyLegacyEffectCutover: (cutoverEpoch) =>
      args.persistence.verifyPromptProtectionCutover(cutoverEpoch),
  };
}
