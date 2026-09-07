import { createMemo, Show, type JSX } from 'solid-js';

import {
  getTaskReviewPresentation,
  type TaskConvergenceSnapshot,
} from '../../domain/task-convergence';
import { theme } from '../../lib/theme';

interface ReviewPanelConvergenceBannerProps {
  snapshot: TaskConvergenceSnapshot;
  stateColor: string;
}

export function ReviewPanelConvergenceBanner(
  props: ReviewPanelConvergenceBannerProps,
): JSX.Element {
  const presentation = createMemo(() => getTaskReviewPresentation(props.snapshot));
  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        gap: '12px',
        padding: '8px',
        'border-bottom': `1px solid ${theme.border}`,
        background: theme.bgInput,
        'font-size': '11px',
        'font-family': "'JetBrains Mono', monospace",
      }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'min-width': '0',
          overflow: 'hidden',
        }}
      >
        <span
          role="status"
          aria-label={`${presentation().label}: ${presentation().summary}`}
          title={presentation().summary}
          style={{
            color: props.stateColor,
            padding: '2px 6px',
            'border-radius': '999px',
            border: `1px solid color-mix(in srgb, ${props.stateColor} 30%, transparent)`,
            background: `color-mix(in srgb, ${props.stateColor} 10%, transparent)`,
            'flex-shrink': '0',
          }}
        >
          {presentation().label}
        </span>
        <span
          title={presentation().summary}
          style={{
            color: theme.fgMuted,
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {presentation().summary}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          color: theme.fgSubtle,
          'flex-shrink': '0',
        }}
      >
        <span>{props.snapshot.commitCount} commits</span>
        <span>{props.snapshot.changedFileCount} files</span>
        <Show when={props.snapshot.mainAheadCount > 0}>
          <span title={`Base branch: ${props.snapshot.baseBranch ?? 'unavailable'}`}>
            Base +{props.snapshot.mainAheadCount}
          </span>
        </Show>
        <Show when={props.snapshot.overlapWarnings[0]}>
          {(warning) => <span>{warning().sharedCount} shared</span>}
        </Show>
      </div>
    </div>
  );
}
