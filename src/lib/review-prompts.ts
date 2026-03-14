import type { ReviewAnnotation } from '../app/review-session';

export function buildAskAboutCodePrompt(
  source: string,
  startLine: number,
  endLine: number,
  selectedText: string,
  question: string,
): string {
  const language = source.split('.').pop() ?? '';
  const lineLabel = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;

  return `In ${source}, ${lineLabel}:\n\n\`\`\`${language}\n${selectedText}\n\`\`\`\n\n${question}`;
}

export function compileDiffReviewPrompt(annotations: ReadonlyArray<ReviewAnnotation>): string {
  const lines = ['Code review feedback for your changes:', ''];

  for (const annotation of annotations) {
    lines.push(`## ${annotation.source} (lines ${annotation.startLine}-${annotation.endLine})`);
    lines.push('```');
    lines.push(annotation.selectedText);
    lines.push('```');
    lines.push(annotation.comment);
    lines.push('');
  }

  return lines.join('\n');
}

export function compilePlanReviewPrompt(annotations: ReadonlyArray<ReviewAnnotation>): string {
  const lines = ['Feedback on the implementation plan:', ''];

  for (const annotation of annotations) {
    lines.push(`## ${annotation.source}`);
    lines.push(`> ${annotation.selectedText.split('\n').join('\n> ')}`);
    lines.push('');
    lines.push(annotation.comment);
    lines.push('');
  }

  return lines.join('\n');
}
