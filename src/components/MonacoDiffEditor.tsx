import { createEffect, onCleanup, onMount, type JSX } from 'solid-js';
import * as monaco from 'monaco-editor';
import { store } from '../store/store';
import { monacoThemeName } from '../lib/monaco-theme';

interface MonacoDiffEditorProps {
  oldContent: string;
  newContent: string;
  language: string;
  onRevealLine?: () => void;
  revealLine?: number | null;
  sideBySide: boolean;
}

export function MonacoDiffEditor(props: MonacoDiffEditorProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  let originalModel: monaco.editor.ITextModel | undefined;
  let modifiedModel: monaco.editor.ITextModel | undefined;
  let diffUpdateDisposable: monaco.IDisposable | undefined;

  function handleHiddenLinesClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const center = target.closest('.diff-hidden-lines .center');
    if (!center) return;
    const link = center.querySelector<HTMLElement>('a[role="button"]');
    if (link && !link.contains(target)) link.click();
  }

  onMount(() => {
    editor = monaco.editor.createDiffEditor(containerRef, {
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: props.sideBySide,
      theme: monacoThemeName(store.themePreset),
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      stickyScroll: { enabled: false },
      hideUnchangedRegions: { enabled: true },
    });

    originalModel = monaco.editor.createModel(props.oldContent, props.language);
    modifiedModel = monaco.editor.createModel(props.newContent, props.language);
    editor.setModel({ original: originalModel, modified: modifiedModel });

    diffUpdateDisposable = editor.onDidUpdateDiff(() => {
      const changes = editor?.getLineChanges();
      if (changes && changes.length > 0) {
        const line = changes[0].modifiedStartLineNumber;
        editor?.getModifiedEditor().revealLineInCenter(line);
      }
    });

    // Make the entire hidden-lines bar clickable (Monaco only wires a tiny icon by default)
    containerRef.addEventListener('click', handleHiddenLinesClick);
  });

  createEffect(() => {
    const lang = props.language;
    if (originalModel) monaco.editor.setModelLanguage(originalModel, lang);
    if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, lang);
  });

  createEffect(() => {
    const value = props.oldContent;
    if (originalModel && originalModel.getValue() !== value) {
      originalModel.setValue(value);
    }
  });

  createEffect(() => {
    const value = props.newContent;
    if (modifiedModel && modifiedModel.getValue() !== value) {
      modifiedModel.setValue(value);
    }
  });

  createEffect(() => {
    editor?.updateOptions({ renderSideBySide: props.sideBySide });
  });

  createEffect(() => {
    const lineNumber = props.revealLine;
    if (!lineNumber || !editor) {
      return;
    }

    editor.getModifiedEditor().revealLineInCenter(lineNumber);
    props.onRevealLine?.();
  });

  createEffect(() => {
    monaco.editor.setTheme(monacoThemeName(store.themePreset));
  });

  onCleanup(() => {
    containerRef?.removeEventListener('click', handleHiddenLinesClick);
    diffUpdateDisposable?.dispose();
    editor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
  });

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
