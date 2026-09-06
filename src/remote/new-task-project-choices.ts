import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';

import type { TaskCreationClientFacade, TaskCreationPickerItem } from '../domain/task-creation';

export interface ProjectChoiceState<T> {
  items: T[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  truncated: boolean;
}

function createProjectChoices<T>(
  projectId: Accessor<string>,
  load: (projectId: string, signal: AbortSignal) => Promise<{ items: T[]; truncated: boolean }>,
  resetSelection: () => void,
) {
  const [state, setState] = createSignal<ProjectChoiceState<T>>({
    items: [],
    status: 'idle',
    truncated: false,
  });
  const [retryVersion, setRetryVersion] = createSignal(0);

  createEffect(() => {
    const selectedProjectId = projectId();
    retryVersion();
    untrack(resetSelection);
    setState({ items: [], status: selectedProjectId ? 'loading' : 'idle', truncated: false });
    if (!selectedProjectId) return;

    // Every request belongs to one project selection, including A → B → A and retries.
    const request = new AbortController();
    onCleanup(() => request.abort());
    void load(selectedProjectId, request.signal).then(
      (result) => {
        if (!request.signal.aborted) setState({ ...result, status: 'ready' });
      },
      () => {
        if (!request.signal.aborted) setState({ items: [], status: 'error', truncated: false });
      },
    );
  });

  return { state, retry: () => setRetryVersion((version) => version + 1) };
}

export function createNewTaskProjectChoices(options: {
  facade: TaskCreationClientFacade;
  projectId: Accessor<string>;
  resetBaseBranch: () => void;
  resetExistingWorktree: () => void;
  resetReuseDependencies: () => void;
}) {
  async function loadPicker<K extends TaskCreationPickerItem['kind']>(
    projectId: string,
    kind: K,
    signal: AbortSignal,
  ): Promise<{ items: Extract<TaskCreationPickerItem, { kind: K }>[]; truncated: boolean }> {
    const items: TaskCreationPickerItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await options.facade.getPickerPage(
        {
          kind,
          projectId,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      );
      signal.throwIfAborted();
      if (page.kind !== kind || page.items.some((item) => item.kind !== kind)) {
        throw new Error('Invalid picker page');
      }
      items.push(...page.items);
      if (items.length > 512) throw new Error('Picker choices exceed their bound');
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) {
        return {
          items: items as Extract<TaskCreationPickerItem, { kind: K }>[],
          truncated: page.truncated,
        };
      }
      if (seenCursors.has(cursor) || seenCursors.size >= 64) {
        throw new Error('Picker pagination did not finish');
      }
      seenCursors.add(cursor);
    } while (cursor !== undefined);
    throw new Error('Picker pagination did not finish');
  }

  return {
    branches: createProjectChoices(
      options.projectId,
      (projectId, signal) => loadPicker(projectId, 'base-branch', signal),
      options.resetBaseBranch,
    ),
    worktrees: createProjectChoices(
      options.projectId,
      (projectId, signal) => loadPicker(projectId, 'existing-worktree', signal),
      options.resetExistingWorktree,
    ),
    links: createProjectChoices(
      options.projectId,
      async (projectId, signal) => {
        const result = await options.facade.getWorktreeLinkCandidates({ projectId }, signal);
        if (result.kind !== 'found') throw new Error('Dependency choices unavailable');
        return {
          items: result.candidates
            .filter((candidate) => candidate.isDefault)
            .map((candidate) => candidate.name),
          truncated: result.truncated,
        };
      },
      options.resetReuseDependencies,
    ),
  };
}
