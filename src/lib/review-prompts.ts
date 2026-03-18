import type { ReviewAnnotation } from '../app/review-session';

function getLineLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

function getLineBeginning(text: string): string {
  const firstContentLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const lineBeginning = firstContentLine ?? text.split('\n')[0]?.trim() ?? '';
  if (lineBeginning.length <= 80) {
    return lineBeginning;
  }

  return `${lineBeginning.slice(0, 77)}...`;
}

export function buildAskAboutCodePrompt(
  source: string,
  startLine: number,
  endLine: number,
  selectedText: string,
  question: string,
): string {
  const language = source.split('.').pop() ?? '';
  const lineLabel = getLineLabel(startLine, endLine);

  return `In ${source}, ${lineLabel}:\n\n\`\`\`${language}\n${selectedText}\n\`\`\`\n\n${question}`;
}

export function compileDiffReviewPrompt(annotations: ReadonlyArray<ReviewAnnotation>): string {
  const lines = ['Please address these file review comments:', ''];
  const sortedAnnotations = [...annotations].sort((left, right) => {
    const sourceComparison = left.source.localeCompare(right.source);
    if (sourceComparison !== 0) {
      return sourceComparison;
    }

    if (left.startLine !== right.startLine) {
      return left.startLine - right.startLine;
    }

    return left.endLine - right.endLine;
  });

  for (const annotation of sortedAnnotations) {
    const lineBeginning = getLineBeginning(annotation.lineBeginning ?? annotation.selectedText);
    lines.push(
      `- ${annotation.source} | ${getLineLabel(annotation.startLine, annotation.endLine)} | begins with: ${lineBeginning}`,
    );
    lines.push(`  Comment: ${annotation.comment}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
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
