import { Show, type JSX } from 'solid-js';

import type { TaskReviewSignalsSnapshot } from '../../domain/task-review-signals';
import { theme } from '../../lib/theme';

interface ReviewPanelSignalsBannerProps {
  snapshot: TaskReviewSignalsSnapshot;
  stale?: boolean;
}

const CI_COLORS = {
  error: '#e8a838',
  failure: '#e55',
  pending: '#e8a838',
  success: '#4ec94e',
  unconfigured: '#8a9099',
} as const;

const COVERAGE_COLORS = {
  available: '#4ec94e',
  error: '#e8a838',
  missing: '#8a9099',
} as const;

function createSignalChipStyle(color: string): Record<string, string> {
  return {
    color,
    padding: '2px 6px',
    'border-radius': '999px',
    border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    'flex-shrink': '0',
  };
}

function formatCoverageDetail(snapshot: TaskReviewSignalsSnapshot): string {
  const coverage = snapshot.coverage;
  if (coverage.state !== 'available') {
    return coverage.description ?? '';
  }

  const metrics = [
    coverage.linesPct !== undefined ? `lines ${coverage.linesPct.toFixed(1)}%` : null,
    coverage.branchesPct !== undefined ? `branches ${coverage.branchesPct.toFixed(1)}%` : null,
  ].filter((entry): entry is string => entry !== null);

  return metrics.join(' · ');
}

function formatCiDetail(snapshot: TaskReviewSignalsSnapshot): string {
  const ci = snapshot.ci;
  if (ci.state === 'unconfigured' || ci.state === 'error') {
    return ci.description ?? '';
  }

  const counts = [
    ci.totalCount !== undefined ? `${ci.totalCount} checks` : null,
    ci.failureCount !== undefined && ci.failureCount > 0 ? `${ci.failureCount} failing` : null,
    ci.pendingCount !== undefined && ci.pendingCount > 0 ? `${ci.pendingCount} pending` : null,
  ].filter((entry): entry is string => entry !== null);

  return counts.join(' · ');
}

export function ReviewPanelSignalsBanner(props: ReviewPanelSignalsBannerProps): JSX.Element {
  const ciDetail = () => formatCiDetail(props.snapshot);
  const coverageDetail = () => formatCoverageDetail(props.snapshot);

  return (
    <div
      style={{
        display: 'flex',
        'align-items': 'center',
        gap: '10px',
        padding: '6px 8px',
        'border-bottom': `1px solid ${theme.border}`,
        background: theme.bgInput,
        'font-size': '11px',
        'font-family': "'JetBrains Mono', monospace",
        overflow: 'hidden',
      }}
    >
      <Show when={props.stale}>
        <span style={createSignalChipStyle('#e8a838')}>Signals updating</span>
      </Show>
      <span style={createSignalChipStyle(CI_COLORS[props.snapshot.ci.state])}>
        {props.snapshot.ci.label}
      </span>
      <Show when={ciDetail()}>
        {(detail) => (
          <span
            style={{
              color: theme.fgMuted,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {detail()}
          </span>
        )}
      </Show>
      <span style={createSignalChipStyle(COVERAGE_COLORS[props.snapshot.coverage.state])}>
        {props.snapshot.coverage.label}
      </span>
      <Show when={coverageDetail()}>
        {(detail) => (
          <span
            style={{
              color: theme.fgMuted,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {detail()}
          </span>
        )}
      </Show>
    </div>
  );
}
