import { onMount, onCleanup, createEffect } from 'solid-js';
import * as monaco from 'monaco-editor';
import { store } from '../store/core';
import { monacoThemeName } from '../lib/monaco-theme';

interface MonacoDiffEditorProps {
  oldContent: string;
  newContent: string;
  language: string;
  sideBySide: boolean;
}

export function MonacoDiffEditor(props: MonacoDiffEditorProps) {
  let containerRef!: HTMLDivElement;
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  let originalModel: monaco.editor.ITextModel | undefined;
  let modifiedModel: monaco.editor.ITextModel | undefined;

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
    });

    originalModel = monaco.editor.createModel(props.oldContent, props.language);
    modifiedModel = monaco.editor.createModel(props.newContent, props.language);
    editor.setModel({ original: originalModel, modified: modifiedModel });
  });

  createEffect(() => {
    const lang = props.language;
    if (originalModel) monaco.editor.setModelLanguage(originalModel, lang);
    if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, lang);
  });

  createEffect(() => {
    if (originalModel) originalModel.setValue(props.oldContent);
  });

  createEffect(() => {
    if (modifiedModel) modifiedModel.setValue(props.newContent);
  });

  createEffect(() => {
    editor?.updateOptions({ renderSideBySide: props.sideBySide });
  });

  createEffect(() => {
    monaco.editor.setTheme(monacoThemeName(store.themePreset));
  });

  onCleanup(() => {
    originalModel?.dispose();
    modifiedModel?.dispose();
    editor?.dispose();
  });

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
