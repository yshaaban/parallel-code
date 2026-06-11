import { emitStartupBreadcrumb } from './startup-breadcrumbs';

// Owner for the speculative selected-terminal attach lifecycle. v1 publishes
// the intent and resolves it against the restored selection; no prewarm
// consumer ships yet (the attach-pipeline item may register one). Speculation
// never writes the store, and resolution is mandatory: confirm/discard happens
// before the selected-task startup tier is announced so a wrong-agent prewarm
// can never be adopted, and disposed/aborted startups discard the intent via
// the startup-scoped cleanup so a registered consumer never leaks a prewarm.

export interface SpeculativeSelectedTerminalIntent {
  agentId: string;
  taskId: string;
}

export type SpeculativeSelectedTerminalOutcome = 'confirmed' | 'discarded';

type SpeculativeResolutionListener = (
  outcome: SpeculativeSelectedTerminalOutcome,
  intent: SpeculativeSelectedTerminalIntent,
) => void;

let currentIntent: SpeculativeSelectedTerminalIntent | null = null;
let resolvedOutcome: SpeculativeSelectedTerminalOutcome | null = null;
const resolutionListeners = new Set<SpeculativeResolutionListener>();

function notifySpeculativeSelectedTerminalResolution(
  outcome: SpeculativeSelectedTerminalOutcome,
  intent: SpeculativeSelectedTerminalIntent,
): void {
  for (const listener of resolutionListeners) {
    listener(outcome, intent);
  }
  emitStartupBreadcrumb(`desktop-startup:speculative-attach-${outcome}`);
}

function hasUnresolvedSpeculativeSelectedTerminalIntent(): boolean {
  return currentIntent !== null && resolvedOutcome === null;
}

function discardUnresolvedSpeculativeSelectedTerminalIntent(): void {
  if (!hasUnresolvedSpeculativeSelectedTerminalIntent() || !currentIntent) {
    return;
  }

  resolvedOutcome = 'discarded';
  notifySpeculativeSelectedTerminalResolution('discarded', currentIntent);
}

export function beginSpeculativeSelectedTerminalAttach(
  intent: SpeculativeSelectedTerminalIntent | null,
): void {
  discardUnresolvedSpeculativeSelectedTerminalIntent();

  currentIntent = intent;
  resolvedOutcome = null;
  if (intent) {
    emitStartupBreadcrumb('desktop-startup:speculative-attach-begin');
  }
}

// Readable only while unresolved: once confirmed or discarded, consumers must
// go through the resolution callback instead of adopting a stale intent.
export function getSpeculativeSelectedTerminalIntent(): SpeculativeSelectedTerminalIntent | null {
  return hasUnresolvedSpeculativeSelectedTerminalIntent() ? currentIntent : null;
}

export function onSpeculativeSelectedTerminalResolved(
  listener: SpeculativeResolutionListener,
): () => void {
  resolutionListeners.add(listener);
  return () => {
    resolutionListeners.delete(listener);
  };
}

export function resolveSpeculativeSelectedTerminalAttach(
  outcome: SpeculativeSelectedTerminalOutcome,
): void {
  if (!currentIntent || resolvedOutcome !== null) {
    return;
  }

  resolvedOutcome = outcome;
  const intent = currentIntent;
  notifySpeculativeSelectedTerminalResolution(outcome, intent);
}

export function resetSpeculativeTerminalAttachForTests(): void {
  currentIntent = null;
  resolvedOutcome = null;
  resolutionListeners.clear();
}
