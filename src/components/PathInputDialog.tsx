import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from 'solid-js';
import { Dialog } from './Dialog';
import { DialogHeader } from './DialogHeader';
import { invoke } from '../lib/ipc';
import { deriveRepoNameFromSshUrl, isGitSshUrl } from '../lib/git-ssh-url';
import { createAnimationFrameTask } from '../lib/animation-frame-task';
import { IPC } from '../../electron/ipc/channels';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import { typography } from '../lib/typography';

interface PathInputDialogProps {
  open: boolean;
  directory: boolean;
  allowSshClone?: boolean;
  suppressRecentProjects?: boolean;
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

interface RecentProjectPick {
  label: string;
  path: string;
  subtitle: string;
}

interface DialogBasePaths {
  homePath: string;
  projectBasePath: string;
}

const PATH_SEGMENT_SEPARATOR_PATTERN = /[\\/]+/u;
const LEADING_PATH_SEPARATOR_PATTERN = /^[\\/]+/u;
const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]+$/u;

function isWindowsDriveAbsolutePath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(pathValue);
}

function getWindowsUncRoot(pathValue: string): string | null {
  const match = pathValue.match(/^(\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/u);
  if (!match) {
    return null;
  }

  const [, prefix, server, share] = match;
  let separator = '/';
  if (prefix === '\\\\') {
    separator = '\\';
  }

  return `${prefix}${server}${separator}${share}`;
}

function isAbsoluteInputPath(pathValue: string): boolean {
  return (
    pathValue.startsWith('/') ||
    pathValue.startsWith('\\') ||
    isWindowsDriveAbsolutePath(pathValue) ||
    getWindowsUncRoot(pathValue) !== null
  );
}

function getPathSeparator(pathValue: string): string {
  return pathValue.includes('\\') ? '\\' : '/';
}

function isRootPath(pathValue: string): boolean {
  if (pathValue === '/' || pathValue === '\\') {
    return true;
  }

  if (/^[A-Za-z]:[\\/]$/u.test(pathValue)) {
    return true;
  }

  return getWindowsUncRoot(pathValue) === pathValue;
}

function getRootPath(pathValue: string): string {
  if (isWindowsDriveAbsolutePath(pathValue)) {
    return `${pathValue.slice(0, 2)}${getPathSeparator(pathValue)}`;
  }

  const uncRoot = getWindowsUncRoot(pathValue);
  if (uncRoot) {
    return uncRoot;
  }

  if (pathValue.startsWith('\\')) {
    return '\\';
  }

  return '/';
}

function normalizeDirectoryPath(pathValue: string): string {
  if (!pathValue || pathValue === '/') return '/';
  if (pathValue === '\\') return '\\';

  if (isWindowsDriveAbsolutePath(pathValue)) {
    const separator = getPathSeparator(pathValue);
    const drivePrefix = pathValue.slice(0, 2);
    const withoutTrailingSeparators = pathValue.replace(TRAILING_PATH_SEPARATOR_PATTERN, '');
    if (withoutTrailingSeparators === drivePrefix) {
      return `${drivePrefix}${separator}`;
    }

    return withoutTrailingSeparators;
  }

  const uncRoot = getWindowsUncRoot(pathValue);
  if (uncRoot) {
    const withoutTrailingSeparators = pathValue.replace(TRAILING_PATH_SEPARATOR_PATTERN, '');
    if (withoutTrailingSeparators.length < uncRoot.length) {
      return uncRoot;
    }

    return withoutTrailingSeparators;
  }

  return pathValue.replace(TRAILING_PATH_SEPARATOR_PATTERN, '') || getRootPath(pathValue);
}

function ensureTrailingSlash(pathValue: string): string {
  const normalized = normalizeDirectoryPath(pathValue);
  if (isRootPath(normalized)) {
    return normalized;
  }

  return `${normalized}${getPathSeparator(normalized)}`;
}

function joinPath(basePath: string, childName: string): string {
  const normalized = normalizeDirectoryPath(basePath);
  const separator = getPathSeparator(normalized);
  if (normalized === '/') return `/${childName}`;
  if (normalized.endsWith(separator)) return `${normalized}${childName}`;
  return `${normalized}${separator}${childName}`;
}

function getParentPath(pathValue: string): string {
  const normalized = normalizeDirectoryPath(pathValue);
  if (isRootPath(normalized)) return normalized;

  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSlash <= 0) {
    return getRootPath(normalized);
  }

  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/u.test(parent)) {
    return `${parent}${getPathSeparator(normalized)}`;
  }

  const uncRoot = getWindowsUncRoot(normalized);
  if (uncRoot && parent.length < uncRoot.length) {
    return uncRoot;
  }

  return parent;
}

function collapseHomePath(pathValue: string, homePath: string): string {
  const normalizedHome = normalizeDirectoryPath(homePath);
  if (!normalizedHome) return pathValue;
  if (pathValue === normalizedHome) return '~';
  if (normalizedHome === '/') return pathValue;

  const separator = getPathSeparator(normalizedHome);
  if (pathValue.startsWith(`${normalizedHome}${separator}`)) {
    return `~${pathValue.slice(normalizedHome.length)}`;
  }
  return pathValue;
}

function hasTraversalSegment(pathValue: string): boolean {
  return pathValue.split(PATH_SEGMENT_SEPARATOR_PATTERN).some((segment) => segment === '..');
}

function getPathLabel(pathValue: string): string {
  const normalized = normalizeDirectoryPath(pathValue);
  if (normalized === '/') return '/';
  const parts = normalized
    .split(PATH_SEGMENT_SEPARATOR_PATTERN)
    .filter((segment) => segment.length > 0);
  return parts[parts.length - 1] ?? normalized;
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

async function loadDialogBasePaths(): Promise<DialogBasePaths> {
  const [homeResult, projectBaseResult] = await Promise.allSettled([
    invoke(IPC.GetHomePath),
    invoke(IPC.GetProjectBasePath),
  ]);

  const homePath =
    homeResult.status === 'fulfilled' ? normalizeDirectoryPath(homeResult.value) : '/';
  const projectBasePath =
    projectBaseResult.status === 'fulfilled'
      ? normalizeDirectoryPath(projectBaseResult.value)
      : homePath;

  return { homePath, projectBasePath };
}

export function PathInputDialog(props: PathInputDialogProps): JSX.Element {
  const titleId = createUniqueId();
  const [value, setValue] = createSignal('');
  const [homePath, setHomePath] = createSignal('/');
  const [projectBasePath, setProjectBasePath] = createSignal('/');
  const [entries, setEntries] = createSignal<string[]>([]);
  const [quickPicks, setQuickPicks] = createSignal<QuickPick[]>([]);
  const [recentProjects, setRecentProjects] = createSignal<RecentProjectPick[]>([]);
  const [loadingDirs, setLoadingDirs] = createSignal(false);
  const [loadingQuickPicks, setLoadingQuickPicks] = createSignal(false);
  const [loadingRecentProjects, setLoadingRecentProjects] = createSignal(false);
  const [inputError, setInputError] = createSignal('');
  const [listingError, setListingError] = createSignal('');
  const [highlightIdx, setHighlightIdx] = createSignal(-1);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  let latestListingRequest = 0;
  let latestQuickPickRequest = 0;
  let latestRecentProjectsRequest = 0;
  const inputFocusFrame = createAnimationFrameTask();
  const highlightScrollFrame = createAnimationFrameTask();

  function invalidatePendingLoads(): void {
    latestListingRequest += 1;
    latestQuickPickRequest += 1;
    latestRecentProjectsRequest += 1;
  }

  function isSshUrlMode(): boolean {
    return Boolean(props.allowSshClone) && isGitSshUrl(value());
  }

  function cloneDestinationHint(): string {
    const projectBase = projectBasePath();
    const name = deriveRepoNameFromSshUrl(value());
    if (!name) return '';
    return `${projectBase === '/' ? '' : projectBase}/${name}`;
  }

  function defaultBrowsePath(): string {
    return normalizeDirectoryPath(projectBasePath() || homePath() || '/');
  }

  function resolveInputPath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const home = homePath();
    if (!home) return trimmed;
    if (trimmed === '~' || trimmed === '~/' || trimmed === '~\\') return home;
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      const suffix = trimmed.slice(1).replace(/[\\/]/gu, getPathSeparator(home));
      if (home === '/') {
        return suffix;
      }

      return `${home}${suffix}`;
    }
    return trimmed;
  }

  function getPathChildPrefix(parentPath: string, pathValue: string): string {
    if (parentPath.endsWith('/') || parentPath.endsWith('\\')) {
      return pathValue.slice(parentPath.length);
    }

    return pathValue.slice(parentPath.length + 1);
  }

  function deriveBrowseTarget(inputPath: string): { browsePath: string | null; prefix: string } {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      return { browsePath: defaultBrowsePath(), prefix: '' };
    }

    const resolved = resolveInputPath(trimmed);
    if (!isAbsoluteInputPath(resolved)) {
      return { browsePath: null, prefix: '' };
    }

    if (resolved === '/') return { browsePath: '/', prefix: '' };

    if (trimmed.endsWith('/') || trimmed.endsWith('\\') || trimmed === '~') {
      return { browsePath: normalizeDirectoryPath(resolved), prefix: '' };
    }

    const parent = getParentPath(resolved);
    const prefix = getPathChildPrefix(parent, resolved);
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
    if (!currentPath || !isAbsoluteInputPath(currentPath)) return [];

    if (currentPath === '/') {
      return [{ name: '/', path: '/' }];
    }

    const rootPath = getRootPath(currentPath);
    const segments: BreadcrumbSegment[] = [{ name: rootPath, path: rootPath }];
    const relativePath = currentPath
      .slice(rootPath.length)
      .replace(LEADING_PATH_SEPARATOR_PATTERN, '');
    const parts = relativePath
      .split(PATH_SEGMENT_SEPARATOR_PATTERN)
      .filter((segment) => segment.length > 0);
    let nextPath = rootPath;
    for (const part of parts) {
      nextPath = joinPath(nextPath, part);
      segments.push({ name: part, path: nextPath });
    }
    return segments;
  }

  function validateInput(inputPath: string): string | null {
    const trimmed = inputPath.trim();
    if (!trimmed) return 'Path cannot be empty';

    const resolved = resolveInputPath(trimmed);
    if (!isAbsoluteInputPath(resolved)) {
      return 'Path must be absolute (start with /, ~, a Windows drive, or a UNC root)';
    }
    if (hasTraversalSegment(resolved)) {
      return 'Path must not contain ".."';
    }
    return null;
  }

  async function loadQuickPickPaths(home: string, projectBase: string): Promise<void> {
    const requestId = ++latestQuickPickRequest;
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
    appendCandidate('Workspace', projectBase);
    appendCandidate('Projects', joinPath(home, 'projects'));
    appendCandidate('Code', joinPath(home, 'code'));
    appendCandidate('Development', joinPath(home, 'dev'));
    appendCandidate('Work', joinPath(home, 'work'));
    appendCandidate('Source', joinPath(home, 'src'));

    const existing = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const exists = await invoke(IPC.CheckPathExists, { path: candidate.path });
          return exists ? candidate : null;
        } catch {
          return null;
        }
      }),
    );

    if (requestId !== latestQuickPickRequest) {
      return;
    }

    setQuickPicks(existing.filter((candidate): candidate is QuickPick => candidate !== null));
    setLoadingQuickPicks(false);
  }

  async function loadRecentProjects(home: string): Promise<void> {
    const requestId = ++latestRecentProjectsRequest;
    setLoadingRecentProjects(true);

    try {
      const normalizedHome = normalizeDirectoryPath(home);
      const paths = await invoke(IPC.GetRecentProjects);
      const seen = new Set<string>();
      const items: RecentProjectPick[] = [];

      for (const pathValue of paths ?? []) {
        if (typeof pathValue !== 'string') continue;

        const normalizedPath = normalizeDirectoryPath(pathValue);
        if (!normalizedPath || normalizedPath === normalizedHome || seen.has(normalizedPath)) {
          continue;
        }

        seen.add(normalizedPath);
        items.push({
          label: getPathLabel(normalizedPath),
          path: normalizedPath,
          subtitle: normalizedPath,
        });
      }

      if (requestId === latestRecentProjectsRequest) {
        setRecentProjects(items);
      }
    } catch {
      if (requestId === latestRecentProjectsRequest) {
        setRecentProjects([]);
      }
    } finally {
      if (requestId === latestRecentProjectsRequest) {
        setLoadingRecentProjects(false);
      }
    }
  }

  async function loadDirectoryEntries(dirPath: string): Promise<void> {
    const requestId = ++latestListingRequest;
    setLoadingDirs(true);
    setListingError('');

    try {
      const directories = await invoke(IPC.ListDirectory, { path: dirPath });
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
    inputFocusFrame.schedule(() => {
      if (!inputRef?.isConnected) {
        return;
      }

      inputRef.focus();
    });
  }

  function acceptEntry(entryName: string): void {
    const currentBrowsePath = browsePath();
    if (!currentBrowsePath) return;
    navigateTo(joinPath(currentBrowsePath, entryName));
  }

  function scrollHighlightIntoView(): void {
    highlightScrollFrame.schedule(() => {
      if (!listRef?.isConnected) {
        return;
      }

      const highlighted = listRef?.querySelector('[data-highlighted="true"]');
      highlighted?.scrollIntoView({ block: 'nearest' });
    });
  }

  async function handleSubmit(): Promise<void> {
    const trimmed = value().trim();

    if (props.allowSshClone && isGitSshUrl(trimmed)) {
      props.onSubmit(trimmed);
      return;
    }

    const validationError = validateInput(trimmed);
    if (validationError) {
      setInputError(validationError);
      return;
    }

    const resolved = normalizeDirectoryPath(resolveInputPath(trimmed));

    if (props.directory) {
      try {
        const exists = await invoke(IPC.CheckPathExists, { path: resolved });
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
    if (!props.open) {
      invalidatePendingLoads();
      setLoadingDirs(false);
      setLoadingQuickPicks(false);
      setLoadingRecentProjects(false);
      inputFocusFrame.cancel();
      highlightScrollFrame.cancel();
      return;
    }

    let cancelled = false;
    setInputError('');
    setListingError('');
    setEntries([]);
    setQuickPicks([]);
    setRecentProjects([]);
    setHighlightIdx(-1);

    void (async () => {
      const basePaths = await loadDialogBasePaths();
      if (cancelled) return;

      setHomePath(basePaths.homePath);
      setProjectBasePath(basePaths.projectBasePath);
      setValue(ensureTrailingSlash(basePaths.projectBasePath));
      void loadQuickPickPaths(basePaths.homePath, basePaths.projectBasePath);
      if (!props.suppressRecentProjects) {
        void loadRecentProjects(basePaths.homePath);
      }

      inputFocusFrame.schedule(() => {
        if (!inputRef?.isConnected) {
          return;
        }

        inputRef.focus();
      });
    })();

    onCleanup(() => {
      cancelled = true;
      invalidatePendingLoads();
      inputFocusFrame.cancel();
      highlightScrollFrame.cancel();
    });
  });

  onCleanup(() => {
    invalidatePendingLoads();
    inputFocusFrame.cancel();
    highlightScrollFrame.cancel();
  });

  createEffect(() => {
    if (!props.open) return;

    const target = deriveBrowseTarget(value());
    if (!target.browsePath) {
      setEntries([]);
      setLoadingDirs(false);
      if (value().trim()) {
        setListingError('Type an absolute path, Windows path, or use ~ for your home directory.');
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

    untrack(() => {
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
  });

  return (
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      width="640px"
      labelledBy={titleId}
      panelStyle={{ padding: '20px', gap: '14px' }}
    >
      <DialogHeader
        title={props.directory ? 'Select Project Directory' : 'Select File Path'}
        titleId={titleId}
        description={
          <>
            Browse folders, use breadcrumbs, or type a path directly. Press Tab to accept the
            current folder suggestion.
            <Show when={props.allowSshClone}>
              {' '}
              You can also paste a git SSH URL (e.g. git@github.com:user/repo.git) to clone it.
            </Show>
          </>
        }
        descriptionTone="muted"
      />

      <div style={{ display: 'flex', gap: '8px', 'align-items': 'stretch' }}>
        <button
          type="button"
          class="btn-secondary"
          onClick={goUp}
          title="Go to parent directory"
          style={{
            padding: '0 10px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'flex-shrink': '0',
            ...typography.title,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.22 9.78a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8 6.06 4.28 9.78a.749.749 0 0 1-1.06 0Z" />
          </svg>
        </button>

        <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <input
            ref={inputRef}
            class="input-field"
            type="text"
            value={value()}
            onInput={(event) => handleInputChange(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              props.directory
                ? '/home/user/my-project, C:\\Users\\me\\my-project, or ~/my-project'
                : '/home/user/file.txt or C:\\Users\\me\\file.txt'
            }
            spellcheck={false}
            autocomplete="off"
            style={{
              padding: '8px 11px',
              background: theme.bgInput,
              border: `1px solid ${inputError() ? theme.error : theme.border}`,
              'border-radius': '8px',
              color: theme.fg,
              width: '100%',
              'box-sizing': 'border-box',
              ...typography.monoUi,
            }}
          />
          <Show when={inputError()}>
            <div style={{ color: theme.error, ...typography.meta }}>{inputError()}</div>
          </Show>
          <Show when={isSshUrlMode() && cloneDestinationHint()}>
            <div style={{ color: theme.fgMuted, ...typography.meta }}>
              Clone into:{' '}
              <span style={{ color: theme.fg, ...typography.monoMeta }}>
                {cloneDestinationHint()}
              </span>
            </div>
          </Show>
        </div>
      </div>

      <Show when={breadcrumbs().length > 0 && !isSshUrlMode()}>
        <div
          style={{
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '2px',
            'align-items': 'center',
            ...typography.monoMeta,
          }}
        >
          <For each={breadcrumbs()}>
            {(segment, index) => (
              <>
                <Show when={index() > 0}>
                  <span style={{ color: theme.fgSubtle, padding: '0 1px' }}>
                    {getPathSeparator(segment.path)}
                  </span>
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
                    ...typography.monoMeta,
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

      <Show when={!isSshUrlMode()}>
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
                color: theme.fgMuted,
                ...typography.label,
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
                    display: 'inline-flex',
                    'align-items': 'center',
                    gap: '5px',
                    ...typography.meta,
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

        <Show when={!props.suppressRecentProjects}>
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
                  color: theme.fgMuted,
                  ...typography.label,
                }}
              >
                Recent Projects
              </label>
              <Show when={loadingRecentProjects()}>
                <span class="inline-spinner" aria-hidden="true" />
              </Show>
            </div>

            <Show
              when={recentProjects().length > 0}
              fallback={
                <div
                  style={{
                    padding: '12px 14px',
                    color: theme.fgSubtle,
                    'text-align': 'center',
                    border: `1px solid ${theme.border}`,
                    'border-radius': '8px',
                    background: theme.bgInput,
                    ...typography.meta,
                  }}
                >
                  {loadingRecentProjects()
                    ? 'Loading recent Claude/Codex projects...'
                    : 'No recent Claude/Codex projects found.'}
                </div>
              }
            >
              <div
                style={{
                  display: 'flex',
                  'flex-direction': 'column',
                  gap: '6px',
                  'max-height': '220px',
                  'overflow-y': 'auto',
                }}
              >
                <For each={recentProjects()}>
                  {(item) => (
                    <button
                      type="button"
                      onClick={() => navigateTo(item.path)}
                      title={item.subtitle}
                      style={{
                        width: '100%',
                        padding: '9px 12px',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': '8px',
                        color: theme.fg,
                        cursor: 'pointer',
                        display: 'flex',
                        'align-items': 'flex-start',
                        gap: '10px',
                        'text-align': 'left',
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
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill={theme.accent}
                        style={{ 'flex-shrink': '0', 'margin-top': '2px' }}
                      >
                        <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                      </svg>
                      <div
                        style={{
                          display: 'flex',
                          'flex-direction': 'column',
                          gap: '2px',
                          overflow: 'hidden',
                          'min-width': '0',
                        }}
                      >
                        <span
                          style={{
                            color: theme.fg,
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                            ...typography.uiStrong,
                          }}
                        >
                          {item.label}
                        </span>
                        <span
                          style={{
                            color: theme.fgMuted,
                            overflow: 'hidden',
                            'text-overflow': 'ellipsis',
                            'white-space': 'nowrap',
                            ...typography.monoMeta,
                          }}
                        >
                          {item.subtitle}
                        </span>
                      </div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
            <label
              style={{
                color: theme.fgMuted,
                'flex-shrink': '0',
                ...typography.label,
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
                    'text-align': 'center',
                    ...typography.meta,
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
                        'text-align': 'left',
                        ...typography.monoUi,
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
      </Show>

      <Show when={!isSshUrlMode()}>
        <div
          style={{
            color: theme.fgSubtle,
            display: 'flex',
            gap: '12px',
            'flex-wrap': 'wrap',
            ...typography.meta,
          }}
        >
          <span>Tab autocomplete</span>
          <span>Arrow keys move through folders</span>
          <span>Enter opens the highlighted folder or confirms the current path</span>
        </div>
      </Show>

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
          class="btn-secondary"
          onClick={() => props.onCancel()}
          style={{
            padding: '9px 18px',
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
        <button
          type="button"
          class="btn-primary"
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
            ...typography.uiStrong,
          }}
        >
          {isSshUrlMode() ? 'Clone & Select' : 'Select Path'}
        </button>
      </div>
    </Dialog>
  );
}
