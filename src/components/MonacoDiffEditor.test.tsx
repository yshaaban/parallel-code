import { fireEvent, render, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const monacoMock = vi.hoisted(() => ({
  diffUpdateDispose: vi.fn(),
  editorDispose: vi.fn(),
  modifiedRevealLineInCenter: vi.fn(),
  originalModelDispose: vi.fn(),
  modifiedModelDispose: vi.fn(),
  defineTheme: vi.fn(),
  setModelLanguage: vi.fn(),
  setTheme: vi.fn(),
}));

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: monacoMock.defineTheme,
    createDiffEditor: vi.fn(() => ({
      dispose: monacoMock.editorDispose,
      getLineChanges: vi.fn(() => [{ modifiedStartLineNumber: 3 }]),
      getModifiedEditor: vi.fn(() => ({
        revealLineInCenter: monacoMock.modifiedRevealLineInCenter,
      })),
      onDidUpdateDiff: vi.fn(() => ({ dispose: monacoMock.diffUpdateDispose })),
      setModel: vi.fn(),
      updateOptions: vi.fn(),
    })),
    createModel: vi.fn((_content: string, _language: string) => ({
      dispose: vi.fn(),
      getValue: vi.fn(() => _content),
      setValue: vi.fn(),
    })),
    setModelLanguage: monacoMock.setModelLanguage,
    setTheme: monacoMock.setTheme,
  },
}));

vi.mock('../lib/monaco-workers', () => ({}));

import * as monaco from 'monaco-editor';
import { MonacoDiffEditor } from './MonacoDiffEditor';

describe('MonacoDiffEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let nextModelIndex = 0;
    vi.mocked(monaco.editor.createModel).mockImplementation((content: string) => {
      const dispose =
        nextModelIndex === 0 ? monacoMock.originalModelDispose : monacoMock.modifiedModelDispose;
      nextModelIndex += 1;
      return {
        dispose,
        getValue: vi.fn(() => content),
        setValue: vi.fn(),
      } as unknown as monaco.editor.ITextModel;
    });
  });

  it('cleans up hidden-line click and diff subscriptions on unmount', async () => {
    const result = render(() => (
      <MonacoDiffEditor
        oldContent="old"
        newContent="new"
        language="typescript"
        sideBySide={false}
      />
    ));

    await waitFor(() => {
      expect(monaco.editor.createDiffEditor).toHaveBeenCalledTimes(1);
    });

    const editorRoot = result.container.firstElementChild as HTMLDivElement;
    const hiddenLineCenter = document.createElement('div');
    hiddenLineCenter.className = 'center';
    const hiddenLines = document.createElement('div');
    hiddenLines.className = 'diff-hidden-lines';
    const expandButton = document.createElement('a');
    expandButton.setAttribute('role', 'button');
    const expandClick = vi.fn((event: MouseEvent) => event.stopPropagation());

    expandButton.addEventListener('click', expandClick);
    hiddenLineCenter.append(expandButton);
    hiddenLines.append(hiddenLineCenter);
    editorRoot.append(hiddenLines);

    fireEvent.click(hiddenLineCenter);
    expect(expandClick).toHaveBeenCalledTimes(1);

    result.unmount();
    fireEvent.click(hiddenLineCenter);

    expect(expandClick).toHaveBeenCalledTimes(1);
    expect(monacoMock.diffUpdateDispose).toHaveBeenCalledTimes(1);
    expect(monacoMock.editorDispose).toHaveBeenCalledTimes(1);
    expect(monacoMock.originalModelDispose).toHaveBeenCalledTimes(1);
    expect(monacoMock.modifiedModelDispose).toHaveBeenCalledTimes(1);
  });

  it('replays an initial reveal target after Monaco finishes loading', async () => {
    const onRevealLine = vi.fn();

    render(() => (
      <MonacoDiffEditor
        oldContent="old"
        newContent="new"
        language="typescript"
        revealLine={42}
        sideBySide={false}
        onRevealLine={onRevealLine}
      />
    ));

    await waitFor(() => {
      expect(monacoMock.modifiedRevealLineInCenter).toHaveBeenCalledWith(42);
    });
    expect(onRevealLine).toHaveBeenCalledTimes(1);
  });
});
