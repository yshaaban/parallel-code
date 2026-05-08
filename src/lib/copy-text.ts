interface ReflowOptions {
  minInteriorLength?: number;
  varianceTolerance?: number;
}

interface LineInfo {
  hadTrailingWhitespace: boolean;
  stripped: string;
}

export function stripTrailingWhitespacePerLine(text: string): string {
  return text.replace(/[ \t]+(?=\n|$)/g, '');
}

function shouldReflowParagraph(
  paragraph: ReadonlyArray<LineInfo>,
  minInteriorLength: number,
  varianceTolerance: number,
): boolean {
  if (paragraph.length < 2) {
    return false;
  }

  const interiorLines = paragraph.slice(0, -1);
  if (!interiorLines.every((line) => line.hadTrailingWhitespace)) {
    return false;
  }

  let minLength = Infinity;
  let maxLength = -Infinity;

  for (const line of interiorLines) {
    const length = line.stripped.length;
    minLength = Math.min(minLength, length);
    maxLength = Math.max(maxLength, length);
  }

  return minLength >= minInteriorLength && maxLength - minLength <= varianceTolerance;
}

function reflowParagraph(paragraph: ReadonlyArray<LineInfo>): string {
  const [firstLine, ...continuationLines] = paragraph;
  return [
    firstLine?.stripped ?? '',
    ...continuationLines.map((line) => line.stripped.replace(/^[ \t]+/, '')),
  ].join(' ');
}

function toLineInfo(line: string): LineInfo {
  const stripped = line.replace(/[ \t]+$/u, '');
  return {
    hadTrailingWhitespace: stripped.length !== line.length,
    stripped,
  };
}

export function reflowWrappedParagraphs(text: string, options: ReflowOptions = {}): string {
  const minInteriorLength = options.minInteriorLength ?? 40;
  const varianceTolerance = options.varianceTolerance ?? 8;
  const lines = text.split('\n').map(toLineInfo);
  const output: string[] = [];

  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.stripped === '') {
      output.push('');
      index += 1;
      continue;
    }

    const paragraphStart = index;
    while (index < lines.length && lines[index]?.stripped !== '') {
      index += 1;
    }

    const paragraph = lines.slice(paragraphStart, index);
    if (shouldReflowParagraph(paragraph, minInteriorLength, varianceTolerance)) {
      output.push(reflowParagraph(paragraph));
    } else {
      output.push(...paragraph.map((line) => line.stripped));
    }
  }

  return output.join('\n');
}

export function cleanCopiedTerminalText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  return reflowWrappedParagraphs(normalized);
}
