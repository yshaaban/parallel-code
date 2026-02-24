import { For, Show, createSignal, onMount } from 'solid-js';
import { ChangedFilesList } from '../components/ChangedFilesList';
import { DiffViewerDialog } from '../components/DiffViewerDialog';
import { CommitDialog } from './CommitDialog';
import { createMergeWorkflow } from './merge';
import {
  arenaStore,
  addMatchToHistory,
  resetForNewMatch,
  resetForRematch,
  setPhase,
} from './store';
import { saveArenaHistory } from './persistence';
import { formatDuration } from './utils';
import type { ArenaMatch } from './types';
import type { ChangedFile } from '../ipc/types';

function formatTime(startTime: number, endTime: number | null): string {
  if (!endTime) return 'DNF';
  return formatDuration(endTime - startTime);
}

function rankLabel(index: number): string {
  return ['1st', '2nd', '3rd', '4th'][index] ?? `${index + 1}th`;
}

export function ResultsScreen() {
  const [ratings, setRatings] = createSignal<Record<string, number>>({});
  const [saved, setSaved] = createSignal(false);
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [diffWorktree, setDiffWorktree] = createSignal('');
  const [expandedOutputs, setExpandedOutputs] = createSignal<Record<string, boolean>>({});

  const merge = createMergeWorkflow();
  onMount(() => merge.loadWorktreeStatuses());

  const sorted = () =>
    [...arenaStore.battle].sort((a, b) => {
      const aFailed = a.exitCode !== null && a.exitCode !== 0;
      const bFailed = b.exitCode !== null && b.exitCode !== 0;
      if (aFailed !== bFailed) return aFailed ? 1 : -1;
      const aTime = a.endTime && a.startTime ? a.endTime - a.startTime : Infinity;
      const bTime = b.endTime && b.startTime ? b.endTime - b.startTime : Infinity;
      return aTime - bTime;
    });

  function setRating(competitorId: string, stars: number) {
    if (saved()) return;
    setRatings((prev) => ({ ...prev, [competitorId]: stars }));
  }

  function saveResults() {
    const match: ArenaMatch = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      prompt: arenaStore.prompt,
      competitors: [...arenaStore.battle].map((b) => ({
        name: b.name,
        command: b.command,
        timeMs: b.endTime && b.startTime ? b.endTime - b.startTime : null,
        exitCode: b.exitCode,
        rating: ratings()[b.id] ?? null,
      })),
    };
    addMatchToHistory(match);
    void saveArenaHistory();
    setSaved(true);
  }

  function handleFileClick(worktreePath: string, file: ChangedFile) {
    setDiffWorktree(worktreePath);
    setDiffFile(file);
  }

  return (
    <div class="arena-results">
      <div class="arena-results-grid">
        <For each={sorted()}>
          {(competitor, index) => {
            const originalIdx = arenaStore.battle.findIndex((b) => b.id === competitor.id);
            return (
              <div
                class="arena-result-column"
                data-arena={originalIdx}
                data-rank={index() === 0 ? '1' : undefined}
              >
                <div class="arena-result-column-rank" data-rank={String(index() + 1)}>
                  {rankLabel(index())}
                </div>
                <div class="arena-result-column-name">{competitor.name}</div>
                <div class="arena-result-column-time">
                  {formatTime(competitor.startTime, competitor.endTime)}
                </div>
                <Show when={competitor.exitCode !== null && competitor.exitCode !== 0}>
                  <div class="arena-result-column-exit">exit {competitor.exitCode}</div>
                </Show>

                {/* Terminal output */}
                <Show when={competitor.terminalOutput}>
                  <div class="arena-result-column-output">
                    <button
                      class="arena-output-toggle"
                      onClick={() =>
                        setExpandedOutputs((prev) => ({
                          ...prev,
                          [competitor.id]: !prev[competitor.id],
                        }))
                      }
                    >
                      <span
                        class="arena-output-toggle-icon"
                        data-expanded={expandedOutputs()[competitor.id] ? 'true' : undefined}
                      >
                        &#9654;
                      </span>
                      Terminal output
                    </button>
                    <Show when={expandedOutputs()[competitor.id]}>
                      <pre class="arena-output-pre">{competitor.terminalOutput}</pre>
                    </Show>
                  </div>
                </Show>

                {/* Changed files */}
                <Show when={competitor.worktreePath}>
                  {(worktreePath) => (
                    <div class="arena-result-column-files">
                      <span class="arena-section-label">Changed files</span>
                      <div class="arena-result-column-files-list">
                        <ChangedFilesList
                          worktreePath={worktreePath()}
                          isActive={true}
                          onFileClick={(file) => handleFileClick(worktreePath(), file)}
                        />
                      </div>
                    </div>
                  )}
                </Show>

                {/* Star rating */}
                <div class="arena-result-column-rating">
                  <span class="arena-result-rating-label">Rate how it performed</span>
                  <div class="arena-result-column-stars">
                    <For each={[1, 2, 3, 4, 5]}>
                      {(star) => (
                        <button
                          class="arena-star-btn"
                          data-filled={(ratings()[competitor.id] ?? 0) >= star ? 'true' : undefined}
                          disabled={saved()}
                          onClick={() => setRating(competitor.id, star)}
                          title={`${star} star${star > 1 ? 's' : ''}`}
                        >
                          <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 1.3l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.5l4-.6L8 1.3z" />
                          </svg>
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                {/* Merge into main */}
                <Show when={competitor.branchName && merge.hasChanges(competitor.id)}>
                  <div class="arena-result-column-merge">
                    <Show
                      when={merge.mergedId() !== competitor.id}
                      fallback={<span class="arena-merge-badge">Merged</span>}
                    >
                      <button
                        class="arena-merge-btn"
                        disabled={merge.merging() || merge.mergedId() !== null}
                        onClick={() => merge.handleMergeClick(competitor)}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="4" r="2" />
                          <circle cx="8" cy="13" r="2" />
                          <path d="M4 6v1c0 2 4 4 4 4M12 6v1c0 2-4 4-4 4" />
                        </svg>
                        {merge.merging() ? 'Merging...' : 'Merge into main'}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={merge.mergeError()}>
        <div class="arena-merge-error">{merge.mergeError()}</div>
      </Show>

      <div class="arena-config-actions">
        <Show when={!saved()}>
          <button class="arena-fight-btn" onClick={saveResults}>
            Save Results
          </button>
        </Show>
        <button class="arena-close-btn" onClick={() => void resetForRematch()}>
          Rematch
        </button>
        <button class="arena-close-btn" onClick={() => void resetForNewMatch()}>
          New Match
        </button>
        <button class="arena-close-btn" onClick={() => setPhase('history')}>
          History
        </button>
      </div>

      <DiffViewerDialog
        file={diffFile()}
        worktreePath={diffWorktree()}
        onClose={() => setDiffFile(null)}
      />

      <Show when={merge.commitTarget()}>
        {(target) => (
          <CommitDialog
            target={target()}
            hasCommitted={!!merge.worktreeStatus()[target().id]?.hasCommitted}
            onCommitAndMerge={(msg) => void merge.commitAndMerge(msg)}
            onDiscardAndMerge={() => void merge.discardAndMerge()}
            onCancel={merge.dismissCommitDialog}
          />
        )}
      </Show>
    </div>
  );
}
