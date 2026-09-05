import { createMemo, onCleanup, type JSX } from 'solid-js';

import { createDialogScroll } from '../../lib/dialog-scroll';
import { renderMarkdownSafely } from '../../lib/marked-shiki';
import { theme } from '../../lib/theme';
import { typography } from '../../lib/typography';

interface TaskPlanContentProps {
  content: string;
  onOpenPlanViewer: () => Promise<void> | void;
  setPlanFocusRef: (element: HTMLDivElement | undefined) => void;
}

export function TaskPlanContent(props: TaskPlanContentProps): JSX.Element {
  const html = createMemo(() => renderMarkdownSafely(props.content));
  let contentRef: HTMLDivElement | undefined;

  createDialogScroll({
    enabled: () => true,
    getElement: () => contentRef,
  });

  onCleanup(() => {
    props.setPlanFocusRef(undefined);
  });

  function openPlanViewer(): void {
    void props.onOpenPlanViewer();
  }

  function openPlanViewerFromKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.currentTarget !== event.target) {
      return;
    }

    event.preventDefault();
    openPlanViewer();
  }

  return (
    <div
      style={{
        position: 'relative',
        flex: '1',
        overflow: 'hidden',
        background: theme.taskPanelBg,
      }}
    >
      <button
        type="button"
        onClick={openPlanViewer}
        title="Review Plan"
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          'z-index': '1',
          padding: '4px 10px',
          background: 'rgba(0, 0, 0, 0.72)',
          color: theme.fg,
          border: `1px solid ${theme.border}`,
          'border-radius': '999px',
          cursor: 'pointer',
          'backdrop-filter': 'blur(10px)',
          ...typography.monoMeta,
        }}
      >
        Review Plan
      </button>
      <div
        ref={(element) => {
          contentRef = element;
          props.setPlanFocusRef(element);
        }}
        tabIndex={0}
        class="plan-markdown"
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '6px 8px',
          color: theme.fg,
          ...typography.monoUi,
        }}
        onKeyDown={openPlanViewerFromKeyboard}
        // eslint-disable-next-line solid/no-innerhtml -- plan content is rendered through the shared sanitized markdown renderer
        innerHTML={html()}
      />
    </div>
  );
}
