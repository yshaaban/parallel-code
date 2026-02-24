import { Show, createSignal } from 'solid-js';
import { arenaStore } from './store';
import type { BattleCompetitor } from './types';

interface CommitDialogProps {
  target: BattleCompetitor;
  hasCommitted: boolean;
  onCommitAndMerge: (message: string) => void;
  onDiscardAndMerge: () => void;
  onCancel: () => void;
}

export function CommitDialog(props: CommitDialogProps) {
  const promptSnippet = () => {
    const p = arenaStore.prompt;
    return p.slice(0, 50) + (p.length > 50 ? '...' : '');
  };
  const [commitMsg, setCommitMsg] = createSignal(
    `arena: ${props.target.name} — ${promptSnippet()}`,
  );

  return (
    <div class="arena-commit-overlay" onClick={() => props.onCancel()}>
      <div class="arena-commit-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="arena-commit-title">{props.target.name} has uncommitted changes</div>
        <label class="arena-commit-label">
          Commit message
          <input
            class="arena-commit-input"
            type="text"
            value={commitMsg()}
            onInput={(e) => setCommitMsg(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commitMsg().trim()) props.onCommitAndMerge(commitMsg());
            }}
            autofocus
          />
        </label>
        <div class="arena-commit-actions">
          <button
            class="arena-merge-btn"
            disabled={!commitMsg().trim()}
            onClick={() => props.onCommitAndMerge(commitMsg())}
          >
            Commit &amp; Merge
          </button>
          <Show when={props.hasCommitted}>
            <button class="arena-close-btn" onClick={() => props.onDiscardAndMerge()}>
              Discard uncommitted &amp; Merge
            </button>
          </Show>
          <button class="arena-close-btn" onClick={() => props.onCancel()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
