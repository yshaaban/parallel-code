import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as unknown as Record<string, unknown>).MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker();
  },
};
