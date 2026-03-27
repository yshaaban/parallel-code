const encoder = new TextEncoder();

export interface BulkTextFixtureOptions {
  label: string;
  lineWidth?: number;
  paragraphBytes: number;
  paragraphCount: number;
}

export interface StatuslineFixtureOptions {
  footerTopRow: number;
  frameCount: number;
  label: string;
  splitSequences?: boolean;
}

export interface MixedFixtureOptions {
  bulkText: BulkTextFixtureOptions;
  statusline: StatuslineFixtureOptions;
}

export interface VerboseBurstFixtureOptions {
  label: string;
  lineWidth?: number;
  sectionBytes: number;
  sectionCount: number;
}

function createRepeatedPayload(token: string, width: number): string {
  const minimumWidth = Math.max(1, width);
  const repeatCount = Math.max(1, Math.ceil(minimumWidth / token.length));
  return token.repeat(repeatCount).slice(0, minimumWidth);
}

function wrapLine(text: string, lineWidth: number): string[] {
  const wrappedLines: string[] = [];
  for (let offset = 0; offset < text.length; offset += lineWidth) {
    wrappedLines.push(text.slice(offset, offset + lineWidth));
  }
  return wrappedLines.length > 0 ? wrappedLines : [''];
}

function wrapTextBlock(block: string, lineWidth: number): string[] {
  const wrappedLines: string[] = [];
  for (const line of block.split('\n')) {
    wrappedLines.push(...wrapLine(line, lineWidth));
  }
  return wrappedLines;
}

function createVerboseBurstPayload(
  label: string,
  burstLabel: string,
  sectionIndex: number,
  sectionBytes: number,
): string {
  return createRepeatedPayload(
    `${label}:${burstLabel}:${String(sectionIndex + 1).padStart(3, '0')} `,
    Math.max(1, sectionBytes),
  );
}

function createLabelSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'verbose-burst';
}

function createIdentifierName(label: string): string {
  const identifier = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return identifier.length > 0 ? identifier : 'verbose_burst';
}

function createPascalLabel(label: string): string {
  const parts = createLabelSlug(label).split('-');
  return parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
}

function createParagraphLines(
  label: string,
  paragraphIndex: number,
  paragraphCount: number,
  paragraphBytes: number,
  lineWidth: number,
): string[] {
  const header = `${label} ${String(paragraphIndex + 1).padStart(3, '0')}/${String(
    paragraphCount,
  ).padStart(3, '0')} `;
  const payload = createRepeatedPayload(
    `${label}:steady-state verbose payload ${paragraphIndex + 1} `,
    Math.max(1, paragraphBytes),
  );
  const block = `${header}${payload}`;
  const lines: string[] = [];

  for (let offset = 0; offset < block.length; offset += lineWidth) {
    lines.push(block.slice(offset, offset + lineWidth));
  }

  return lines;
}

function getStatuslineFrameSegments(
  label: string,
  frameIndex: number,
  frameCount: number,
  footerTopRow: number,
): string[] {
  const spinnerFrames = ['-', '\\', '|', '/'];
  const spinner = spinnerFrames[frameIndex % spinnerFrames.length] ?? '-';
  const progress = `${String(frameIndex + 1).padStart(3, '0')}/${String(frameCount).padStart(
    3,
    '0',
  )}`;

  return [
    '\x1b[s',
    `\x1b[${footerTopRow};1H`,
    '\x1b[2K',
    ` ${spinner} ${label} ${progress} · redraw-heavy statusline`,
    `\x1b[${footerTopRow + 1};1H`,
    '\x1b[2K',
    ' keeping the footer hot and the viewport busy',
    '\x1b[u',
  ];
}

export function createLineSpamChunks(
  label: string,
  lineCount: number,
  lineBytes: number,
): Uint8Array[] {
  const payload = lineBytes > 0 ? 'X'.repeat(lineBytes) : '';
  const chunks: Uint8Array[] = [];

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    chunks.push(encoder.encode(`${label}:${lineIndex + 1}:${payload}\n`));
  }

  return chunks;
}

export function createBulkTextChunks(options: BulkTextFixtureOptions): Uint8Array[] {
  const lineWidth = options.lineWidth ?? 96;
  const chunks: Uint8Array[] = [];

  for (let paragraphIndex = 0; paragraphIndex < options.paragraphCount; paragraphIndex += 1) {
    const lines = createParagraphLines(
      options.label,
      paragraphIndex,
      options.paragraphCount,
      options.paragraphBytes,
      lineWidth,
    );
    for (const line of lines) {
      chunks.push(encoder.encode(`${line}\n`));
    }
    chunks.push(encoder.encode('\n'));
  }

  return chunks;
}

export function createStatuslineChunks(options: StatuslineFixtureOptions): Uint8Array[] {
  const chunks: Uint8Array[] = [
    encoder.encode(`${options.label} statusline warmup\n`),
    encoder.encode('statusline fixture ready\n'),
  ];

  for (let frameIndex = 0; frameIndex < options.frameCount; frameIndex += 1) {
    const segments = getStatuslineFrameSegments(
      options.label,
      frameIndex,
      options.frameCount,
      options.footerTopRow,
    );
    if (options.splitSequences === false) {
      chunks.push(encoder.encode(segments.join('')));
      continue;
    }

    for (const segment of segments) {
      chunks.push(encoder.encode(segment));
    }
  }

  chunks.push(encoder.encode('\n'));
  return chunks;
}

export function createMixedWorkloadChunks(options: MixedFixtureOptions): Uint8Array[] {
  const bulkTextChunks = createBulkTextChunks(options.bulkText);
  const statuslineChunks = createStatuslineChunks(options.statusline);
  const chunks: Uint8Array[] = [];
  const totalChunkCount = Math.max(bulkTextChunks.length, statuslineChunks.length);

  for (let index = 0; index < totalChunkCount; index += 1) {
    const bulkTextChunk = bulkTextChunks[index];
    if (bulkTextChunk) {
      chunks.push(bulkTextChunk);
    }

    const statuslineChunk = statuslineChunks[index];
    if (statuslineChunk) {
      chunks.push(statuslineChunk);
    }
  }

  return chunks;
}

function createMarkdownBurstLines(
  options: VerboseBurstFixtureOptions,
  sectionIndex: number,
): string[] {
  const lineWidth = options.lineWidth ?? 96;
  const sectionCount = Math.max(1, options.sectionCount);
  const payload = createVerboseBurstPayload(
    options.label,
    'markdown',
    sectionIndex,
    options.sectionBytes,
  );
  const markdownBlock = [
    `# ${options.label} incident ${String(sectionIndex + 1).padStart(3, '0')}/${String(
      sectionCount,
    ).padStart(3, '0')}`,
    '',
    `- summary: ${payload}`,
    `- action: ${payload}`,
    '',
    '```md',
    `${options.label} · ${payload}`,
    '```',
  ].join('\n');
  return wrapTextBlock(markdownBlock, lineWidth);
}

function createCodeBurstLines(options: VerboseBurstFixtureOptions, sectionIndex: number): string[] {
  const lineWidth = options.lineWidth ?? 96;
  const sectionCount = Math.max(1, options.sectionCount);
  const identifier = createIdentifierName(options.label);
  const pascal = createPascalLabel(options.label);
  const payload = createVerboseBurstPayload(
    options.label,
    'code',
    sectionIndex,
    options.sectionBytes,
  );
  const codeBlock = [
    `function ${identifier}Section${String(sectionIndex + 1).padStart(3, '0')}() {`,
    `  const payload = ${JSON.stringify(payload)};`,
    `  const progress = ${JSON.stringify(
      `${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(3, '0')}`,
    )};`,
    '  return `${progress} ${payload}`;',
    '}',
    '',
    `class ${pascal}Reporter {`,
    '  summarize() {',
    '    return payload.length;',
    '  }',
    '}',
  ].join('\n');
  return wrapTextBlock(codeBlock, lineWidth);
}

function createDiffBurstLines(options: VerboseBurstFixtureOptions, sectionIndex: number): string[] {
  const lineWidth = options.lineWidth ?? 96;
  const sectionCount = Math.max(1, options.sectionCount);
  const slug = createLabelSlug(options.label);
  const payload = createVerboseBurstPayload(
    options.label,
    'diff',
    sectionIndex,
    options.sectionBytes,
  );
  const hunkStart = sectionIndex * 4 + 1;
  const diffBlock = [
    `diff --git a/${slug}.txt b/${slug}.txt`,
    'index 0000000..1111111 100644',
    `--- a/${slug}.txt`,
    `+++ b/${slug}.txt`,
    `@@ -${hunkStart},4 +${hunkStart},4 @@`,
    `- stale ${payload}`,
    `+ fresh ${payload}`,
    `  ${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(3, '0')} ${payload}`,
  ].join('\n');
  return wrapTextBlock(diffBlock, lineWidth);
}

function createAgentCliBurstLines(
  options: VerboseBurstFixtureOptions,
  sectionIndex: number,
): string[] {
  const lineWidth = options.lineWidth ?? 96;
  const sectionCount = Math.max(1, options.sectionCount);
  const payload = createVerboseBurstPayload(
    options.label,
    'agent-cli',
    sectionIndex,
    options.sectionBytes,
  );
  const progress = `${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(
    3,
    '0',
  )}`;
  const cliBlock = [
    `> ${options.label} task ${progress}`,
    `$ agent-cli --label ${options.label} --section ${String(sectionIndex + 1)}`,
    `status: scanning verbose output ${payload}`,
    `note: retaining live tail ${payload}`,
    `progress: ${progress} ${payload}`,
  ].join('\n');
  return wrapTextBlock(cliBlock, lineWidth);
}

function createVerboseBurstChunks(
  options: VerboseBurstFixtureOptions,
  buildSectionLines: (sectionIndex: number) => string[],
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let sectionIndex = 0; sectionIndex < options.sectionCount; sectionIndex += 1) {
    const lines = buildSectionLines(sectionIndex);
    for (const line of lines) {
      chunks.push(encoder.encode(`${line}\n`));
    }
    chunks.push(encoder.encode('\n'));
  }
  return chunks;
}

export function createMarkdownBurstChunks(options: VerboseBurstFixtureOptions): Uint8Array[] {
  return createVerboseBurstChunks(options, (sectionIndex) =>
    createMarkdownBurstLines(options, sectionIndex),
  );
}

export function createCodeBurstChunks(options: VerboseBurstFixtureOptions): Uint8Array[] {
  return createVerboseBurstChunks(options, (sectionIndex) =>
    createCodeBurstLines(options, sectionIndex),
  );
}

export function createDiffBurstChunks(options: VerboseBurstFixtureOptions): Uint8Array[] {
  return createVerboseBurstChunks(options, (sectionIndex) =>
    createDiffBurstLines(options, sectionIndex),
  );
}

export function createAgentCliBurstChunks(options: VerboseBurstFixtureOptions): Uint8Array[] {
  return createVerboseBurstChunks(options, (sectionIndex) =>
    createAgentCliBurstLines(options, sectionIndex),
  );
}
