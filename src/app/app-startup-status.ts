import { createSignal } from 'solid-js';
import { getTerminalStartupSummary } from '../store/terminal-startup';

export type AppStartupPhase = 'bootstrapping' | 'restoring' | 'finalizing';

export interface AppStartupSummary {
  detail: string | null;
  label: string;
}

interface AppStartupState {
  detail: string | null;
  phase: AppStartupPhase;
}

const [appStartupState, setAppStartupState] = createSignal<AppStartupState | null>(null);

function getAppStartupLabel(phase: AppStartupPhase): string {
  switch (phase) {
    case 'bootstrapping':
      return 'Still loading your workspace…';
    case 'restoring':
      return 'Restoring your workspace…';
    case 'finalizing':
      return 'Finalizing startup…';
  }
}

function combineSummaryDetail(
  lifecycleDetail: string | null,
  terminalDetail: string | null,
): string | null {
  const detailParts = [lifecycleDetail, terminalDetail].filter(
    (part): part is string => part !== null,
  );

  if (detailParts.length === 0) {
    return null;
  }

  return detailParts.join(' · ');
}

export function setAppStartupStatus(phase: AppStartupPhase, detail: string | null): void {
  setAppStartupState((previousState) => {
    if (previousState?.phase === phase && previousState.detail === detail) {
      return previousState;
    }

    return {
      detail,
      phase,
    };
  });
}

export function clearAppStartupStatus(): void {
  setAppStartupState((previousState) => {
    if (!previousState) {
      return previousState;
    }

    return null;
  });
}

export function getAppStartupSummary(): AppStartupSummary | null {
  const lifecycleState = appStartupState();
  const terminalSummary = getTerminalStartupSummary();

  if (!lifecycleState && !terminalSummary) {
    return null;
  }

  if (!lifecycleState) {
    return terminalSummary;
  }

  return {
    detail: combineSummaryDetail(
      lifecycleState.detail,
      terminalSummary?.detail ?? terminalSummary?.label ?? null,
    ),
    label: getAppStartupLabel(lifecycleState.phase),
  };
}

export function resetAppStartupStatusForTests(): void {
  clearAppStartupStatus();
}
