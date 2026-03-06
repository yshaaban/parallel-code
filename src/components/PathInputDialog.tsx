import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from '../store/store';
import { theme } from '../lib/theme';

interface PathInputDialogProps {
  open: boolean;
  directory: boolean;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}

interface BreadcrumbSegment {
  name: string;
  path: string;
}

interface QuickPick {
  label: string;
  path: string;
}

function normalizeDirectoryPath(pathValue: string): string {
  if (!pathValue || pathValue === '/') return '/';
  return pathValue.replace(/\/+$/, '') || '/';
}

function ensureTrailingSlash(pathValue: string): string {
  const normalized = normalizeDirectoryPath(pathValue);
  return normalized === '/' ? '/' : `${normalized}/`;
}

function joinPath(basePath: string, childName: string): string {
  if (basePath === '/') return `/${childName}`;
  return `${normalizeDirectoryPath(basePath)}/${childName}`;
}

function getParentPath(pathValue: string): string {
  const normalized = normalizeDirectoryPath(pathValue);
  if (normalized === '/') return '/';
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : normalized.slice(0, lastSlash);
}

function collapseHomePath(pathValue: string, homePath: string): string {
  if (!homePath) return pathValue;
  if (pathValue === homePath) return '~';
  if (pathValue.startsWith(`${homePath}/`)) {
    return `~${pathValue.slice(homePath.length)}`;
  }
  return pathValue;
}

function hasTraversalSegment(pathValue: string): boolean {
  return pathValue.split('/').some((segment) => segment === '..');
}

function prioritizeMatches(entries: string[], prefix: string): string[] {
  if (!prefix) return entries;

  const lowerPrefix = prefix.toLowerCase();
  const startsWithPrefix = entries.filter((entry) => entry.toLowerCase().startsWith(lowerPrefix));
  const containsPrefix = entries.filter(
    (entry) =>
      !entry.toLowerCase().startsWith(lowerPrefix) && entry.toLowerCase().includes(lowerPrefix),
  );

  return startsWithPrefix.length > 0 ? [...startsWithPrefix, ...containsPrefix] : containsPrefix;
}

export function PathInputDialog(props: PathInputDialogProps) {
  const [value, setValue] = createSignal('');
  const [homePath, setHomePath] = createSignal('/');
  const [entries, setEntries] = createSignal<string[]>([]);
  const [quickPicks, setQuickPicks] = createSignal<QuickPick[]>([]);
  const [loadingDirs, setLoadingDirs] = createSignal(false);
  const [loadingQuickPicks, setLoadingQuickPicks] = createSignal(false);
  const [inputError, setInputError] = createSignal('');
  const [listingError, setListingError] = createSignal('');
  const [highlightIdx, setHighlightIdx] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let latestListingRequest = 0;

  function resolveInputPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const home = homePath();
    if (!home) return trimmed;
    if (trimmed === '~' || trimmed === '~/') return home;
    if (trimmed.startsWith('~/')) {
      return home === '/' ? trimmed.slice(1) : `${home}${trimmed.slice(1)}`;
    }
    return trimmed;
  }

  function deriveBrowseTarget(inputPath: string): { browsePath: string | null; prefix: string } {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      return { browsePath: normalizeDirectoryPath(homePath() || '/'), prefix: '' };
    }

    const resolved = resolveInputPath(trimmed);
    if (!resolved.startsWith('/')) {
      return { browsePath: null, prefix: '' };
    }

    if (resolved === '/') return { browsePath: '/', prefix: '' };

    if (trimmed.endsWith('/') || trimmed === '~' || trimmed === '~/') {
      return { browsePath: normalizeDirectoryPath(resolved), prefix: '' };
    }

    const parent = getParentPath(resolved);
    const prefix = resolved.slice(parent === '/' ? 1 : parent.length + 1);
    return { browsePath: parent, prefix };
  }

  function filteredEntries(): string[] {
    return prioritizeMatches(entries(), deriveBrowseTarget(value()).prefix);
  }

  function browsePath(): string {
    return deriveBrowseTarget(value()).browsePath ?? '';
  }

  function breadcrumbs(): BreadcrumbSegment[] {
    const currentPath = browsePath();
    if (!currentPath || !currentPath.startsWith('/')) return [];

    if (currentPath === '/') {
      return [{ name: '/', path: '/' }];
    }

    const parts = currentPath.split('/').filter((segment) => segment.length > 0);
    const segments: BreadcrumbSegment[] = [{ name: '/', path: '/' }];
    let nextPath = '';
    for (const part of parts) {
      nextPath += `/${part}`;
      segments.push({ name: part, path: nextPath });
    }
    return segments;
  }

  function validateInput(inputPath: string): string | null {
    const trimmed = inputPath.trim();
    if (!trimmed) return 'Path cannot be empty';

    const resolved = resolveInputPath(trimmed);
    if (!resolved.startsWith('/')) {
      return 'Path must be absolute (start with / or ~)';
    }
    if (hasTraversalSegment(resolved)) {
      return 'Path must not contain ".."';
    }
    return null;
  }

  async function loadQuickPickPaths(home: string): Promise<void> {
    setLoadingQuickPicks(true);

    const candidates: QuickPick[] = [];
    const seen = new Set<string>();

    const appendCandidate = (label: string, pathValue: string) => {
      const normalized = normalizeDirectoryPath(pathValue);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({ label, path: normalized });
    };

    for (const project of store.projects) {
      appendCandidate(project.name, project.path);
    }

    appendCandidate('Home', home);
    appendCandidate('Projects', joinPath(home, 'projects'));
    appendCandidate('Code', joinPath(home, 'code'));
    appendCandidate('Development', joinPath(home, 'dev'));
    appendCandidate('Workspace', joinPath(home, 'workspace'));
    appendCandidate('Work', joinPath(home, 'work'));
    appendCandidate('Source', joinPath(home, 'src'));

    const existing = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const exists = await invoke<boolean>(IPC.CheckPathExists, { path: candidate.path });
          return exists ? candidate : null;
        } catch {
          return null;
        }
      }),
    );

    setQuickPicks(existing.filter((candidate): candidate is QuickPick => candidate !== null));
    setLoadingQuickPicks(false);
  }

  async function loadDirectoryEntries(dirPath: string): Promise<void> {
    const requestId = ++latestListingRequest;
    setLoadingDirs(true);
    setListingError('');

    try {
      const directories = await invoke<string[]>(IPC.ListDirectory, { path: dirPath });
      if (requestId !== latestListingRequest) return;
      setEntries(directories ?? []);
    } catch (error) {
      if (requestId !== latestListingRequest) return;
      setEntries([]);
      setListingError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === latestListingRequest) {
        setLoadingDirs(false);
      }
    }
  }

  function navigateTo(pathValue: string): void {
    setValue(ensureTrailingSlash(pathValue));
    setInputError('');
    setListingError('');
    setHighlightIdx(-1);
    requestAnimationFrame(() => inputRef?.focus());
  }

  function acceptEntry(entryName: string): void {
    const currentBrowsePath = browsePath();
    if (!currentBrowsePath) return;
    navigateTo(joinPath(currentBrowsePath, entryName));
  }

  function scrollHighlightIntoView(): void {
    requestAnimationFrame(() => {
      const highlighted = listRef?.querySelector('[data-highlighted="true"]');
      highlighted?.scrollIntoView({ block: 'nearest' });
    });
  }

  async function handleSubmit(): Promise<void> {
    const trimmed = value().trim();
    const validationError = validateInput(trimmed);
    if (validationError) {
      setInputError(validationError);
      return;
    }

    const resolved = normalizeDirectoryPath(resolveInputPath(trimmed));

    if (props.directory) {
      try {
        const exists = await invoke<boolean>(IPC.CheckPathExists, { path: resolved });
        if (!exists) {
          setInputError(`Directory does not exist: ${resolved}`);
          return;
        }
      } catch {
        setInputError(`Unable to verify directory: ${resolved}`);
        return;
      }
    }

    props.onSubmit(resolved);
  }

  function handleInputChange(nextValue: string): void {
    setValue(nextValue);
    setInputError('');
    setListingError('');
    setHighlightIdx(-1);
  }

  function goUp(): void {
    const currentBrowsePath = browsePath();
    navigateTo(getParentPath(currentBrowsePath || homePath() || '/'));
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const suggestions = filteredEntries();

    if (event.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setHighlightIdx((current) => {
        const next = current < 0 ? 0 : Math.min(current + 1, suggestions.length - 1);
        return next;
      });
      scrollHighlightIntoView();
      return;
    }

    if (event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setHighlightIdx((current) => {
        if (current < 0) return suggestions.length - 1;
        return Math.max(current - 1, 0);
      });
      scrollHighlightIntoView();
      return;
    }

    if (event.key === 'Tab') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const nextIndex = highlightIdx() >= 0 ? highlightIdx() : 0;
      acceptEntry(suggestions[nextIndex]);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const nextIndex = highlightIdx();
      if (nextIndex >= 0 && nextIndex < suggestions.length) {
        acceptEntry(suggestions[nextIndex]);
        return;
      }
      void handleSubmit();
    }
  }

  createEffect(() => {
    if (!props.open) return;

    let cancelled = false;
    setInputError('');
    setListingError('');
    setEntries([]);
    setQuickPicks([]);
    setHighlightIdx(-1);

    void (async () => {
      let nextHome = '/';
      try {
        nextHome = normalizeDirectoryPath(await invoke<string>(IPC.GetHomePath));
      } catch {
        nextHome = '/';
      }
      if (cancelled) return;

      setHomePath(nextHome);
      setValue(ensureTrailingSlash(nextHome));
      void loadQuickPickPaths(nextHome);

      requestAnimationFrame(() => inputRef?.focus());
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!props.open) return;

    const target = deriveBrowseTarget(value());
    if (!target.browsePath) {
      setEntries([]);
      setLoadingDirs(false);
      if (value().trim()) {
        setListingError('Type an absolute path or use ~ for your home directory.');
      } else {
        setListingError('');
      }
      return;
    }

    void loadDirectoryEntries(target.browsePath);
  });

  createEffect(() => {
    if (!props.open) return;

    const suggestions = filteredEntries();
    const prefix = deriveBrowseTarget(value()).prefix;
    if (suggestions.length === 0) {
      if (highlightIdx() !== -1) setHighlightIdx(-1);
      return;
    }

    if (!prefix) {
      if (highlightIdx() >= suggestions.length) setHighlightIdx(-1);
      return;
    }

    if (highlightIdx() < 0 || highlightIdx() >= suggestions.length) {
      setHighlightIdx(0);
    }
  });

  return (
    <Dialog open={props.open} onClose={props.onCancel} width="640px">
      <h2
        style={{
          margin: '0',
          'font-size': '16px',
          color: theme.fg,
          'font-weight': '600',
        }}
      >
        {props.directory ? 'Select Project Directory' : 'Select File Path'}
      </h2>

      <div style={{ 'font-size': '13px', color: theme.fgMuted, 'line-height': '1.5' }}>
        Browse folders, use breadcrumbs, or type a path directly. Press Tab to accept the current
        folder suggestion.
      </div>

      <div style={{ display: 'flex', gap: '8px', 'align-items': 'stretch' }}>
        <button
          type="button"
          onClick={goUp}
          title="Go to parent directory"
          style={{
            padding: '0 10px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '16px',
            display: 'flex',
            'align-items': 'center',
            'flex-shrink': '0',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.22 9.78a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8 6.06 4.28 9.78a.749.749 0 0 1-1.06 0Z" />
          </svg>
        </button>

        <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <input
            ref={inputRef}
            type="text"
            value={value()}
            onInput={(event) => handleInputChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              props.directory ? '/home/user/my-project or ~/my-project' : '/home/user/file.txt'
            }
            spellcheck={false}
            autocomplete="off"
            style={{
              padding: '10px 14px',
              background: theme.bgInput,
              border: `1px solid ${inputError() ? theme.error : theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              'font-size': '14px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
              width: '100%',
              'box-sizing': 'border-box',
            }}
          />
          <Show when={inputError()}>
            <div style={{ 'font-size': '12px', color: theme.error }}>{inputError()}</div>
          </Show>
        </div>
      </div>

      <Show when={breadcrumbs().length > 0}>
        <div
          style={{
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '2px',
            'align-items': 'center',
            'font-size': '12px',
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          <For each={breadcrumbs()}>
            {(segment, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ color: theme.fgSubtle, padding: '0 1px' }}>/</span>
                </Show>
                <button
                  type="button"
                  onClick={() => navigateTo(segment.path)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: theme.accent,
                    cursor: 'pointer',
                    padding: '2px 4px',
                    'border-radius': '4px',
                    'font-size': '12px',
                    'font-family': 'inherit',
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = `color-mix(in srgb, ${theme.accent} 15%, transparent)`;
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = 'none';
                  }}
                >
                  {index() === 0 ? collapseHomePath(segment.path, homePath()) : segment.name}
                </button>
              </>
            )}
          </For>
        </div>
      </Show>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <div
          style={{
            display: 'flex',
            'justify-content': 'space-between',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <label
            style={{
              'font-size': '11px',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
            }}
          >
            Quick Picks
          </label>
          <Show when={loadingQuickPicks()}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
        </div>
        <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
          <For each={quickPicks()}>
            {(item) => (
              <button
                type="button"
                onClick={() => navigateTo(item.path)}
                title={item.path}
                style={{
                  padding: '5px 10px',
                  background: theme.bgInput,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  color: theme.fg,
                  cursor: 'pointer',
                  'font-size': '11px',
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '5px',
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.borderColor = theme.accent;
                  event.currentTarget.style.background = `color-mix(in srgb, ${theme.accent} 10%, transparent)`;
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.borderColor = theme.border;
                  event.currentTarget.style.background = theme.bgInput;
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill={theme.fgMuted}
                  style={{ 'flex-shrink': '0' }}
                >
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
                {item.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <label
            style={{
              'font-size': '11px',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
              'flex-shrink': '0',
            }}
          >
            Folders in {collapseHomePath(browsePath() || '/', homePath())}
          </label>
          <Show when={loadingDirs()}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
        </div>

        <div
          ref={listRef}
          style={{
            'max-height': '240px',
            'overflow-y': 'auto',
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            background: theme.bgInput,
          }}
        >
          <Show
            when={filteredEntries().length > 0}
            fallback={
              <div
                style={{
                  padding: '12px 14px',
                  color: listingError() ? theme.error : theme.fgSubtle,
                  'font-size': '12px',
                  'text-align': 'center',
                }}
              >
                {loadingDirs()
                  ? 'Loading directories...'
                  : listingError() || 'No subdirectories match the current path.'}
              </div>
            }
          >
            <For each={filteredEntries()}>
              {(entry, index) => {
                const isHighlighted = () => index() === highlightIdx();
                const isHidden = () => entry.startsWith('.');
                return (
                  <button
                    type="button"
                    data-highlighted={isHighlighted() ? 'true' : 'false'}
                    onClick={() => acceptEntry(entry)}
                    onMouseEnter={() => setHighlightIdx(index())}
                    style={{
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      width: '100%',
                      padding: '8px 12px',
                      background: isHighlighted()
                        ? `color-mix(in srgb, ${theme.accent} 20%, transparent)`
                        : 'transparent',
                      border: 'none',
                      'border-bottom': `1px solid color-mix(in srgb, ${theme.border} 50%, transparent)`,
                      color: isHidden() ? theme.fgMuted : theme.fg,
                      cursor: 'pointer',
                      'font-size': '13px',
                      'font-family': "'JetBrains Mono', monospace",
                      'text-align': 'left',
                    }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill={isHidden() ? theme.fgMuted : theme.accent}
                      style={{ 'flex-shrink': '0' }}
                    >
                      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                    </svg>
                    <span
                      style={{
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                      }}
                    >
                      {entry}
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      <div
        style={{
          'font-size': '11px',
          color: theme.fgSubtle,
          display: 'flex',
          gap: '12px',
          'flex-wrap': 'wrap',
        }}
      >
        <span>Tab autocomplete</span>
        <span>Arrow keys move through folders</span>
        <span>Enter opens the highlighted folder or confirms the current path</span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          type="button"
          onClick={() => props.onCancel()}
          style={{
            padding: '9px 18px',
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '13px',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void handleSubmit();
          }}
          style={{
            padding: '9px 18px',
            background: theme.accent,
            border: `1px solid ${theme.accent}`,
            'border-radius': '8px',
            color: theme.accentText,
            cursor: 'pointer',
            'font-size': '13px',
            'font-weight': '600',
          }}
        >
          Select Path
        </button>
      </div>
    </Dialog>
  );
}
