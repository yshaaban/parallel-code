import { createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import type * as Monaco from 'monaco-editor';
import { store } from '../store/store';
import { monacoThemeName, registerMonacoThemes } from '../lib/monaco-theme';

interface MonacoDiffEditorProps {
  oldContent: string;
  newContent: string;
  language: string;
  onRevealLine?: () => void;
  revealLine?: number | null;
  sideBySide: boolean;
}

type MonacoModule = typeof import('monaco-editor');

let monacoModulePromise: Promise<MonacoModule> | null = null;

function loadMonacoModule(): Promise<MonacoModule> {
  monacoModulePromise ??= Promise.all([import('../lib/monaco-workers'), import('monaco-editor')])
    .then(([, module]) => {
      registerMonacoThemes(module.editor);
      return module;
    })
    .catch((error: unknown) => {
      monacoModulePromise = null;
      throw error;
    });

  return monacoModulePromise;
}

export function MonacoDiffEditor(props: MonacoDiffEditorProps): JSX.Element {
  let containerRef!: HTMLDivElement;
  let monacoModule: MonacoModule | undefined;
  let editor: Monaco.editor.IStandaloneDiffEditor | undefined;
  let originalModel: Monaco.editor.ITextModel | undefined;
  let modifiedModel: Monaco.editor.ITextModel | undefined;
  let diffUpdateDisposable: Monaco.IDisposable | undefined;
  let mounted = true;
  const [editorReadyVersion, setEditorReadyVersion] = createSignal(0);

  function handleHiddenLinesClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const center = target.closest('.diff-hidden-lines .center');
    if (!center) return;
    const link = center.querySelector<HTMLElement>('a[role="button"]');
    if (link && !link.contains(target)) link.click();
  }

  async function mountEditor(): Promise<void> {
    const loadedMonaco = await loadMonacoModule();
    if (!mounted) {
      return;
    }

    monacoModule = loadedMonaco;
    editor = loadedMonaco.editor.createDiffEditor(containerRef, {
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

    originalModel = loadedMonaco.editor.createModel(props.oldContent, props.language);
    modifiedModel = loadedMonaco.editor.createModel(props.newContent, props.language);
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
    setEditorReadyVersion((version) => version + 1);
  }

  onMount(() => {
    void mountEditor();
  });

  createEffect(() => {
    editorReadyVersion();
    const lang = props.language;
    if (originalModel) monacoModule?.editor.setModelLanguage(originalModel, lang);
    if (modifiedModel) monacoModule?.editor.setModelLanguage(modifiedModel, lang);
  });

  createEffect(() => {
    editorReadyVersion();
    const value = props.oldContent;
    if (originalModel && originalModel.getValue() !== value) {
      originalModel.setValue(value);
    }
  });

  createEffect(() => {
    editorReadyVersion();
    const value = props.newContent;
    if (modifiedModel && modifiedModel.getValue() !== value) {
      modifiedModel.setValue(value);
    }
  });

  createEffect(() => {
    editorReadyVersion();
    editor?.updateOptions({ renderSideBySide: props.sideBySide });
  });

  createEffect(() => {
    editorReadyVersion();
    const lineNumber = props.revealLine;
    if (!lineNumber || !editor) {
      return;
    }

    editor.getModifiedEditor().revealLineInCenter(lineNumber);
    props.onRevealLine?.();
  });

  createEffect(() => {
    editorReadyVersion();
    monacoModule?.editor.setTheme(monacoThemeName(store.themePreset));
  });

  onCleanup(() => {
    mounted = false;
    containerRef?.removeEventListener('click', handleHiddenLinesClick);
    diffUpdateDisposable?.dispose();
    editor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
  });

  return (
    <div
      ref={containerRef}
      class="monaco-diff-focus-shell"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
