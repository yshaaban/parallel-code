import { For, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import type { CachedWorkspaceShape } from '../app/workspace-shape-cache';

const GHOST_COLUMN_MIN_COUNT = 1;
const GHOST_COLUMN_MAX_COUNT = 12;
const GHOST_COLUMN_DEFAULT_COUNT = 2;

export function getWorkspaceSkeletonColumnCount(shape: CachedWorkspaceShape | null): number {
  if (!shape) {
    return GHOST_COLUMN_DEFAULT_COUNT;
  }

  return Math.min(GHOST_COLUMN_MAX_COUNT, Math.max(GHOST_COLUMN_MIN_COUNT, shape.taskNames.length));
}

function GhostBlock(props: { height: string; width: string }): JSX.Element {
  return (
    <div
      style={{
        height: props.height,
        width: props.width,
        'border-radius': '6px',
        background: `color-mix(in srgb, ${theme.fgSubtle} 12%, transparent)`,
      }}
    />
  );
}

function GhostTaskColumn(): JSX.Element {
  return (
    <div
      style={{
        height: '100%',
        padding: 'var(--space-xs) var(--space-2xs) var(--space-sm)',
        width: '520px',
        'flex-shrink': '0',
      }}
    >
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          height: '100%',
          background: theme.taskContainerBg,
          'border-radius': '12px',
          border: `1px solid ${theme.border}`,
          overflow: 'hidden',
          padding: '10px',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <GhostBlock height="10px" width="10px" />
          <GhostBlock height="12px" width="40%" />
        </div>
        <GhostBlock height="10px" width="65%" />
        <div
          style={{
            flex: '1',
            'border-radius': '12px',
            border: `1px solid ${theme.border}`,
            background: `color-mix(in srgb, ${theme.islandBg} 88%, rgb(12, 15, 20))`,
          }}
        />
        <GhostBlock height="34px" width="100%" />
      </div>
    </div>
  );
}

// Neutral last-known-shape placeholder shown while startup presentation is
// pending and the store is still empty. Calm by design: no shimmer, no copy —
// it must never read as first-run onboarding for a returning user.
export function WorkspaceStartupSkeleton(props: {
  shape: CachedWorkspaceShape | null;
}): JSX.Element {
  return (
    <div
      data-startup-skeleton="true"
      aria-hidden="true"
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <For each={Array.from({ length: getWorkspaceSkeletonColumnCount(props.shape) })}>
        {() => <GhostTaskColumn />}
      </For>
    </div>
  );
}

export function GhostSidebarRows(props: { shape: CachedWorkspaceShape | null }): JSX.Element {
  return (
    <div
      data-startup-skeleton-sidebar="true"
      aria-hidden="true"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: 'var(--space-2xs)',
      }}
    >
      <For each={Array.from({ length: getWorkspaceSkeletonColumnCount(props.shape) })}>
        {() => (
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '6px',
              padding: '7px 10px',
              'border-radius': '8px',
            }}
          >
            <GhostBlock height="8px" width="8px" />
            <GhostBlock height="10px" width="70%" />
          </div>
        )}
      </For>
    </div>
  );
}
