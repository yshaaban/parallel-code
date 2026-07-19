import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';

import { IPC } from '../../electron/ipc/channels';
import { ChangedFilesList } from '../components/ChangedFilesList';
import { DiffViewerDialog } from '../components/DiffViewerDialog';
import { TerminalView } from '../components/TerminalView';
import type { ArenaCompetitorInspectIssue, ChangedFile } from '../ipc/types.js';
import { fireAndForget } from '../lib/ipc';
import { showNotification } from '../store/notification';
import {
  allBattleFinished,
  arenaStore,
  markBattleCompetitorExited,
  setPhase,
  setTerminalOutput,
} from './store';
import { isExitedBattleCompetitorStatus, isRunningBattleCompetitorStatus } from './types';
import { formatDuration } from './utils';
import { materializeArenaCommandInvocation } from './command-template.js';

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return formatDuration(ms);
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

function getQuietExecutionWarning(
  issues: ArenaCompetitorInspectIssue[] | undefined,
): string | null {
  return issues?.find((issue) => issue.code === 'quiet_noninteractive_output')?.message ?? null;
}

export function BattleScreen() {
  const [elapsed, setElapsed] = createSignal<Record<string, number>>({});
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [diffWorktree, setDiffWorktree] = createSignal('');
  const bufferSerializers = new Map<string, () => string>();

  const timer = setInterval(() => {
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const competitor of arenaStore.battle) {
      if (isRunningBattleCompetitorStatus(competitor.status)) {
        next[competitor.agentId] = now - competitor.startTime;
      } else if (competitor.endTime !== null) {
        next[competitor.agentId] = competitor.endTime - competitor.startTime;
      }
    }
    setElapsed(next);
  }, 100);
  onCleanup(() => clearInterval(timer));

  createEffect(() => {
    if (!allBattleFinished()) return;
    const timeout = setTimeout(() => {
      for (const competitor of arenaStore.battle) {
        const getBuffer = bufferSerializers.get(competitor.id);
        if (getBuffer) setTerminalOutput(competitor.id, getBuffer());
      }
      setPhase('results');
    }, 1500);
    onCleanup(() => clearTimeout(timeout));
  });

  function handleStop(agentId: string) {
    fireAndForget(IPC.KillAgent, { agentId }, () => {
      showNotification('Failed to stop agent');
    });
  }

  function handleFileClick(worktreePath: string, file: ChangedFile) {
    setDiffWorktree(worktreePath);
    setDiffFile(file);
  }

  return (
    <>
      <div class="arena-battle">
        <For each={arenaStore.battle}>
          {(competitor, index) => {
            const { command, args } = materializeArenaCommandInvocation(
              competitor.command,
              arenaStore.prompt,
            );
            const agentId = competitor.agentId;
            const cwd = competitor.worktreePath ?? '/tmp';
            const quietExecutionWarning = getQuietExecutionWarning(competitor.preflightIssues);

            return (
              <>
                <Show when={index() > 0}>
                  <div class="arena-vs-badge">VS</div>
                </Show>
                <div class="arena-battle-panel" data-arena={index()}>
                  <div class="arena-battle-panel-header">
                    <span class="arena-battle-panel-name">{competitor.name}</span>
                    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                      <span
                        class="arena-battle-panel-timer"
                        data-done={
                          isExitedBattleCompetitorStatus(competitor.status) ? 'true' : undefined
                        }
                      >
                        {formatElapsed(elapsed()[agentId] ?? 0)}
                      </span>
                      <Show when={isRunningBattleCompetitorStatus(competitor.status)}>
                        <button
                          class="arena-stop-btn"
                          onClick={() => handleStop(agentId)}
                          title="Stop"
                        >
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="3" y="3" width="10" height="10" rx="1" />
                          </svg>
                        </button>
                      </Show>
                    </div>
                  </div>
                  <Show when={quietExecutionWarning}>
                    <div class="arena-battle-panel-note">{quietExecutionWarning}</div>
                  </Show>
                  <div style={{ flex: '1', overflow: 'hidden' }}>
                    <TerminalView
                      taskId={competitor.id}
                      agentId={agentId}
                      command={command}
                      args={args}
                      cwd={cwd}
                      focusPanelId="ai-terminal"
                      onExit={(info) => markBattleCompetitorExited(agentId, info.exit_code)}
                      onBufferReady={(getBuffer) => bufferSerializers.set(competitor.id, getBuffer)}
                    />
                  </div>
                  <Show when={competitor.worktreePath}>
                    <div class="arena-battle-panel-files">
                      <ChangedFilesList
                        kind="worktree"
                        worktreePath={cwd}
                        isActive={true}
                        onFileClick={(file) => handleFileClick(cwd, file)}
                      />
                    </div>
                  </Show>
                </div>
              </>
            );
          }}
        </For>
      </div>
      <DiffViewerDialog
        file={diffFile()}
        worktreePath={diffWorktree()}
        onClose={() => setDiffFile(null)}
      />
    </>
  );
}
