import { describe, expect, it, vi } from 'vitest';
import {
  dataTransferHasFiles,
  dataTransferToTerminalPaste,
  escapeTerminalPath,
  type TerminalDropOptions,
} from './terminal-drop';

type FakeFile = Pick<File, 'arrayBuffer' | 'name' | 'size'>;

function makeFile(name: string, bytes: Uint8Array): FakeFile {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return {
    arrayBuffer: () => Promise.resolve(buffer),
    name,
    size: bytes.byteLength,
  };
}

function makeDataTransfer(files: FakeFile[], types: string[] = ['Files']): DataTransfer {
  return {
    files: files as unknown as FileList,
    types,
  } as unknown as DataTransfer;
}

describe('escapeTerminalPath', () => {
  it('keeps safe paths unchanged', () => {
    expect(escapeTerminalPath('/tmp/app/file.png')).toBe('/tmp/app/file.png');
    expect(escapeTerminalPath('user@host:/tmp/file.txt')).toBe('user@host:/tmp/file.txt');
  });

  it('escapes whitespace and shell metacharacters', () => {
    expect(escapeTerminalPath('/tmp/My Image.png')).toBe('/tmp/My\\ Image.png');
    expect(escapeTerminalPath(`/tmp/it's "odd" & cool.png`)).toBe(
      `/tmp/it\\'s\\ \\"odd\\"\\ \\&\\ cool.png`,
    );
    expect(escapeTerminalPath('/tmp/a$b`c`.png')).toBe('/tmp/a\\$b\\`c\\`.png');
    expect(escapeTerminalPath('/tmp/[a]{b}#c!.png')).toBe('/tmp/\\[a\\]\\{b\\}\\#c\\!.png');
  });

  it('quotes paths with newlines instead of emitting shell line continuations', () => {
    expect(escapeTerminalPath("/tmp/line\nbreak's file.png")).toBe(
      "'/tmp/line\nbreak'\\''s file.png'",
    );
  });

  it('renders an empty path as an explicit empty argument', () => {
    expect(escapeTerminalPath('')).toBe('""');
  });
});

describe('dataTransferHasFiles', () => {
  it('detects file drops from files or types', () => {
    expect(dataTransferHasFiles(makeDataTransfer([makeFile('a.png', new Uint8Array())]))).toBe(
      true,
    );
    expect(dataTransferHasFiles(makeDataTransfer([], ['text/plain', 'Files']))).toBe(true);
    expect(dataTransferHasFiles(makeDataTransfer([], ['text/plain']))).toBe(false);
    expect(dataTransferHasFiles(null)).toBe(false);
  });
});

describe('dataTransferToTerminalPaste', () => {
  it('uses the native path resolver when the file has a backing path', async () => {
    const resolveFilePath = vi.fn(() => '/tmp/My Image.png');
    const saveDroppedFile = vi.fn();
    const paste = await dataTransferToTerminalPaste(
      makeDataTransfer([makeFile('My Image.png', new Uint8Array([1, 2, 3]))]),
      { resolveFilePath, saveDroppedFile },
    );

    expect(paste).toBe('/tmp/My\\ Image.png');
    expect(saveDroppedFile).not.toHaveBeenCalled();
  });

  it('saves pathless dropped files through the provided callback', async () => {
    const saveDroppedFile = vi.fn(async () => '/tmp/parallel-code-drop-screenshot.png');
    const paste = await dataTransferToTerminalPaste(
      makeDataTransfer([makeFile('screenshot.png', new Uint8Array([137, 80, 78, 71]))]),
      { resolveFilePath: () => '', saveDroppedFile },
    );

    expect(paste).toBe('/tmp/parallel-code-drop-screenshot.png');
    expect(saveDroppedFile).toHaveBeenCalledWith({
      data: 'iVBORw==',
      name: 'screenshot.png',
    });
  });

  it('joins multiple resolved files and skips failed ones', async () => {
    const files = [makeFile('a.png', new Uint8Array()), makeFile('b.png', new Uint8Array([1]))];
    const options: TerminalDropOptions = {
      resolveFilePath: (file) => (file.name === 'a.png' ? '/tmp/a.png' : ''),
      saveDroppedFile: async () => null,
    };

    expect(await dataTransferToTerminalPaste(makeDataTransfer(files), options)).toBe('/tmp/a.png');
  });

  it('skips files larger than the configured cap', async () => {
    const saveDroppedFile = vi.fn();
    const file = makeFile('huge.png', new Uint8Array());
    Object.defineProperty(file, 'size', { configurable: true, value: 11 });

    const paste = await dataTransferToTerminalPaste(makeDataTransfer([file]), {
      maxFileBytes: 10,
      resolveFilePath: () => '',
      saveDroppedFile,
    });

    expect(paste).toBe('');
    expect(saveDroppedFile).not.toHaveBeenCalled();
  });
});
