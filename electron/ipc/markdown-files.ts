import fs from 'fs';
import path from 'path';

interface MarkdownFileContent {
  content: string;
  fileName: string;
  relativePath: string;
}

function isMarkdownRelativePath(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.md');
}

export function readMarkdownFileForWorktree(
  worktreePath: string,
  relativePath: string,
): MarkdownFileContent | null {
  if (!isMarkdownRelativePath(relativePath)) {
    return null;
  }

  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedFilePath = path.resolve(resolvedWorktreePath, relativePath);
  const relativeToWorktree = path.relative(resolvedWorktreePath, resolvedFilePath);
  if (
    relativeToWorktree.startsWith('..') ||
    path.isAbsolute(relativeToWorktree) ||
    relativeToWorktree.length === 0
  ) {
    return null;
  }

  try {
    const stats = fs.statSync(resolvedFilePath);
    if (!stats.isFile()) {
      return null;
    }

    return {
      content: fs.readFileSync(resolvedFilePath, 'utf8'),
      fileName: path.basename(resolvedFilePath),
      relativePath: relativeToWorktree,
    };
  } catch {
    return null;
  }
}
