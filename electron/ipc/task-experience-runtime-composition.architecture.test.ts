import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('production task-experience activation architecture', () => {
  it('activates managed creation before merge and shares that order across desktop and browser', () => {
    const composition = source('electron/ipc/task-experience-runtime-composition.ts');
    const creationActivation = composition.indexOf('await activateTaskCreationRuntime({');
    const mergeActivation = composition.indexOf('await activateTaskMergeBackend({');

    expect(creationActivation).toBeGreaterThan(-1);
    expect(mergeActivation).toBeGreaterThan(creationActivation);
    expect(source('electron/ipc/task-merge-workflow.ts')).toContain(
      'getManagedTaskCreationWriterCapability()',
    );

    for (const host of ['electron/ipc/register.ts', 'server/browser-server.ts']) {
      const hostSource = source(host);
      expect(hostSource).toContain('createProductionTaskExperienceRuntime');
      expect(hostSource).toContain('getTaskCreationCommand');
      expect(hostSource).toContain('getTaskMergeWorkflow');
      expect(hostSource).toContain('.merge.workflow');
      expect(hostSource).not.toContain('activateTaskMergeBackend');
      expect(hostSource).not.toContain('activateTaskCreationRuntime');
    }
  });

  it('keeps standalone transport readiness behind production activation', () => {
    const browser = source('server/browser-server.ts');
    const main = source('server/main.ts');
    const activation = browser.indexOf(
      'const taskExperienceRuntimeStarted = createProductionTaskExperienceRuntime(',
    );
    const listen = browser.indexOf("server.listen(options.port, '0.0.0.0'");

    expect(activation).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(activation);
    expect(browser).toContain('whenReady: () => browserServerReady');
    expect(browser).toContain('error instanceof TaskExperienceRuntimeActivationError');
    expect(browser).toContain('? error.retryCleanup()');
    expect(main).toContain('const controller = startBrowserServer({');
    expect(main).toContain('await controller.whenReady();');
  });

  it('keeps one typed notes writer dark until an exact per-surface proof is composed', () => {
    const handlers = source('electron/ipc/handlers.ts');
    const notesHandlers = source('electron/ipc/task-notes-handlers.ts');
    const panel = source('src/components/task-panel/TaskNotesFilesSection.tsx');
    const storeTasks = source('src/store/tasks.ts');
    const storeBarrel = source('src/store/store.ts');
    const capability = source('src/app/task-notes-capability.ts');
    const desktopCapability = source('src/app/desktop-task-notes-capability.ts');
    const entitlements = source('electron/ipc/task-notes-writer-entitlements.ts');
    const service = source('electron/ipc/task-notes-service.ts');
    const remoteCommands = source('electron/ipc/task-notes-remote-commands.ts');
    const productionMain = source('server/main.ts');
    const electronMain = source('electron/main.ts');
    const electronApplication = source('electron/application.ts');
    const browserTestHarness = source('tests/browser/harness/standalone-server.ts');

    expect(panel).toContain('<TypedTaskNotesEditor');
    expect(panel).not.toContain('updateTaskNotes');
    expect(storeTasks).not.toMatch(/export function updateTaskNotes\s*\(/u);
    expect(storeBarrel).not.toMatch(/\bupdateTaskNotes\b/u);
    expect(handlers).toContain('createTrustedLocalTaskNotesIpcHandlers({');
    expect(capability).toContain('DESKTOP_TASK_NOTES_CAPABILITY');
    expect(capability).toContain('createTaskNotesCapability(false, false)');
    expect(desktopCapability).toContain('invokeOnce(IPC.GetTaskNotesCapability)');
    expect(notesHandlers).toContain('[IPC.GetTaskNotesCapability]');
    expect(notesHandlers).toContain('await options.getService();');
    expect(entitlements).toContain(
      'export const DEFAULT_TASK_NOTES_WRITER_ENTITLEMENTS = createTaskNotesWriterEntitlements();',
    );
    expect(service).toContain('snapshotTaskNotesWriterEntitlements(options.writerEntitlements)');
    expect(service).toContain("inspected.kind === 'admit' && !this.isWriterEntitled(principal)");
    expect(remoteCommands).toContain('isAvailable: writeAvailable');
    expect(productionMain).toContain('void startConfiguredBrowserServer().catch((error) => {');
    expect(electronApplication).toContain('export function startElectronApplication(');
    expect(electronApplication).toContain(
      'snapshotTaskNotesWriterEntitlements(\n    options.taskNotesWriterEntitlements,\n  )',
    );
    expect(electronApplication).toContain(
      'mainWindowRuntime = registerAllHandlers(mainWindow, options)',
    );
    expect(electronApplication).toContain(
      'app.whenReady().then(() => createWindow({ taskNotesWriterEntitlements }))',
    );
    expect(electronApplication).not.toContain('startElectronApplication();');
    expect(electronMain).toContain('startElectronApplication();');
    expect(productionMain).toContain(
      'snapshotTaskNotesWriterEntitlements(\n    options.taskNotesWriterEntitlements,\n  )',
    );
    expect(browserTestHarness).toContain('writeTaskNotesTestLauncher');
    expect(browserTestHarness).toContain('createTaskNotesWriterEntitlements');

    for (const host of ['electron/ipc/register.ts', 'server/browser-server.ts']) {
      const hostSource = source(host);
      const binding = hostSource.indexOf('getTaskNotesService');
      const handlerRegistration = hostSource.indexOf('createIpcHandlers(');
      expect(binding).toBeGreaterThan(-1);
      expect(handlerRegistration).toBeGreaterThan(binding);
      expect(hostSource).toContain(
        'snapshotTaskNotesWriterEntitlements(\n    options.taskNotesWriterEntitlements,\n  )',
      );
    }
  });

  it('shares one composition-owned prompt admission tail across ordinary and initial writes', () => {
    const handlers = source('electron/ipc/handlers.ts');
    const agentHandlers = source('electron/ipc/agent-handlers.ts');
    const ordinary = source('electron/ipc/task-prompt-input-handler.ts');
    const initial = source('electron/ipc/task-initial-prompt-runtime.ts');
    const composition = source('electron/ipc/task-experience-runtime-composition.ts');

    expect(handlers).toContain('createTaskPromptInputAdmissionService({');
    expect(handlers).toContain('context.taskPromptInputAdmission = promptInputAdmission');
    expect(agentHandlers).toContain('admission: options.promptInputAdmission');
    expect(ordinary).not.toContain('createTaskPromptInputAdmissionService');
    expect(initial).not.toContain('createTaskPromptInputAdmissionService');
    expect(initial).toContain('dependencies.promptInputAdmission.admit(expectation, dispatch)');
    expect(handlers).not.toContain('classifyTaskContentRoot');
    expect(composition).toContain('promptInputAdmission.bindTaskClosingResolver(');
    expect(composition).toContain('structure.isTaskMutationAdmissionClosed(taskId)');
    expect(composition).toContain(
      'const releasePromptBinding = releasePromptInputClosingResolver;',
    );
    expect(composition).toContain("label: 'prompt admission binding'");

    const desktop = source('electron/ipc/register.ts');
    expect(desktop.indexOf('const handlers = createIpcHandlers(')).toBeLessThan(
      desktop.indexOf('void getTaskExperienceRuntime()'),
    );
    const browser = source('server/browser-server.ts');
    expect(browser.indexOf('const handlers = createIpcHandlers(')).toBeLessThan(
      browser.indexOf(
        'const taskExperienceRuntimeStarted = createProductionTaskExperienceRuntime(',
      ),
    );
  });

  it('fans one content-free notes event into desktop and both grant-scoped remote hosts', () => {
    const desktop = source('electron/ipc/register.ts');
    const browser = source('server/browser-server.ts');
    const socket = source('electron/remote/ws-server.ts');
    const eventStream = source('src/runtime/task-notes-event-stream.ts');

    expect(desktop).toContain('taskNotesEvents.publish(payload)');
    expect(desktop).toContain('subscribeTaskNotesChanged: taskNotesEvents.subscribe');
    expect(browser).toContain('taskNotesEvents.publish(payload)');
    expect(browser).toContain('subscribeTaskNotesChanged: taskNotesEvents.subscribe');
    expect(socket).toContain("broadcastForGrant('notes:read'");
    expect(socket).toContain('unsubscribeTaskNotesChanged?.()');
    expect(eventStream).toContain('isTaskNotesChangedNotification(value)');
    expect(eventStream).not.toMatch(/notes\s*:/u);
  });

  it('composes capability-bound creation events in both scoped remote hosts only', () => {
    const desktop = source('electron/ipc/register.ts');
    const browser = source('server/browser-server.ts');
    const electronRemote = source('electron/remote/server.ts');
    const standaloneRemote = source('server/scoped-remote-websocket.ts');
    const remoteSocket = source('electron/remote/ws-server.ts');
    const standaloneControlSocket = source('server/browser-websocket.ts');
    const browserControlClient = source('src/lib/browser-control-client.ts');

    for (const host of [desktop, browser]) {
      expect(host).toContain('createRemoteTaskCreationOperationSource(runtime.creation)');
      expect(host).toContain('subscribeTaskCatalog: (listener) => taskCatalog.subscribe(listener)');
    }
    expect(electronRemote).toContain(
      'taskCreationOperations: scopedCommands.taskCreationOperations',
    );
    expect(standaloneRemote).toContain('taskCreationOperations: options.taskCreationOperations');
    expect(remoteSocket).toContain('refreshSubscribedTaskCreationOperations();');
    expect(standaloneControlSocket).toContain("| { type: 'subscribe-task-creation-operation' }");
    expect(standaloneControlSocket).toContain("| { type: 'unsubscribe-task-creation-operation' }");
    expect(browserControlClient).toContain(
      'type BrowserControlIncomingMessage = CoreServerMessage;',
    );
  });

  it('composes one actor-bound local reconciliation owner without a remote transport', () => {
    const composition = source('electron/ipc/task-experience-runtime-composition.ts');
    const localOwner = source('electron/ipc/task-creation-local-reconciliation.ts');
    const localHandlers = source('electron/ipc/task-creation-local-reconciliation-handlers.ts');
    const desktop = source('electron/ipc/register.ts');
    const sharedHandlers = source('electron/ipc/handlers.ts');
    const browser = source('server/browser-server.ts');
    const rendererFacade = source('src/app/task-creation-local-reconciliation.ts');

    expect(composition).toContain('createTaskCreationLocalReconciliationCommands({');
    expect(composition).toContain(
      'buildSnapshot: (record) => creationRuntime.workflow.projectRecord(record)',
    );
    expect(composition).toContain('preparation.reconciliation.probeCommittedMapping(');
    expect(localOwner).toContain('const electronMainAuthority = Object.freeze({});');
    expect(localOwner).toContain('const owningUserCliAuthority = Object.freeze({});');
    expect(localOwner).not.toContain('workspacePrincipalId');
    expect(localHandlers).toContain('runtime.localReconciliation.electronMain');
    expect(localHandlers).not.toContain('owningUserCli');
    expect(desktop).toContain('createTaskCreationLocalReconciliationIpcHandlers(runtime)');
    expect(sharedHandlers).not.toContain('ListTaskCreationReconciliations');
    expect(sharedHandlers).not.toContain('ExecuteTaskCreationReconciliation');
    expect(browser).not.toContain('createTaskCreationLocalReconciliationIpcHandlers');
    expect(rendererFacade).toContain('if (!isElectronRuntime())');

    for (const remotePath of [
      'electron/ipc/task-experience-remote-registrations.ts',
      'electron/ipc/remote-command-gateway.ts',
      'electron/remote/protocol.ts',
      'electron/remote/remote-command-http.ts',
      'server/browser-websocket.ts',
      'server/scoped-remote-websocket.ts',
    ]) {
      const remoteSource = source(remotePath);
      expect(remoteSource).not.toContain('localReconciliation');
      expect(remoteSource).not.toContain('task-creation-local-reconciliation');
      expect(remoteSource).not.toContain('task-creation.reconcile');
      expect(remoteSource).not.toContain('list_task_creation_reconciliations');
      expect(remoteSource).not.toContain('execute_task_creation_reconciliation');
    }
  });

  it('drains scoped mutations before revoking either remote host', () => {
    const electronRemote = source('electron/remote/server.ts');
    const browser = source('server/browser-server.ts');
    const electronDrain = electronRemote.indexOf('await gateway.closeAndDrainMutations()');
    const electronRevoke = electronRemote.indexOf('scopedRuntime?.revokeAll()');

    expect(electronDrain).toBeGreaterThan(-1);
    expect(electronRevoke).toBeGreaterThan(electronDrain);
    expect(browser).toContain(
      'scopedRuntimeAtClose.closeAndDrain().then(() => scopedRuntimeAtClose.revokeAll())',
    );
  });

  it('keeps host fallback runner cleanup behind the task-experience shutdown owner', () => {
    const desktop = source('electron/application.ts');
    const browser = source('server/browser-server.ts');
    const composition = source('electron/ipc/task-experience-runtime-composition.ts');

    expect(composition).toContain('stopAllTaskAgentWorkflows({ keepAdmissionClosed: true })');
    expect(composition).toContain('coordinateTaskExperienceCleanShutdown({');

    const desktopRuntime = desktop.indexOf(
      'const windowRuntimeCleanup = mainWindowRuntime?.cleanup() ?? Promise.resolve();',
    );
    const desktopFallback = desktop.indexOf(
      'const agentRunnerFallbackCleanup = stopAgentRunnersAfterTaskExperience(windowRuntimeCleanup);',
    );
    expect(desktopRuntime).toBeGreaterThan(-1);
    expect(desktopFallback).toBeGreaterThan(desktopRuntime);

    const browserRuntime = browser.indexOf(
      'const taskExperienceRuntimeCleanup = retainObservedRuntimeCleanup(',
    );
    const browserFallback = browser.indexOf(
      'stopAgentRunnersAfterTaskExperience(taskExperienceRuntimeCleanup)',
    );
    expect(browserRuntime).toBeGreaterThan(-1);
    expect(browserFallback).toBeGreaterThan(browserRuntime);
    expect(browser).not.toContain('stopAllTaskAgentWorkflows()');
    expect(desktop).not.toContain('stopAllTaskAgentWorkflows()');
  });
});
