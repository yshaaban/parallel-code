import { createSignal, createEffect, For, Show } from 'solid-js';
import { Dialog } from './Dialog';
import { store } from '../store/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parentDir(p: string): string | null {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

export function FileBrowserDialog(props: { open: boolean; onClose: () => void }) {
  const [currentPath, setCurrentPath] = createSignal('');
  const [entries, setEntries] = createSignal<DirEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal<string | null>(null);
  const [showHidden, setShowHidden] = createSignal(false);
  const [filter, setFilter] = createSignal('');

  async function loadDir(dirPath: string) {
    setLoading(true);
    setError(null);
    setFilter('');
    try {
      const result = await invoke<DirEntry[]>(IPC.ListDirectory, { path: dirPath });
      setEntries(result);
      setCurrentPath(dirPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    if (props.open && store.fileBrowserRoot) {
      loadDir(store.fileBrowserRoot);
    }
  });

  function navigate(entry: DirEntry) {
    if (entry.isDirectory) {
      loadDir(currentPath() + '/' + entry.name);
    }
  }

  function goUp() {
    const parent = parentDir(currentPath());
    if (parent) loadDir(parent);
  }

  async function copyPath(entryName?: string) {
    const fullPath = entryName ? currentPath() + '/' + entryName : currentPath();
    await navigator.clipboard.writeText(fullPath);
    setCopied(fullPath);
    setTimeout(() => setCopied(null), 1500);
  }

  function abbreviatePath(p: string): string {
    const prefixes = ['/home/', '/Users/'];
    for (const prefix of prefixes) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx !== -1) return '~' + rest.slice(slashIdx);
        return '~';
      }
    }
    return p;
  }

  const filteredEntries = () => {
    let list = entries();
    if (!showHidden()) {
      list = list.filter((e) => !e.name.startsWith('.'));
    }
    const q = filter().toLowerCase();
    if (q) {
      list = list.filter((e) => e.name.toLowerCase().includes(q));
    }
    return list;
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} width="560px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
        {/* Header */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'space-between',
          }}
        >
          <span style={{ 'font-size': sf(16), 'font-weight': '600', color: theme.fg }}>
            File Browser
          </span>
          <button
            onClick={() => props.onClose()}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.fgSubtle,
              cursor: 'pointer',
              'font-size': sf(18),
              'line-height': '1',
            }}
          >
            &times;
          </button>
        </div>

        {/* Breadcrumb / current path */}
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            background: theme.bgInput,
            'border-radius': '6px',
            padding: '6px 10px',
            'min-height': '32px',
          }}
        >
          <button
            onClick={goUp}
            disabled={!parentDir(currentPath())}
            title="Go up"
            style={{
              background: 'transparent',
              border: 'none',
              color: parentDir(currentPath()) ? theme.fg : theme.fgSubtle,
              cursor: parentDir(currentPath()) ? 'pointer' : 'default',
              padding: '0 4px',
              'font-size': sf(14),
              'flex-shrink': '0',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ display: 'block' }}
            >
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
            </svg>
          </button>
          <span
            style={{
              flex: '1',
              'font-size': sf(12),
              color: theme.fgMuted,
              'font-family': "'JetBrains Mono', monospace",
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
            title={currentPath()}
          >
            {abbreviatePath(currentPath())}
          </span>
          <button
            onClick={() => copyPath()}
            title="Copy current directory path"
            style={{
              background: 'transparent',
              border: 'none',
              color: copied() === currentPath() ? theme.success : theme.fgSubtle,
              cursor: 'pointer',
              padding: '0 4px',
              'font-size': sf(12),
              'flex-shrink': '0',
            }}
          >
            {copied() === currentPath() ? 'Copied!' : 'Copy'}
          </button>
        </div>

        {/* Filter + show hidden toggle */}
        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <input
            type="text"
            placeholder="Filter..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            style={{
              flex: '1',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '6px',
              padding: '5px 10px',
              color: theme.fg,
              'font-size': sf(12),
              outline: 'none',
              'font-family': "'JetBrains Mono', monospace",
            }}
          />
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
              'font-size': sf(11),
              color: theme.fgMuted,
              cursor: 'pointer',
              'flex-shrink': '0',
              'user-select': 'none',
            }}
          >
            <input
              type="checkbox"
              checked={showHidden()}
              onChange={(e) => setShowHidden(e.currentTarget.checked)}
            />
            Hidden
          </label>
        </div>

        {/* Project quick-nav */}
        <Show when={store.projects.length > 1}>
          <div style={{ display: 'flex', gap: '4px', 'flex-wrap': 'wrap' }}>
            <For each={store.projects}>
              {(project) => (
                <button
                  onClick={() => loadDir(project.path)}
                  style={{
                    background:
                      currentPath() === project.path || currentPath().startsWith(project.path + '/')
                        ? `color-mix(in srgb, ${project.color} 20%, ${theme.bgInput})`
                        : theme.bgInput,
                    border:
                      currentPath() === project.path || currentPath().startsWith(project.path + '/')
                        ? `1px solid ${project.color}`
                        : `1px solid ${theme.border}`,
                    'border-radius': '4px',
                    padding: '2px 8px',
                    color: theme.fgMuted,
                    cursor: 'pointer',
                    'font-size': sf(10),
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: '6px',
                      height: '6px',
                      'border-radius': '50%',
                      background: project.color,
                      'margin-right': '4px',
                    }}
                  />
                  {project.name}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* File list */}
        <Show when={error()}>
          <div style={{ color: theme.error, 'font-size': sf(12), padding: '8px' }}>{error()}</div>
        </Show>

        <div
          style={{
            'max-height': '400px',
            overflow: 'auto',
            'border-radius': '6px',
            border: `1px solid ${theme.border}`,
          }}
        >
          <Show
            when={!loading()}
            fallback={
              <div
                style={{
                  padding: '24px',
                  'text-align': 'center',
                  color: theme.fgSubtle,
                  'font-size': sf(12),
                }}
              >
                Loading...
              </div>
            }
          >
            <Show
              when={filteredEntries().length > 0}
              fallback={
                <div
                  style={{
                    padding: '24px',
                    'text-align': 'center',
                    color: theme.fgSubtle,
                    'font-size': sf(12),
                  }}
                >
                  {filter() ? 'No matches' : 'Empty directory'}
                </div>
              }
            >
              <For each={filteredEntries()}>
                {(entry) => {
                  const fullPath = () => currentPath() + '/' + entry.name;
                  return (
                    <div
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        gap: '8px',
                        padding: '5px 10px',
                        cursor: entry.isDirectory ? 'pointer' : 'default',
                        'border-bottom': `1px solid ${theme.border}`,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background =
                          `color-mix(in srgb, ${theme.fg} 5%, transparent)`;
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                      }}
                      onClick={() => entry.isDirectory && navigate(entry)}
                      onDblClick={() => !entry.isDirectory && copyPath(entry.name)}
                    >
                      {/* Icon */}
                      <span
                        style={{
                          'flex-shrink': '0',
                          color: entry.isDirectory ? theme.accent : theme.fgSubtle,
                        }}
                      >
                        {entry.isDirectory ? (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.22.78 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5 1H1.75Z" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
                          </svg>
                        )}
                      </span>

                      {/* Name */}
                      <span
                        style={{
                          flex: '1',
                          'font-size': sf(12),
                          'font-family': "'JetBrains Mono', monospace",
                          color: entry.isDirectory ? theme.fg : theme.fgMuted,
                          'font-weight': entry.isDirectory ? '500' : '400',
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          'white-space': 'nowrap',
                        }}
                      >
                        {entry.name}
                      </span>

                      {/* Size */}
                      <Show when={!entry.isDirectory && entry.size > 0}>
                        <span
                          style={{
                            'font-size': sf(10),
                            color: theme.fgSubtle,
                            'flex-shrink': '0',
                          }}
                        >
                          {formatSize(entry.size)}
                        </span>
                      </Show>

                      {/* Copy button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          copyPath(entry.name);
                        }}
                        title={`Copy path: ${fullPath()}`}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: copied() === fullPath() ? theme.success : theme.fgSubtle,
                          cursor: 'pointer',
                          padding: '2px 4px',
                          'font-size': sf(10),
                          'flex-shrink': '0',
                          'border-radius': '3px',
                        }}
                      >
                        {copied() === fullPath() ? (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
                            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </Show>
        </div>

        {/* Footer hint */}
        <div
          style={{
            'font-size': sf(10),
            color: theme.fgSubtle,
            'text-align': 'center',
          }}
        >
          Click folder to enter — Click copy icon or double-click file to copy path
        </div>
      </div>
    </Dialog>
  );
}
