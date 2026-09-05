export interface NewTaskDraftText {
  name: string;
  prompt: string;
}

export type NewTaskDraftBaseline = Readonly<NewTaskDraftText>;

function normalizeDraftField(value: string): string {
  return value.trim();
}

export function createNewTaskDraftBaseline(value: NewTaskDraftText): NewTaskDraftBaseline {
  return {
    name: normalizeDraftField(value.name),
    prompt: normalizeDraftField(value.prompt),
  };
}

export function hasMeaningfulNewTaskDraftChange(
  baseline: NewTaskDraftBaseline,
  current: NewTaskDraftText,
): boolean {
  return (
    normalizeDraftField(current.name) !== baseline.name ||
    normalizeDraftField(current.prompt) !== baseline.prompt
  );
}
