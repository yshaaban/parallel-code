import { createEffect, createMemo, createSignal, onMount, Show, type JSX } from 'solid-js';
import {
  clearBusyTaskCommandTakeoverRequest,
  markBusyTaskCommandTakeoverRequest,
  syncBusyTaskCommandTakeoverRequests,
} from '../domain/task-command-takeover-busy-state';
import { getStoredDisplayName, setStoredDisplayName } from '../lib/display-name';
import { AgentDetail } from './AgentDetail';
import { AgentList } from './AgentList';
import { initAuth } from './auth';
import { getRemoteClientId } from './client-id';
import { RemoteSessionNameDialog } from './RemoteSessionNameDialog';
import { RemoteTaskTakeoverDialog } from './RemoteTaskTakeoverDialog';
import {
  clearIncomingRemoteTakeoverRequest,
  getIncomingRemoteTakeoverRequests,
  getRemoteControllingTaskIds,
} from './remote-collaboration';
import { typography } from '../lib/typography';
import { createRemotePresenceRuntime, getDefaultRemoteSessionName } from './remote-presence';
import { respondToRemoteTaskCommandTakeover } from './remote-task-command';
import { agents, authRequired, connect, status } from './ws';

interface InitialRemoteSessionState {
  sessionName: string;
  shouldPrompt: boolean;
}

function getInitialRemoteSessionState(): InitialRemoteSessionState {
  const storedDisplayName = getStoredDisplayName();
  if (storedDisplayName) {
    return {
      sessionName: storedDisplayName,
      shouldPrompt: false,
    };
  }

  return {
    sessionName: getDefaultRemoteSessionName(getRemoteClientId()),
    shouldPrompt: true,
  };
}

function getRemoteTransitionAnimation(transition: 'none' | 'slide-right' | 'slide-left'): string {
  if (transition === 'slide-right') {
    return 'slideInRight 0.25s ease-out both';
  }
  if (transition === 'slide-left') {
    return 'slideInLeft 0.25s ease-out both';
  }
  return 'none';
}

export function App(): JSX.Element {
  const [view, setView] = createSignal<'list' | 'detail'>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');
  const [sessionName, setSessionName] = createSignal('');
  const [sessionNameDialogOpen, setSessionNameDialogOpen] = createSignal(false);
  const [busyTakeoverRequestIds, setBusyTakeoverRequestIds] = createSignal<Set<string>>(new Set());
  const [transition, setTransition] = createSignal<'none' | 'slide-right' | 'slide-left'>('none');

  const detailAgent = createMemo(
    () => agents().find((agent) => agent.agentId === detailAgentId()) ?? null,
  );
  const activeTaskId = createMemo(() => {
    if (view() !== 'detail') {
      return null;
    }

    return detailAgent()?.taskId ?? null;
  });
  const focusedSurface = createMemo(() =>
    view() === 'detail' ? 'remote-terminal' : 'remote-list',
  );
  const incomingTakeoverRequests = createMemo(() => getIncomingRemoteTakeoverRequests());

  createRemotePresenceRuntime({
    getActiveTaskId: activeTaskId,
    getConnectionStatus: status,
    getControllingTaskIds: getRemoteControllingTaskIds,
    getDisplayName: sessionName,
    getFocusedSurface: focusedSurface,
  });

  function clearBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      clearBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  function markBusyTakeoverRequest(requestId: string): void {
    setBusyTakeoverRequestIds((currentRequestIds) =>
      markBusyTaskCommandTakeoverRequest(currentRequestIds, requestId),
    );
  }

  createEffect(() => {
    const currentRequestIds = new Set(
      incomingTakeoverRequests().map((request) => request.requestId),
    );
    setBusyTakeoverRequestIds((currentBusyRequestIds) =>
      syncBusyTaskCommandTakeoverRequests(currentBusyRequestIds, currentRequestIds),
    );
  });

  function selectAgent(id: string, name: string): void {
    runNavigationTransition('slide-right', () => {
      setDetailAgentId(id);
      setDetailTaskName(name);
      setView('detail');
    });
  }

  function goBack(): void {
    runNavigationTransition('slide-left', () => {
      setView('list');
    });
  }

  function openSessionNameDialog(): void {
    setSessionNameDialogOpen(true);
  }

  function saveSessionName(nextValue: string): void {
    setSessionName(setStoredDisplayName(nextValue));
    setSessionNameDialogOpen(false);
  }

  function runNavigationTransition(
    fallbackDirection: 'slide-right' | 'slide-left',
    update: () => void,
  ): void {
    setTransition(fallbackDirection);
    update();
  }

  async function handleTakeoverResponse(requestId: string, approved: boolean): Promise<void> {
    markBusyTakeoverRequest(requestId);
    const handled = await respondToRemoteTaskCommandTakeover(requestId, approved).catch(
      () => false,
    );
    if (!handled) {
      clearBusyTakeoverRequest(requestId);
    }
  }

  onMount(() => {
    initAuth();
    const initialSessionState = getInitialRemoteSessionState();
    setSessionName(initialSessionState.sessionName);
    setSessionNameDialogOpen(initialSessionState.shouldPrompt);
    connect();
  });

  return (
    <Show
      when={!authRequired()}
      fallback={
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            height: '100%',
            color: 'var(--text-muted)',
            ...typography.body,
            padding: 'var(--space-lg)',
            'text-align': 'center',
            animation: 'fadeIn 0.5s ease-out',
          }}
        >
          <div style={{ display: 'grid', gap: 'var(--space-sm)', 'max-width': '320px' }}>
            <div
              style={{
                width: '48px',
                height: '48px',
                margin: '0 auto',
                'border-radius': '12px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'font-size': '24px',
              }}
            >
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"
                  stroke="var(--text-muted)"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </div>
            <p style={{ color: 'var(--text-secondary)', ...typography.uiStrong }}>
              Not authenticated
            </p>
            <p style={{ ...typography.ui, color: 'var(--text-muted)' }}>
              Open the shared browser link again or rescan the QR code from Parallel Code.
            </p>
          </div>
        </div>
      }
    >
      <div
        class="remote-shell"
        style={{
          width: '100%',
          height: '100%',
        }}
      >
        <div class="remote-shell__glow remote-shell__glow--left" />
        <div class="remote-shell__glow remote-shell__glow--right" />
        <div class="remote-shell__grid" />
        <div
          class="remote-shell__view"
          onAnimationEnd={() => setTransition('none')}
          style={{
            animation: getRemoteTransitionAnimation(transition()),
          }}
        >
          <Show
            when={view() === 'detail'}
            fallback={
              <AgentList
                onEditSessionName={openSessionNameDialog}
                onSelect={selectAgent}
                sessionName={sessionName()}
              />
            }
          >
            <AgentDetail agentId={detailAgentId()} taskName={detailTaskName()} onBack={goBack} />
          </Show>
        </div>
      </div>

      <RemoteSessionNameDialog
        initialValue={sessionName()}
        onSave={saveSessionName}
        open={sessionNameDialogOpen()}
      />
      <RemoteTaskTakeoverDialog
        busyRequestIds={busyTakeoverRequestIds()}
        onApprove={(requestId) => {
          void handleTakeoverResponse(requestId, true);
        }}
        onDeny={(requestId) => {
          void handleTakeoverResponse(requestId, false);
        }}
        onExpire={(requestId) => {
          clearIncomingRemoteTakeoverRequest(requestId);
          clearBusyTakeoverRequest(requestId);
        }}
        requests={incomingTakeoverRequests()}
      />
    </Show>
  );
}
