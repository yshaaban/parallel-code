import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('remote task experience activation boundary', () => {
  it('requires explicit catalog and creation owners and keeps creation fail-closed', () => {
    const app = source('src/remote/App.tsx');
    const composition = source('src/remote/remote-task-experience.ts');

    expect(composition).toContain('readonly catalogRuntime: TaskCatalogRuntime');
    expect(composition).toContain(
      "readonly creationCapabilities: Pick<TaskCreationClientFacade, 'getCapabilities'>",
    );
    expect(app).toContain('taskExperience?: RemoteTaskExperience');
    expect(app).toContain('REMOTE_TASK_CREATION_CAPABILITY_DARK');
    expect(app).toContain('isTaskCreationCapabilities(capabilities)');
    expect(app).toContain('!props.taskExperience || !creationCapabilities().enabled');
    expect(app).toContain("kind: 'list'");
    expect(app).toContain('<Match when={props.taskExperience}>');
    expect(app).not.toContain("kind: 'task-list'");
  });

  it('loads task creation lazily and cannot persist operation authority as a preference', () => {
    const app = source('src/remote/App.tsx');
    const entry = source('src/remote/index.tsx');
    const newTask = source('src/remote/NewTaskView.tsx');
    const preferences = source('src/remote/new-task-preferences.ts');
    const credentials = source('src/remote/task-creation-credentials.ts');

    expect(app).toContain("lazyNamed(() => import('./NewTaskView'), 'NewTaskView')");
    expect(app).not.toMatch(/import\s+\{[^}]*NewTaskView[^}]*\}\s+from/u);
    expect(newTask).toContain("from './task-creation-live-events'");
    expect(newTask).toContain("from './remote-task-creation-ipc'");
    expect(entry).not.toContain('task-creation-live-events');
    expect(entry).not.toContain('remote-task-creation-ipc');
    expect(preferences).not.toMatch(/operationCapability|operationTicket|operationId/iu);
    expect(preferences).toContain('getSafeLocalStorage');
    expect(credentials).toContain('getSafeSessionStorage');
    expect(credentials).toContain('crypto.getRandomValues');
    expect(credentials).not.toContain('getSafeLocalStorage');
  });

  it('keeps task notes and recovery UI lazy behind validated session capabilities', () => {
    const agentDetail = source('src/remote/AgentDetail.tsx');
    const app = source('src/remote/App.tsx');
    const auth = source('src/remote/auth.ts');
    const composition = source('src/remote/remote-task-experience.ts');
    const entry = source('src/remote/index.tsx');
    const taskDetail = source('src/remote/TaskDetail.tsx');
    const taskNotesView = source('src/remote/TaskNotesView.tsx');
    const taskNotesLifecycleChannel = source('src/remote/task-notes-lifecycle-channel.ts');

    expect(composition).toContain('readonly taskNotesCapability: Readonly<TaskNotesCapability>');
    expect(entry).toContain('createTaskNotesCapability(');
    expect(entry).toContain("commands.includes('task-notes.get')");
    expect(entry).toContain("commands.includes('task-notes.issue')");
    expect(entry).toContain("commands.includes('task-notes.update')");
    expect(auth).toContain('REMOTE_SESSION_COMMAND_SET');
    expect(auth).toContain('Object.freeze(commands)');
    expect(taskDetail).toContain("lazyNamed(() => import('./TaskNotesView'), 'TaskNotesView')");
    expect(agentDetail).toContain("lazyNamed(() => import('./TaskNotesView'), 'TaskNotesView')");
    expect(taskNotesView).toContain("() => import('./TaskNotesRecoveryView')");
    expect(app).not.toContain("import('./task-notes-runtime')");
    expect(taskNotesLifecycleChannel).not.toContain('task-notes-runtime');
    expect(taskDetail).not.toMatch(/import\s+\{[^}]*TaskNotesView[^}]*\}\s+from/u);
    expect(agentDetail).not.toMatch(/import\s+\{[^}]*TaskNotesView[^}]*\}\s+from/u);
  });

  it('opens the exact live catalog session without consulting the broad agent projection', () => {
    const app = source('src/remote/App.tsx');
    const start = app.indexOf('function openTaskSession');
    const end = app.indexOf('function closeTaskSession', start);
    const openTaskSession = app.slice(start, end);

    expect(openTaskSession).toContain('projection?.sessions.get(session.sessionId)');
    expect(openTaskSession).toContain("remoteSessionAllows('terminal.attach')");
    expect(openTaskSession).toContain("remoteSessionAllows('terminal.detach')");
    expect(openTaskSession).not.toContain('agents()');
    expect(app).toContain("terminalKill={remoteSessionAllows('terminal.kill')}");
  });

  it('keeps catalog live events behind a typed source without public channel names', () => {
    const domain = source('src/domain/task-catalog.ts');
    const runtime = source('src/remote/task-catalog-store.ts');

    expect(domain).toContain('export interface TaskCatalogLiveEventSource');
    expect(domain).toContain('isTaskCatalogLiveMessage');
    expect(runtime).toContain('connectLiveEvents');
    expect(runtime).toContain('requestResync');
    expect(runtime).not.toContain("from '../../electron/ipc/channels'");
    expect(runtime).not.toContain("from '../lib/ipc'");
  });
});
