import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('task structure ownership architecture', () => {
  it('keeps presentation-only close state out of persistence membership decisions', () => {
    const persistence = source('src/store/persistence-codecs.ts');
    expect(persistence).not.toContain("from '../domain/task-closing'");
    expect(persistence).not.toContain('isTaskRemoving');
    expect(persistence).not.toContain('isTerminalRemoving');
  });

  it('wires the shared host owner before semantic task handlers are composed', () => {
    const handlers = source('electron/ipc/handlers.ts');
    const systemComposition = handlers.indexOf(
      'const systemHandlers = createSystemIpcHandlers(runtimeContext',
    );
    const taskComposition = handlers.indexOf('...createTaskAndGitIpcHandlers(runtimeContext');
    expect(systemComposition).toBeGreaterThan(-1);
    expect(taskComposition).toBeGreaterThan(systemComposition);
  });

  it('routes ordinary backend create and removal through the structural owner', () => {
    const taskHandlers = source('electron/ipc/task-git-handlers.ts');
    const structure = source('electron/ipc/task-structure-mutations.ts');
    expect(taskHandlers).toContain('await addPreparedTaskToWorkspace(context, request, result)');
    expect(taskHandlers).toContain('await removeTaskUsingOwnerOrLegacy(');
    expect(taskHandlers).toContain('host.getTaskRemovalLegacyWriterGate()');
    expect(structure).toContain('removeTaskWithLegacyFallback<TResult>');
    expect(taskHandlers).not.toContain('nextSharedState: request');
  });

  it('does not expose generic task add/remove edit intents to the renderer', () => {
    const intents = source('src/domain/workspace-edit-intents.ts');
    expect(intents).not.toMatch(/kind:\s*['"](?:add|remove)-task['"]/u);
  });

  it('keeps the private closing index subordinate to the sole removal owner', () => {
    const coordination = source('electron/ipc/task-removal-notes-coordination.ts');
    const removalOwner = source('electron/ipc/task-removal-owner.ts');
    const notesService = source('electron/ipc/task-notes-service.ts');

    expect(coordination).toContain('class TaskClosingAdmissionIndex');
    expect(coordination).not.toContain('export class TaskClosingAdmissionIndex');
    expect(removalOwner).toContain('new TaskRemovalNotesCoordination(');
    expect(notesService).not.toContain('TaskClosingAdmissionIndex');
    expect(notesService).not.toContain('taskRemovalOperations');
    expect(notesService).not.toContain('taskNotesStructuralAuthority');
  });

  it('keeps dark owner activation independent of handlers and presentation', () => {
    const activation = source('electron/ipc/task-structural-runtime-activation.ts');
    expect(activation).toContain('activateTaskRemovalOwner');
    expect(activation).toContain('activateTaskNotesStructuralAuthority');
    expect(activation).not.toMatch(
      /from ['"][^'"]*(?:channels|register|renderer|components)[^'"]*['"]/u,
    );
    expect(activation).not.toContain('IPC.');
  });
});
