import type { DiffComment } from '../store/types';

/**
 * Compile draft review comments into a structured prompt for the agent.
 * Comments are sorted by file path then line number to produce a deterministic output.
 */
export function compileReviewPrompt(comments: DiffComment[]): string {
  const drafts = comments.filter((c) => c.status === 'draft');
  if (drafts.length === 0) return '';

  // Sort by file path, then start line
  const sorted = [...drafts].sort((a, b) => {
    const pathCmp = a.anchor.filePath.localeCompare(b.anchor.filePath);
    if (pathCmp !== 0) return pathCmp;
    return a.anchor.startLine - b.anchor.startLine;
  });

  const lines = sorted.map((c) => {
    const file = c.anchor.filePath;
    const lineLabel =
      c.anchor.startLine === c.anchor.endLine
        ? `line ${c.anchor.startLine}`
        : `lines ${c.anchor.startLine}-${c.anchor.endLine}`;
    return `- In \`${file}\` ${lineLabel}: ${c.text}`;
  });

  return `Please make these changes to the code:\n${lines.join('\n')}`;
}
