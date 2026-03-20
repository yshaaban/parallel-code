import { For, Show, createEffect, createSignal, onCleanup, type JSX } from 'solid-js';

import type { ReviewSession } from '../app/review-session';
import {
  fetchTaskFileDiff,
  type TaskReviewDiffFileTarget,
  type TaskReviewDiffRequest,
  type TaskReviewDiffSource,
} from '../app/review-diffs';
import type { AskAboutCodeSession } from '../app/task-ai-workflows';
import { createDialogScroll } from '../lib/dialog-scroll';
import { getDiffSelection } from '../lib/diff-selection';
import { sf } from '../lib/fontScale';
import { detectLang, highlightLines } from '../lib/shiki-highlighter';
import { openFileInEditor } from '../lib/shell';
import { getStatusColor } from '../lib/status-colors';
import { theme } from '../lib/theme';
import type { DiffHunk, DiffLine, ParsedFileDiff } from '../lib/unified-diff-parser';
import type { ChangedFile } from '../ipc/types';
import { AskCodeCard } from './AskCodeCard';
import { InlineInput } from './InlineInput';
import { ReviewCommentCard } from './ReviewCommentCard';

interface ScrollingDiffViewProps {
  file?: ChangedFile;
  files: ParsedFileDiff[];
  request: TaskReviewDiffRequest;
  requestSource?: TaskReviewDiffSource;
  reviewSession: ReviewSession;
  scrollToPath: string | null;
  searchQuery?: string;
  startAskSession: (
    requestId: string,
    prompt: string,
    cwd: string,
    onMessage: (message: import('../domain/ask-about-code').AskAboutCodeMessage) => void,
  ) => Promise<AskAboutCodeSession>;
}

const STATUS_LABELS: Record<ParsedFileDiff['status'], string> = {
  '?': 'Untracked',
  A: 'Added',
  D: 'Deleted',
  M: 'Modified',
};

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'rgba(47, 209, 152, 0.10)',
  context: 'transparent',
  remove: 'rgba(255, 95, 115, 0.10)',
};

const INDICATOR: Record<DiffLine['type'], string> = {
  add: '+',
  context: ' ',
  remove: '-',
};

function getIndicatorColor(type: DiffLine['type']): string {
  switch (type) {
    case 'add':
      return theme.success;
    case 'remove':
      return theme.error;
    default:
      return theme.fgSubtle;
  }
}

function getPendingSelectionKey(filePath: string, lineNumber: number): string {
  return `${filePath}:${lineNumber}`;
}

function highlightSearchMatches(text: string, query: string | undefined): JSX.Element {
  if (!query) {
    return <>{text}</>;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const parts: JSX.Element[] = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    const matchIndex = lowerText.indexOf(normalizedQuery, startIndex);
    if (matchIndex === -1) {
      parts.push(<>{text.slice(startIndex)}</>);
      break;
    }

    if (matchIndex > startIndex) {
      parts.push(<>{text.slice(startIndex, matchIndex)}</>);
    }

    parts.push(
      <mark
        style={{
          background: 'rgba(255, 200, 50, 0.35)',
          color: 'inherit',
          'border-radius': '2px',
        }}
      >
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>,
    );

    startIndex = matchIndex + normalizedQuery.length;
  }

  return <>{parts}</>;
}

function highlightSearchInHtml(html: string, query: string | undefined): string {
  if (!query) {
    return html;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return html;
  }

  return html.replace(/([^<>]+)|(<[^>]*>)/g, (_match, text, tag) => {
    if (tag) {
      return tag;
    }

    const stringText = String(text ?? '');
    const lowerText = stringText.toLowerCase();
    let startIndex = 0;
    let result = '';

    while (startIndex < stringText.length) {
      const matchIndex = lowerText.indexOf(normalizedQuery, startIndex);
      if (matchIndex === -1) {
        result += stringText.slice(startIndex);
        break;
      }

      result += stringText.slice(startIndex, matchIndex);
      result += `<mark style="background:rgba(255, 200, 50, 0.35);color:inherit;border-radius:2px">${stringText.slice(matchIndex, matchIndex + normalizedQuery.length)}</mark>`;
      startIndex = matchIndex + normalizedQuery.length;
    }

    return result;
  });
}

function scrollContainerToElement(
  container: HTMLDivElement,
  element: HTMLElement,
  offset: number,
): void {
  const containerTop = container.getBoundingClientRect().top;
  const elementTop = element.getBoundingClientRect().top;
  const scrollPosition = elementTop - containerTop + container.scrollTop - offset;
  container.scrollTop = Math.max(0, scrollPosition);
}

function countLinesOfType(file: ParsedFileDiff, type: DiffLine['type']): number {
  return file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.type === type).length,
    0,
  );
}

function DiffLineView(props: {
  filePath: string;
  highlightedHtml?: string | null;
  line: DiffLine;
  searchQuery?: string;
}): JSX.Element {
  return (
    <div
      data-file-path={props.filePath}
      data-line-content={props.line.content}
      data-line-type={props.line.type}
      data-new-line={props.line.newLine ?? undefined}
      style={{
        display: 'grid',
        'grid-template-columns': '48px 48px 16px 1fr',
        background: LINE_BG[props.line.type],
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(12),
        'line-height': '1.5',
      }}
    >
      <span
        style={{
          'text-align': 'right',
          color: theme.fgSubtle,
          'font-size': sf(11),
          'user-select': 'none',
          padding: '0 4px',
        }}
      >
        {props.line.oldLine ?? ''}
      </span>
      <span
        style={{
          'text-align': 'right',
          color: theme.fgSubtle,
          'font-size': sf(11),
          'user-select': 'none',
          padding: '0 4px',
        }}
      >
        {props.line.newLine ?? ''}
      </span>
      <span
        style={{
          'text-align': 'center',
          color: getIndicatorColor(props.line.type),
          'font-weight': '600',
          'user-select': 'none',
        }}
      >
        {INDICATOR[props.line.type]}
      </span>
      <Show
        when={props.highlightedHtml}
        fallback={
          <span
            style={{
              'white-space': 'pre',
              'overflow-x': 'auto',
              'padding-right': '8px',
            }}
          >
            {highlightSearchMatches(props.line.content, props.searchQuery)}
          </span>
        }
      >
        {(highlightedHtml) => (
          <span
            style={{
              'white-space': 'pre',
              'overflow-x': 'auto',
              'padding-right': '8px',
            }}
            // eslint-disable-next-line solid/no-innerhtml -- HTML comes from the local syntax highlighter
            innerHTML={highlightSearchInHtml(highlightedHtml(), props.searchQuery)}
          />
        )}
      </Show>
    </div>
  );
}

function LineWithInsertions(props: {
  filePath: string;
  highlightedHtml?: string | null;
  line: DiffLine;
  getScrollContainer: () => HTMLDivElement | undefined;
  pendingSelectionKey: string | null;
  request: TaskReviewDiffRequest;
  reviewSession: ReviewSession;
  searchQuery?: string;
  setPendingSelectionKey: (key: string | null) => void;
  startAskSession: ScrollingDiffViewProps['startAskSession'];
}): JSX.Element {
  const currentLine = () => props.line.newLine;
  const isPendingSelection = () => {
    const lineNumber = currentLine();
    if (lineNumber === null) {
      return false;
    }

    return props.pendingSelectionKey === getPendingSelectionKey(props.filePath, lineNumber);
  };
  const inlineAnnotations = () => {
    const lineNumber = currentLine();
    if (lineNumber === null) {
      return [];
    }

    return props.reviewSession
      .annotations()
      .filter(
        (annotation) => annotation.source === props.filePath && annotation.endLine === lineNumber,
      );
  };
  const inlineQuestions = () => {
    const lineNumber = currentLine();
    if (lineNumber === null) {
      return [];
    }

    return props.reviewSession
      .activeQuestions()
      .filter(
        (question) => question.source === props.filePath && question.afterLine === lineNumber,
      );
  };

  function dismissInlineInput(): void {
    props.reviewSession.clearPendingSelection();
    props.setPendingSelectionKey(null);
  }

  function submitInlineInput(text: string, mode: 'review' | 'ask'): void {
    const shouldRestoreScroll = mode === 'review' && !props.reviewSession.sidebarOpen();
    const savedScrollTop = shouldRestoreScroll
      ? (props.getScrollContainer()?.scrollTop ?? null)
      : null;
    props.reviewSession.submitSelection(text, mode);
    props.setPendingSelectionKey(null);
    window.getSelection()?.removeAllRanges();
    if (savedScrollTop === null) {
      return;
    }

    requestAnimationFrame(() => {
      const scrollContainer = props.getScrollContainer();
      if (scrollContainer) {
        scrollContainer.scrollTop = savedScrollTop;
      }
    });
  }

  return (
    <>
      <DiffLineView
        filePath={props.filePath}
        highlightedHtml={props.highlightedHtml}
        line={props.line}
        searchQuery={props.searchQuery}
      />
      <Show when={isPendingSelection()}>
        <InlineInput onDismiss={dismissInlineInput} onSubmit={submitInlineInput} />
      </Show>
      <For each={inlineAnnotations()}>
        {(annotation) => (
          <ReviewCommentCard
            annotation={annotation}
            onDismiss={() => props.reviewSession.dismissAnnotation(annotation.id)}
            onUpdate={props.reviewSession.updateAnnotation}
          />
        )}
      </For>
      <For each={inlineQuestions()}>
        {(question) => (
          <AskCodeCard
            endLine={question.endLine}
            onDismiss={() => props.reviewSession.dismissQuestion(question.id)}
            question={question.question}
            requestId={question.id}
            selectedText={question.selectedText}
            source={question.source}
            startLine={question.startLine}
            startSession={props.startAskSession}
            worktreePath={props.request.worktreePath}
          />
        )}
      </For>
    </>
  );
}

function LineGroupView(props: {
  filePath: string;
  lang: string;
  getScrollContainer: () => HTMLDivElement | undefined;
  lines: ReadonlyArray<DiffLine>;
  pendingSelectionKey: string | null;
  request: TaskReviewDiffRequest;
  reviewSession: ReviewSession;
  searchQuery?: string;
  setPendingSelectionKey: (key: string | null) => void;
  startAskSession: ScrollingDiffViewProps['startAskSession'];
}): JSX.Element {
  const [highlightedLines, setHighlightedLines] = createSignal<string[] | null>(null);
  let generation = 0;

  createEffect(() => {
    const code = props.lines.map((line) => line.content).join('\n');
    if (!code) {
      setHighlightedLines([]);
      return;
    }

    const nextGeneration = ++generation;
    highlightLines(code, props.lang)
      .then((lines) => {
        if (nextGeneration === generation) {
          setHighlightedLines(lines);
        }
      })
      .catch(() => {
        if (nextGeneration === generation) {
          setHighlightedLines(null);
        }
      });
  });

  return (
    <For each={props.lines}>
      {(line, index) => (
        <LineWithInsertions
          filePath={props.filePath}
          getScrollContainer={props.getScrollContainer}
          highlightedHtml={highlightedLines()?.[index()] ?? null}
          line={line}
          pendingSelectionKey={props.pendingSelectionKey}
          request={props.request}
          reviewSession={props.reviewSession}
          searchQuery={props.searchQuery}
          setPendingSelectionKey={props.setPendingSelectionKey}
          startAskSession={props.startAskSession}
        />
      )}
    </For>
  );
}

function ExpandableGap(props: {
  currentHunk: DiffHunk;
  file?: TaskReviewDiffFileTarget;
  filePath: string;
  lang: string;
  getScrollContainer: () => HTMLDivElement | undefined;
  pendingSelectionKey: string | null;
  previousHunk: DiffHunk;
  request: TaskReviewDiffRequest;
  reviewSession: ReviewSession;
  searchQuery?: string;
  setPendingSelectionKey: (key: string | null) => void;
  startAskSession: ScrollingDiffViewProps['startAskSession'];
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [gapLines, setGapLines] = createSignal<DiffLine[]>([]);
  const [loading, setLoading] = createSignal(false);

  function getHiddenCount(): number {
    const previousEnd = props.previousHunk.newStart + props.previousHunk.newCount;
    return props.currentHunk.newStart - previousEnd;
  }

  async function expand(): Promise<void> {
    if (expanded() || loading() || !props.file) {
      return;
    }

    setLoading(true);
    try {
      const result = await fetchTaskFileDiff(props.request, props.file);
      const fileLines = result.newContent.split('\n');
      const startLine = props.previousHunk.newStart + props.previousHunk.newCount;
      const endLine = props.currentHunk.newStart;
      const previousOldEnd = props.previousHunk.oldStart + props.previousHunk.oldCount;
      const previousNewEnd = props.previousHunk.newStart + props.previousHunk.newCount;
      const nextLines: DiffLine[] = [];

      for (let lineNumber = startLine; lineNumber < endLine; lineNumber += 1) {
        nextLines.push({
          type: 'context',
          content: fileLines[lineNumber - 1] ?? '',
          oldLine: previousOldEnd + (lineNumber - previousNewEnd),
          newLine: lineNumber,
        });
      }

      setGapLines(nextLines);
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  }

  function getGapLabel(): string {
    if (loading()) {
      return 'Loading...';
    }

    const hiddenCount = getHiddenCount();
    if (hiddenCount > 0) {
      return `${hiddenCount} lines hidden`;
    }

    return '...';
  }

  return (
    <Show
      when={expanded()}
      fallback={
        <div
          onClick={() => {
            void expand();
          }}
          style={{
            padding: '2px 0',
            'text-align': 'center',
            color: theme.fgSubtle,
            'font-size': sf(11),
            'font-family': "'JetBrains Mono', monospace",
            background: theme.bgElevated,
            'border-top': `1px solid ${theme.borderSubtle}`,
            'border-bottom': `1px solid ${theme.borderSubtle}`,
            'user-select': 'none',
            cursor: getHiddenCount() > 0 ? 'pointer' : 'default',
          }}
        >
          {getGapLabel()}
        </div>
      }
    >
      <LineGroupView
        filePath={props.filePath}
        getScrollContainer={props.getScrollContainer}
        lang={props.lang}
        lines={gapLines()}
        pendingSelectionKey={props.pendingSelectionKey}
        request={props.request}
        reviewSession={props.reviewSession}
        searchQuery={props.searchQuery}
        setPendingSelectionKey={props.setPendingSelectionKey}
        startAskSession={props.startAskSession}
      />
    </Show>
  );
}

function FileSection(props: {
  dimmed: boolean;
  file: ParsedFileDiff;
  requestFile?: TaskReviewDiffFileTarget;
  getScrollContainer: () => HTMLDivElement | undefined;
  pendingSelectionKey: string | null;
  request: TaskReviewDiffRequest;
  reviewSession: ReviewSession;
  searchQuery?: string;
  setPendingSelectionKey: (key: string | null) => void;
  setRef: (element: HTMLDivElement) => void;
  startAskSession: ScrollingDiffViewProps['startAskSession'];
}): JSX.Element {
  const [collapsed, setCollapsed] = createSignal(false);
  const lang = () => detectLang(props.file.path);

  return (
    <div
      ref={props.setRef}
      style={{
        margin: '16px 10px',
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
        overflow: 'hidden',
        background: theme.bgElevated,
        opacity: props.dimmed ? '0.25' : '0.9',
        transition: 'opacity 5s ease-out',
      }}
    >
      <div
        onClick={() => setCollapsed(!collapsed())}
        style={{
          position: 'sticky',
          top: '0',
          'z-index': '1',
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '3px 10px',
          background: `color-mix(in srgb, ${theme.bgElevated} 96%, white)`,
          'border-bottom': `1px solid ${theme.border}`,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            color: theme.fgSubtle,
            'font-size': sf(11),
            'user-select': 'none',
            transition: 'transform 0.15s',
            transform: collapsed() ? 'rotate(-90deg)' : 'rotate(0deg)',
            display: 'inline-block',
          }}
        >
          ▾
        </span>
        <span
          style={{
            'font-size': sf(11),
            'font-weight': '600',
            padding: '2px 8px',
            'border-radius': '4px',
            color: getStatusColor(props.file.status),
            background: 'rgba(255,255,255,0.06)',
          }}
        >
          {STATUS_LABELS[props.file.status] ?? props.file.status}
        </span>
        <span
          style={{
            flex: '1',
            'font-size': sf(12),
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fg,
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.file.path}
        </span>
        <span
          style={{
            'font-size': sf(11),
            color: theme.success,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          +{countLinesOfType(props.file, 'add')}
        </span>
        <span
          style={{
            'font-size': sf(11),
            color: theme.error,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          -{countLinesOfType(props.file, 'remove')}
        </span>
        <button
          onClick={(event) => {
            event.stopPropagation();
            void openFileInEditor(props.request.worktreePath, props.file.path);
          }}
          disabled={!props.request.worktreePath}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: props.request.worktreePath ? 'pointer' : 'default',
            opacity: props.request.worktreePath ? '1' : '0.3',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': '4px',
          }}
          title="Open in editor"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
          </svg>
        </button>
      </div>

      <Show when={!collapsed()}>
        <Show
          when={props.file.binary}
          fallback={
            <div style={{ 'padding-bottom': '8px', background: 'rgba(0, 0, 0, 0.15)' }}>
              <For each={props.file.hunks}>
                {(hunk, index) => (
                  <>
                    <Show when={index() > 0}>
                      <ExpandableGap
                        currentHunk={hunk}
                        file={props.requestFile}
                        filePath={props.file.path}
                        getScrollContainer={props.getScrollContainer}
                        lang={lang()}
                        pendingSelectionKey={props.pendingSelectionKey}
                        previousHunk={props.file.hunks[index() - 1] ?? hunk}
                        request={props.request}
                        reviewSession={props.reviewSession}
                        searchQuery={props.searchQuery}
                        setPendingSelectionKey={props.setPendingSelectionKey}
                        startAskSession={props.startAskSession}
                      />
                    </Show>
                    <LineGroupView
                      filePath={props.file.path}
                      getScrollContainer={props.getScrollContainer}
                      lang={lang()}
                      lines={hunk.lines}
                      pendingSelectionKey={props.pendingSelectionKey}
                      request={props.request}
                      reviewSession={props.reviewSession}
                      searchQuery={props.searchQuery}
                      setPendingSelectionKey={props.setPendingSelectionKey}
                      startAskSession={props.startAskSession}
                    />
                  </>
                )}
              </For>
            </div>
          }
        >
          <div
            style={{
              padding: '24px',
              'text-align': 'center',
              color: theme.fgMuted,
              'font-size': sf(12),
            }}
          >
            Binary file - cannot display diff
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function ScrollingDiffView(props: ScrollingDiffViewProps): JSX.Element {
  const [dimOthers, setDimOthers] = createSignal(false);
  const [pendingSelectionKey, setPendingSelectionKey] = createSignal<string | null>(null);
  const sectionRefs = new Map<string, HTMLDivElement>();
  let containerRef: HTMLDivElement | undefined;
  let dimTimer: ReturnType<typeof setTimeout> | undefined;

  createDialogScroll({
    enabled: () => props.files.length > 0,
    getElement: () => containerRef,
  });

  onCleanup(() => {
    clearTimeout(dimTimer);
  });

  createEffect(() => {
    if (!props.reviewSession.pendingSelection()) {
      setPendingSelectionKey(null);
    }
  });

  createEffect(() => {
    const target = props.scrollToPath;
    if (!target || !containerRef) {
      return;
    }

    clearTimeout(dimTimer);
    setDimOthers(true);
    requestAnimationFrame(() => setDimOthers(false));
    requestAnimationFrame(() => {
      const targetElement = sectionRefs.get(target);
      if (!targetElement || !containerRef) {
        return;
      }

      scrollContainerToElement(containerRef, targetElement, 50);
    });
  });

  createEffect(() => {
    const query = props.searchQuery?.trim();
    if (!query || !containerRef) {
      return;
    }

    requestAnimationFrame(() => {
      const firstMatch = containerRef?.querySelector('mark');
      if (!(firstMatch instanceof HTMLElement) || !containerRef) {
        return;
      }

      scrollContainerToElement(containerRef, firstMatch, 80);
    });
  });

  createEffect(() => {
    const target = props.reviewSession.scrollTarget();
    if (!target || !containerRef) {
      return;
    }

    requestAnimationFrame(() => {
      const section = sectionRefs.get(target.source);
      const targetElement =
        section?.querySelector<HTMLElement>(`[data-new-line="${target.endLine}"]`) ?? undefined;
      if (!targetElement || !containerRef) {
        return;
      }

      scrollContainerToElement(containerRef, targetElement, 80);
      props.reviewSession.setScrollTarget(null);
    });
  });

  function handleMouseUp(): void {
    const selection = getDiffSelection();
    if (!selection) {
      return;
    }

    props.reviewSession.handleSelection({
      source: selection.filePath,
      lineBeginning: selection.lineBeginning,
      startLine: selection.startLine,
      endLine: selection.endLine,
      selectedText: selection.selectedText,
      afterLine: selection.endLine,
    });
    setPendingSelectionKey(getPendingSelectionKey(selection.filePath, selection.endLine));
    window.getSelection()?.removeAllRanges();
  }

  function getRequestFile(
    file: ParsedFileDiff,
    requestFile: TaskReviewDiffFileTarget | undefined,
  ): TaskReviewDiffFileTarget | undefined {
    if (requestFile?.path === file.path) {
      return requestFile;
    }

    if (!props.requestSource) {
      return undefined;
    }

    return {
      committed: props.requestSource === 'branch',
      path: file.path,
      status: file.status,
    };
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseUp={handleMouseUp}
      style={{
        height: '100%',
        'overflow-y': 'auto',
        background: '#000',
        outline: 'none',
      }}
    >
      <For each={props.files}>
        {(file) => (
          <FileSection
            dimmed={dimOthers() && file.path !== props.scrollToPath}
            file={file}
            requestFile={getRequestFile(file, props.file)}
            getScrollContainer={() => containerRef}
            pendingSelectionKey={pendingSelectionKey()}
            request={props.request}
            reviewSession={props.reviewSession}
            searchQuery={props.searchQuery}
            setPendingSelectionKey={setPendingSelectionKey}
            setRef={(element) => {
              sectionRefs.set(file.path, element);
            }}
            startAskSession={props.startAskSession}
          />
        )}
      </For>

      <Show when={props.files.length === 0}>
        <div
          style={{
            padding: '40px',
            'text-align': 'center',
            color: theme.fgMuted,
            'font-size': sf(12),
          }}
        >
          No changes to display
        </div>
      </Show>
    </div>
  );
}
