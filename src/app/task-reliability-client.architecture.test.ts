import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('task reliability transport architecture', () => {
  it('registers the public transport only through the active production capability boundary', () => {
    const client = source('src/app/task-reliability-client.ts');
    const channels = source('electron/ipc/channels.ts');
    const preload = source('electron/preload.cjs');
    const reliabilityIpc = source('electron/ipc/task-reliability-ipc.ts');
    const composition = source('electron/ipc/task-experience-runtime-composition.ts');
    const electronRegistration = source('electron/ipc/register.ts');
    const browserHost = source('server/browser-server.ts');

    expect(client).not.toContain('electron/ipc/channels');
    expect(client).not.toContain('../lib/ipc');
    for (const activePublicId of [
      'execute_agent_session_operation',
      'get_agent_session_operation_projection',
      'get_task_reliability_capabilities',
      'get_initial_prompt_delivery_projection',
      'resolve_initial_prompt_ambiguity',
      'revise_initial_prompt_draft',
      'send_initial_prompt_manually',
      'task_reliability_changed',
    ]) {
      expect(channels).toContain(activePublicId);
      expect(preload).toContain(activePublicId);
    }
    expect(channels).not.toContain('send_task_initial_prompt_manually');
    expect(preload).not.toContain('send_task_initial_prompt_manually');
    expect(reliabilityIpc).toContain("prompt.registrationState !== 'active'");
    expect(reliabilityIpc).toContain('createActiveTaskReliabilityIpcHandlers');
    expect(composition).toContain('activateTaskCreationRuntime');
    expect(composition).toContain('exactActiveCapabilities');
    expect(electronRegistration).toContain('getTaskExperienceRuntime()');
    expect(electronRegistration).toContain('createActiveTaskReliabilityIpcHandlers(runtime)');
    expect(browserHost).toContain('createProductionTaskExperienceRuntime');
    expect(browserHost).toContain('activateTaskExperienceTransports');
  });

  it('contains one hard-dark local default and no renderer activation flag', () => {
    const runtime = source('src/domain/task-reliability-runtime.ts');
    const client = source('src/app/task-reliability-client.ts');
    const production = source('src/app/task-reliability-production.ts');

    expect(runtime).toContain('DARK_TASK_RELIABILITY_RUNTIME_CAPABILITIES');
    expect(runtime).not.toMatch(/localStorage|sessionStorage|featureFlag|environment/iu);
    expect(client).toContain('transport.capabilities.read');
    expect(client).not.toMatch(/localStorage|sessionStorage|URLSearchParams/iu);
    expect(production).toContain('invokeWithAbortSignal');
    expect(production).toContain('listenRendererEvent');
    expect(production).not.toContain('window.electron');
  });

  it('keeps initial-prompt readiness, dispatch, and reconciliation behind the typed owner', () => {
    const promptInput = source('src/components/PromptInput.tsx');
    const taskPanel = source('src/components/TaskPanel.tsx');
    const deliveryControl = source('src/components/InitialPromptDeliveryControl.tsx');

    expect(promptInput).toContain('InitialPromptDeliveryControl');
    expect(promptInput).toContain('initialPromptDeliveryId');
    expect(promptInput).toContain('when={!props.initialPromptDeliveryId}');
    expect(promptInput).toContain("import('./InitialPromptDeliveryControl')");
    expect(promptInput).not.toMatch(
      /^import\s+\{[^}]*InitialPromptDeliveryControl[^}]*\}\s+from/mu,
    );
    expect(deliveryControl).toContain('client.initialPromptDelivery.sendManually');
    expect(deliveryControl).toContain('client.initialPromptDelivery.resolveAmbiguity');
    expect(deliveryControl).toContain('getProductionTaskReliabilityClient');
    expect(deliveryControl).not.toContain('sendPrompt(');
    expect(taskPanel).not.toContain('clearInitialPrompt');
    for (const forbiddenLegacyMechanism of [
      'onAgentReady',
      'hasReadyPromptInTail',
      'waitForPromptAppearance',
      'PROMPT_VERIFY_TIMEOUT_MS',
      'setAutoSentInitialPrompt',
      "handleSend('auto')",
    ]) {
      expect(promptInput).not.toContain(forbiddenLegacyMechanism);
    }
  });

  it('loads manual agent-session policy only at its explicit action boundary', () => {
    const terminalSection = source('src/components/task-panel/TaskAiTerminalSection.tsx');
    const workflow = source('src/app/agent-session-workflows.ts');

    expect(terminalSection).toContain("import('../../app/agent-session-workflows')");
    expect(terminalSection).toContain("from '../../app/agent-session-action'");
    expect(terminalSection).not.toMatch(/from\s+['"]\.\.\/\.\.\/app\/agent-session-workflows/gu);
    expect(workflow).toContain("from './agent-session-action'");
    expect(workflow).toContain("from './task-command-lease-runtime'");
    expect(workflow).toContain("from './task-command-lease-session'");
    expect(workflow).not.toContain("from './task-command-lease'");
  });
});
