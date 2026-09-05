import path from 'path';

import type { PendingTaskContentRootAdmission } from './terminal-root-authority.js';
import { readBoundedTaskTextFile } from './task-file-access.js';

export interface MarkdownFileContent {
  content: string;
  fileName: string;
  relativePath: string;
  worktreePath: string;
}

export const MARKDOWN_FILE_MAX_BYTES = 5 * 1024 * 1024;

function isMarkdownPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.md';
}

export async function readMarkdownFile(
  admission: PendingTaskContentRootAdmission,
  relativePath: string,
): Promise<MarkdownFileContent | null> {
  if (!isMarkdownPath(relativePath)) {
    return null;
  }

  const result = await readBoundedTaskTextFile({
    admission,
    allowedRoots: [admission.root],
    maxBytes: MARKDOWN_FILE_MAX_BYTES,
    relativePath,
    acceptCanonicalPath: isMarkdownPath,
  });
  if (!result) {
    return null;
  }

  return {
    content: result.content,
    fileName: path.basename(result.canonicalPath),
    relativePath: result.relativePath,
    worktreePath: admission.root,
  };
}
