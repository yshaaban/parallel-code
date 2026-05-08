const SAFE_TERMINAL_PATH_PATTERN = /^[A-Za-z0-9_./@:+,%=-]+$/u;
const TERMINAL_PATH_META_CHAR_PATTERN = /[\s'"\\$`!()<>;&|*?[\]{}~#]/gu;
const TERMINAL_PATH_REQUIRES_QUOTING_PATTERN = /[\r\n]/u;
const DEFAULT_MAX_DROPPED_FILE_BYTES = 50 * 1024 * 1024;
const BASE64_CHUNK_BYTES = 0x8000;

export interface SaveDroppedFileRequest {
  data: string;
  name?: string;
}

export interface TerminalDropOptions {
  maxFileBytes?: number;
  resolveFilePath?: (file: File) => string | null | undefined;
  saveDroppedFile?: (request: SaveDroppedFileRequest) => Promise<string | null | undefined>;
}

export function escapeTerminalPath(filePath: string): string {
  if (filePath === '') {
    return '""';
  }

  if (SAFE_TERMINAL_PATH_PATTERN.test(filePath)) {
    return filePath;
  }

  if (TERMINAL_PATH_REQUIRES_QUOTING_PATTERN.test(filePath)) {
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
  }

  return filePath.replace(TERMINAL_PATH_META_CHAR_PATTERN, '\\$&');
}

export function dataTransferHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes('Files');
}

export async function dataTransferToTerminalPaste(
  dataTransfer: DataTransfer,
  options: TerminalDropOptions = {},
): Promise<string> {
  const files = Array.from(dataTransfer.files);
  if (files.length === 0) {
    return '';
  }

  const paths = await Promise.all(files.map((file) => resolveDroppedFilePath(file, options)));
  return paths
    .filter((path): path is string => Boolean(path))
    .map(escapeTerminalPath)
    .join(' ');
}

async function resolveDroppedFilePath(
  file: File,
  options: TerminalDropOptions,
): Promise<string | null> {
  try {
    const directPath = options.resolveFilePath?.(file);
    if (directPath) {
      return directPath;
    }

    if (!options.saveDroppedFile) {
      return null;
    }

    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_DROPPED_FILE_BYTES;
    if (file.size > maxFileBytes) {
      return null;
    }

    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const saveRequest: SaveDroppedFileRequest = { data };
    if (file.name) {
      saveRequest.name = file.name;
    }

    return (await options.saveDroppedFile(saveRequest)) ?? null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_BYTES) {
    const slice = bytes.subarray(index, Math.min(index + BASE64_CHUNK_BYTES, bytes.length));
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}
