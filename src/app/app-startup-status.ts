import { createSignal } from 'solid-js';
import { assertNever } from '../lib/assert-never';
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
// Presentation pending is the coarse "the workspace shape is not trustworthy
// yet" window: it begins at desktop session entry and ends with startup
// completion, failure, or session dispose (all of which clear startup status).
const [appStartupPresentationPending, setAppStartupPresentationPending] = createSignal(false);

export function beginAppStartupPresentation(): void {
  setAppStartupPresentationPending(true);
}

export function completeAppStartupPresentation(): void {
  setAppStartupPresentationPending(false);
}

export function isAppStartupPresentationPending(): boolean {
  return appStartupPresentationPending();
}

function getAppStartupLabel(phase: AppStartupPhase): string {
  switch (phase) {
    case 'bootstrapping':
      return 'Still loading your workspace…';
    case 'restoring':
      return 'Restoring your workspace…';
    case 'finalizing':
      return 'Finalizing startup…';
    default:
      return assertNever(phase, 'Unhandled app startup phase');
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
  completeAppStartupPresentation();
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

  if (!lifecycleState) {
    if (!terminalSummary) {
      return null;
    }

    return {
      detail: terminalSummary.detail,
      label: terminalSummary.label,
    };
  }

  return {
    detail: combineSummaryDetail(lifecycleState.detail, terminalSummary?.detail ?? null),
    label: getAppStartupLabel(lifecycleState.phase),
  };
}

export function resetAppStartupStatusForTests(): void {
  clearAppStartupStatus();
}
