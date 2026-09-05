import {
  For,
  Show,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { DialogHeader } from './DialogHeader';
import { Dialog } from './Dialog';
import { addDiscoveredProject, pickAndAddProject } from '../app/project-workflows';
import {
  getUnaddedDiscoveredProjects,
  refreshDiscoveredProjects,
} from '../app/discovered-projects';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';
import type { DiscoveredProject, DiscoveredProjectSource } from '../ipc/types';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

const SOURCE_META: Record<DiscoveredProjectSource, { label: string; color: string }> = {
  claude: { label: 'Claude', color: '#f4a36a' },
  codex: { label: 'Codex', color: '#78dcb4' },
  git: { label: 'git', color: '#9aa4b2' },
};

function formatRelativeTime(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

function getEmptyStateMessage(refreshing: boolean, query: string): string {
  if (refreshing) {
    return 'Scanning Claude, Codex, and your repos...';
  }

  if (query.trim()) {
    return 'No discovered projects match your filter.';
  }

  return 'No new projects discovered - use Browse to add one.';
}

function projectMatchesQuery(project: DiscoveredProject, normalizedQuery: string): boolean {
  return (
    project.name.toLowerCase().includes(normalizedQuery) ||
    project.path.toLowerCase().includes(normalizedQuery)
  );
}

function FolderGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5C0 12.716.784 13.5 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-6.5A1.75 1.75 0 0 0 14.25 3.5H7.7a.25.25 0 0 1-.2-.1l-.86-1.15a1.75 1.75 0 0 0-1.4-.75H1.75Z" />
    </svg>
  );
}

export function AddProjectDialog(props: AddProjectDialogProps): JSX.Element {
  const titleId = createUniqueId();
  const [refreshing, setRefreshing] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [addingPath, setAddingPath] = createSignal<string | null>(null);
  const [error, setError] = createSignal('');
  const nowMs = Date.now();
  let closed = false;

  onCleanup(() => {
    closed = true;
  });

  onMount(() => {
    // The startup prefetch usually has these warm already; refresh on open to catch new activity.
    setRefreshing(true);
    void refreshDiscoveredProjects({ force: true }).finally(() => {
      if (closed) {
        return;
      }

      setRefreshing(false);
    });
  });

  const proposals = createMemo<DiscoveredProject[]>(() => {
    const normalizedQuery = query().trim().toLowerCase();
    const unadded = getUnaddedDiscoveredProjects();
    if (!normalizedQuery) {
      return unadded;
    }

    return unadded.filter((project) => projectMatchesQuery(project, normalizedQuery));
  });

  async function handleAdd(discovered: DiscoveredProject): Promise<void> {
    if (addingPath()) {
      return;
    }

    setAddingPath(discovered.path);
    setError('');
    try {
      await addDiscoveredProject(discovered.path);
      closeDialog();
    } catch (err) {
      if (!closed) {
        setError(String(err));
      }
    } finally {
      if (!closed) {
        setAddingPath(null);
      }
    }
  }

  async function handleBrowse(): Promise<void> {
    closeDialog();
    await pickAndAddProject();
  }

  function closeDialog(): void {
    if (closed) {
      return;
    }

    closed = true;
    props.onClose();
  }

  return (
    <Dialog
      open={props.open}
      onClose={closeDialog}
      width="480px"
      labelledBy={titleId}
      panelStyle={{ gap: '12px', padding: '20px' }}
    >
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
        <DialogHeader
          description="Projects we found from your Claude and Codex activity and git repos."
          descriptionTone="muted"
          title="Add project"
          titleId={titleId}
        />

        <Show when={getUnaddedDiscoveredProjects().length > 6}>
          <input
            class="input-field"
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter discovered projects"
            aria-label="Filter discovered projects"
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '8px 11px',
              color: theme.fg,
              ...typography.ui,
            }}
          />
        </Show>

        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            'max-height': '46vh',
            overflow: 'auto',
            'margin-right': '-4px',
            'padding-right': '4px',
          }}
        >
          <For each={proposals()}>
            {(discovered) => {
              const meta = SOURCE_META[discovered.source];
              const isAdding = () => addingPath() === discovered.path;
              return (
                <button
                  type="button"
                  disabled={!!addingPath()}
                  onClick={() => {
                    void handleAdd(discovered);
                  }}
                  title={discovered.path}
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '10px',
                    width: '100%',
                    padding: '8px 10px',
                    background: theme.bgInput,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    color: theme.fg,
                    cursor: addingPath() ? 'default' : 'pointer',
                    'text-align': 'left',
                    opacity: addingPath() && !isAdding() ? '0.5' : '1',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ color: theme.fgMuted, display: 'inline-flex', 'flex-shrink': '0' }}
                  >
                    <FolderGlyph />
                  </span>
                  <span style={{ 'min-width': '0', flex: '1' }}>
                    <span style={{ display: 'block', ...typography.uiStrong }}>
                      {discovered.name}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        color: theme.fgSubtle,
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                        ...typography.monoMeta,
                      }}
                    >
                      {discovered.path}
                    </span>
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      'flex-direction': 'column',
                      'align-items': 'flex-end',
                      gap: '3px',
                      'flex-shrink': '0',
                    }}
                  >
                    <span
                      style={{
                        padding: '1px 7px',
                        'border-radius': '999px',
                        background: `color-mix(in srgb, ${meta.color} 18%, transparent)`,
                        color: meta.color,
                        ...typography.label,
                      }}
                    >
                      {meta.label}
                    </span>
                    <span style={{ color: theme.fgSubtle, ...typography.label }}>
                      {formatRelativeTime(discovered.updatedAtMs, nowMs)}
                    </span>
                  </span>
                </button>
              );
            }}
          </For>

          <Show when={proposals().length === 0}>
            <div
              style={{
                padding: '14px 12px',
                'text-align': 'center',
                color: theme.fgMuted,
                background: theme.bgInput,
                border: `1px dashed ${theme.border}`,
                'border-radius': '8px',
                ...typography.meta,
              }}
            >
              {getEmptyStateMessage(refreshing(), query())}
            </div>
          </Show>
        </div>

        <Show when={error()}>
          <div
            style={{
              color: theme.error,
              background: `color-mix(in srgb, ${theme.error} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${theme.error} 20%, transparent)`,
              'border-radius': '8px',
              padding: '6px 10px',
              ...typography.meta,
            }}
          >
            {error()}
          </div>
        </Show>

        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
            gap: '8px',
            'padding-top': '2px',
          }}
        >
          <button
            type="button"
            class="btn-secondary"
            onClick={() => {
              void handleBrowse();
            }}
            style={{
              padding: '8px 14px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              cursor: 'pointer',
              ...typography.ui,
            }}
          >
            Browse or clone...
          </button>
          <button
            type="button"
            class="btn-secondary"
            onClick={closeDialog}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fgMuted,
              cursor: 'pointer',
              ...typography.ui,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </Dialog>
  );
}
