import { For, Show } from 'solid-js';
import { arenaStore, setPhase } from './store';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimeMs(ms: number | null): string {
  if (ms === null) return 'DNF';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(1)}s`;
}

function renderStars(rating: number | null): string {
  if (rating === null) return '';
  return '\u2605'.repeat(rating) + '\u2606'.repeat(5 - rating);
}

export function HistoryScreen() {
  return (
    <div class="arena-history">
      <div class="arena-config-actions">
        <button class="arena-close-btn" onClick={() => setPhase('config')}>
          Back
        </button>
      </div>

      <Show
        when={arenaStore.history.length > 0}
        fallback={<div class="arena-history-empty">No matches yet. Go fight!</div>}
      >
        <For each={arenaStore.history}>
          {(match) => (
            <div class="arena-history-row">
              <div class="arena-history-row-top">
                <span>{formatDate(match.date)}</span>
              </div>
              <div class="arena-history-row-prompt">{match.prompt}</div>
              <div class="arena-history-row-competitors">
                {match.competitors
                  .map((c) => {
                    const stars = renderStars(c.rating);
                    const time = formatTimeMs(c.timeMs);
                    return `${c.name} ${time}${stars ? ` ${stars}` : ''}`;
                  })
                  .join('  \u00B7  ')}
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
