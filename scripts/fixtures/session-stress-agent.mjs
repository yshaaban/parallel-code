#!/usr/bin/env node

import { access } from 'node:fs/promises';

const CONTROL_PREFIX = '__SESSION_STRESS_CTL__';
const READY_MARKER = process.env.STRESS_READY_MARKER || '';
let stdinBuffer = '';
let outputInFlight = false;
const cliWorkload = parseCliWorkload(process.argv.slice(2));

process.stdin.setEncoding('utf8');

if (READY_MARKER) {
  process.stdout.write(`${READY_MARKER}\n`);
}

process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  flushBuffer();
});

process.stdin.resume();

if (cliWorkload) {
  startWorkload(cliWorkload);
}

function flushBuffer() {
  let newlineIndex = stdinBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    handleLine(line);
    newlineIndex = stdinBuffer.indexOf('\n');
  }
}

function handleLine(line) {
  if (line.startsWith(CONTROL_PREFIX)) {
    handleControl(line.slice(CONTROL_PREFIX.length));
    return;
  }

  process.stdout.write(`${line}\n`);
}

function handleControl(serializedCommand) {
  let command;
  try {
    command = JSON.parse(serializedCommand);
  } catch {
    return;
  }

  if (command?.type !== 'start-output' && command?.type !== 'start-workload') {
    return;
  }

  startWorkload(command);
}

function getFiniteNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function getNonNegativeInteger(value, fallback) {
  return Math.max(0, Math.floor(getFiniteNumber(value, fallback)));
}

function getPositiveInteger(value, fallback) {
  return Math.max(1, Math.floor(getFiniteNumber(value, fallback)));
}

function parseCliWorkload(argv) {
  if (argv.length === 0) {
    return null;
  }

  const command = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--style':
        command.style = typeof next === 'string' ? next : 'lines';
        index += 1;
        break;
      case '--label':
        command.label = typeof next === 'string' ? next : 'stress-output';
        index += 1;
        break;
      case '--line-count':
        command.lineCount = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--line-bytes':
        command.lineBytes = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--paragraph-count':
        command.paragraphCount = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--paragraph-bytes':
        command.paragraphBytes = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--line-width':
        command.lineWidth = getPositiveInteger(next, 96);
        index += 1;
        break;
      case '--frame-count':
        command.frameCount = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--frame-delay-ms':
        command.frameDelayMs = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--chunk-delay-ms':
        command.chunkDelayMs = getNonNegativeInteger(next, 0);
        index += 1;
        break;
      case '--footer-top-row':
        command.footerTopRow = getPositiveInteger(next, 20);
        index += 1;
        break;
      case '--done-marker':
        command.doneMarker = typeof next === 'string' ? next : '';
        index += 1;
        break;
      case '--ready-marker':
        command.readyMarker = typeof next === 'string' ? next : '';
        index += 1;
        break;
      case '--start-gate-file':
        command.startGateFile = typeof next === 'string' ? next : '';
        index += 1;
        break;
      default:
        break;
    }
  }

  return typeof command.style === 'string' ? command : null;
}

function createRepeatedPayload(token, width) {
  const minimumWidth = Math.max(1, width);
  const repeatCount = Math.max(1, Math.ceil(minimumWidth / token.length));
  return token.repeat(repeatCount).slice(0, minimumWidth);
}

function createParagraphLines(label, paragraphIndex, paragraphCount, paragraphBytes, lineWidth) {
  const header = `${label} ${String(paragraphIndex + 1).padStart(3, '0')}/${String(
    paragraphCount,
  ).padStart(3, '0')} `;
  const payload = createRepeatedPayload(
    `${label}:steady-state verbose payload ${paragraphIndex + 1} `,
    Math.max(1, paragraphBytes),
  );
  const block = `${header}${payload}`;
  const lines = [];
  for (let offset = 0; offset < block.length; offset += lineWidth) {
    lines.push(block.slice(offset, offset + lineWidth));
  }
  return lines;
}

function createLabelSlug(label) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'verbose-burst';
}

function createIdentifierName(label) {
  const identifier = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return identifier.length > 0 ? identifier : 'verbose_burst';
}

function createPascalLabel(label) {
  return createLabelSlug(label)
    .split('-')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function wrapLine(text, lineWidth) {
  const wrappedLines = [];
  for (let offset = 0; offset < text.length; offset += lineWidth) {
    wrappedLines.push(text.slice(offset, offset + lineWidth));
  }
  return wrappedLines.length > 0 ? wrappedLines : [''];
}

function wrapTextBlock(block, lineWidth) {
  const wrappedLines = [];
  for (const line of block.split('\n')) {
    wrappedLines.push(...wrapLine(line, lineWidth));
  }
  return wrappedLines;
}

function createVerboseBurstPayload(label, burstLabel, sectionIndex, sectionBytes) {
  return createRepeatedPayload(
    `${label}:${burstLabel}:${String(sectionIndex + 1).padStart(3, '0')} `,
    Math.max(1, sectionBytes),
  );
}

function getVerboseBurstSectionCount(command) {
  return getNonNegativeInteger(command.paragraphCount, command.lineCount ?? 0);
}

function getVerboseBurstSectionBytes(command) {
  return getNonNegativeInteger(command.paragraphBytes, command.lineBytes ?? 0);
}

function getVerboseBurstLineWidth(command) {
  return getPositiveInteger(command.lineWidth, 96);
}

function emitMarkdownBurst(command) {
  const sectionCount = getVerboseBurstSectionCount(command);
  const sectionBytes = getVerboseBurstSectionBytes(command);
  const lineWidth = getVerboseBurstLineWidth(command);
  const label = typeof command.label === 'string' ? command.label : 'markdown-burst';

  const chunks = [];
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const payload = createVerboseBurstPayload(label, 'markdown', sectionIndex, sectionBytes);
    const block = [
      `# ${label} incident ${String(sectionIndex + 1).padStart(3, '0')}/${String(
        sectionCount,
      ).padStart(3, '0')}`,
      '',
      `- summary: ${payload}`,
      `- action: ${payload}`,
      '',
      '```md',
      `${label} · ${payload}`,
      '```',
    ].join('\n');
    chunks.push(...wrapTextBlock(block, lineWidth));
    chunks.push('');
  }

  return chunks;
}

function emitCodeBurst(command) {
  const sectionCount = getVerboseBurstSectionCount(command);
  const sectionBytes = getVerboseBurstSectionBytes(command);
  const lineWidth = getVerboseBurstLineWidth(command);
  const label = typeof command.label === 'string' ? command.label : 'code-burst';
  const identifier = createIdentifierName(label);
  const pascal = createPascalLabel(label);
  const chunks = [];

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const payload = createVerboseBurstPayload(label, 'code', sectionIndex, sectionBytes);
    const progress = `${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(
      3,
      '0',
    )}`;
    const block = [
      `function ${identifier}Section${String(sectionIndex + 1).padStart(3, '0')}() {`,
      `  const payload = ${JSON.stringify(payload)};`,
      `  const progress = ${JSON.stringify(progress)};`,
      '  return `${progress} ${payload}`;',
      '}',
      '',
      `class ${pascal}Reporter {`,
      '  summarize() {',
      '    return payload.length;',
      '  }',
      '}',
    ].join('\n');
    chunks.push(...wrapTextBlock(block, lineWidth));
    chunks.push('');
  }

  return chunks;
}

function emitDiffBurst(command) {
  const sectionCount = getVerboseBurstSectionCount(command);
  const sectionBytes = getVerboseBurstSectionBytes(command);
  const lineWidth = getVerboseBurstLineWidth(command);
  const label = typeof command.label === 'string' ? command.label : 'diff-burst';
  const slug = createLabelSlug(label);
  const chunks = [];

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const payload = createVerboseBurstPayload(label, 'diff', sectionIndex, sectionBytes);
    const hunkStart = sectionIndex * 4 + 1;
    const block = [
      `diff --git a/${slug}.txt b/${slug}.txt`,
      'index 0000000..1111111 100644',
      `--- a/${slug}.txt`,
      `+++ b/${slug}.txt`,
      `@@ -${hunkStart},4 +${hunkStart},4 @@`,
      `- stale ${payload}`,
      `+ fresh ${payload}`,
      `  ${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(3, '0')} ${payload}`,
    ].join('\n');
    chunks.push(...wrapTextBlock(block, lineWidth));
    chunks.push('');
  }

  return chunks;
}

function emitAgentCliBurst(command) {
  const sectionCount = getVerboseBurstSectionCount(command);
  const sectionBytes = getVerboseBurstSectionBytes(command);
  const lineWidth = getVerboseBurstLineWidth(command);
  const label = typeof command.label === 'string' ? command.label : 'agent-cli-burst';
  const chunks = [];

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const payload = createVerboseBurstPayload(label, 'agent-cli', sectionIndex, sectionBytes);
    const progress = `${String(sectionIndex + 1).padStart(3, '0')}/${String(sectionCount).padStart(
      3,
      '0',
    )}`;
    const block = [
      `> ${label} task ${progress}`,
      `$ agent-cli --label ${label} --section ${String(sectionIndex + 1)}`,
      `status: scanning verbose output ${payload}`,
      `note: retaining live tail ${payload}`,
      `progress: ${progress} ${payload}`,
    ].join('\n');
    chunks.push(...wrapTextBlock(block, lineWidth));
    chunks.push('');
  }

  return chunks;
}

async function emitChunkedWorkload(command, buildChunks) {
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';

  writeReadyMarker(readyMarker);
  for (const chunk of buildChunks(command)) {
    if (chunk === '') {
      process.stdout.write('\n');
    } else {
      process.stdout.write(`${chunk}\n`);
    }
    if (typeof command.chunkDelayMs === 'number' && command.chunkDelayMs > 0) {
      await delay(command.chunkDelayMs);
    }
  }
  writeDoneMarker(doneMarker);
}

function buildStatusFrame(frameIndex, frameCount, footerTopRow, label) {
  const spinnerFrames = ['-', '\\', '|', '/'];
  const spinner = spinnerFrames[frameIndex % spinnerFrames.length];
  const progress = `${String(frameIndex + 1).padStart(3, '0')}/${String(frameCount).padStart(3, '0')}`;
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

function writeDoneMarker(doneMarker) {
  if (doneMarker) {
    process.stdout.write(`${doneMarker}\n`);
  }
}

function writeReadyMarker(readyMarker) {
  if (readyMarker) {
    process.stdout.write(`${readyMarker}\n`);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForStartGate(startGateFile) {
  while (true) {
    try {
      await access(startGateFile);
      return;
    } catch {
      await delay(20);
    }
  }
}

function yieldOnce() {
  return new Promise((resolve) => {
    globalThis.setImmediate(resolve);
  });
}

async function emitLineSpam(command) {
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';
  const lineBytes = getNonNegativeInteger(command.lineBytes, 0);
  const lineCount = getNonNegativeInteger(command.lineCount, 0);
  const prefix = typeof command.prefix === 'string' ? command.prefix : 'stress-output';
  const payload = lineBytes > 0 ? 'X'.repeat(lineBytes) : '';

  writeReadyMarker(readyMarker);

  for (let emitted = 0; emitted < lineCount; emitted += 1) {
    const sequence = emitted + 1;
    process.stdout.write(`${prefix}:${sequence}:${payload}\n`);
    await yieldOnce();
  }

  writeDoneMarker(doneMarker);
}

async function emitBulkText(command) {
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';
  const paragraphCount = getNonNegativeInteger(command.paragraphCount, command.lineCount ?? 0);
  const paragraphBytes = getNonNegativeInteger(command.paragraphBytes, command.lineBytes ?? 0);
  const lineWidth = getPositiveInteger(command.lineWidth, 96);
  const label = typeof command.label === 'string' ? command.label : 'bulk-text';

  writeReadyMarker(readyMarker);

  for (let paragraphIndex = 0; paragraphIndex < paragraphCount; paragraphIndex += 1) {
    const lines = createParagraphLines(
      label,
      paragraphIndex,
      paragraphCount,
      paragraphBytes,
      lineWidth,
    );
    for (const line of lines) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write('\n');
    await yieldOnce();
  }

  writeDoneMarker(doneMarker);
}

async function emitStatusline(command) {
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';
  const frameCount = getNonNegativeInteger(command.frameCount, 0);
  const frameDelayMs = getNonNegativeInteger(command.frameDelayMs, 0);
  const chunkDelayMs = getNonNegativeInteger(command.chunkDelayMs, 0);
  const footerTopRow = getPositiveInteger(command.footerTopRow, 20);
  const label = typeof command.label === 'string' ? command.label : 'steady verbose';

  writeReadyMarker(readyMarker);
  process.stdout.write(`${label} statusline warmup\n`);
  process.stdout.write('statusline fixture ready\n');

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (const segment of buildStatusFrame(frameIndex, frameCount, footerTopRow, label)) {
      process.stdout.write(segment);
      if (chunkDelayMs > 0) {
        await delay(chunkDelayMs);
      }
    }

    if (frameDelayMs > 0) {
      await delay(frameDelayMs);
    }
  }

  process.stdout.write('\n');
  writeDoneMarker(doneMarker);
}

async function emitMixed(command) {
  const doneMarker = typeof command.doneMarker === 'string' ? command.doneMarker : '';
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';
  const paragraphCount = getNonNegativeInteger(command.paragraphCount, command.lineCount ?? 0);
  const paragraphBytes = getNonNegativeInteger(command.paragraphBytes, command.lineBytes ?? 0);
  const lineWidth = getPositiveInteger(command.lineWidth, 96);
  const frameCount = getNonNegativeInteger(command.frameCount, 0);
  const frameDelayMs = getNonNegativeInteger(command.frameDelayMs, 0);
  const chunkDelayMs = getNonNegativeInteger(command.chunkDelayMs, 0);
  const footerTopRow = getPositiveInteger(command.footerTopRow, 20);
  const label = typeof command.label === 'string' ? command.label : 'mixed';

  writeReadyMarker(readyMarker);
  let paragraphIndex = 0;
  let frameIndex = 0;

  while (paragraphIndex < paragraphCount || frameIndex < frameCount) {
    if (paragraphIndex < paragraphCount) {
      const lines = createParagraphLines(
        `${label}:bulk`,
        paragraphIndex,
        paragraphCount,
        paragraphBytes,
        lineWidth,
      );
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
      }
      process.stdout.write('\n');
      paragraphIndex += 1;
      await yieldOnce();
    }

    if (frameIndex < frameCount) {
      for (const segment of buildStatusFrame(
        frameIndex,
        frameCount,
        footerTopRow,
        `${label}:tui`,
      )) {
        process.stdout.write(segment);
        if (chunkDelayMs > 0) {
          await delay(chunkDelayMs);
        }
      }
      if (frameDelayMs > 0) {
        await delay(frameDelayMs);
      }
      frameIndex += 1;
    }
  }

  writeDoneMarker(doneMarker);
}

function startWorkload(command) {
  if (outputInFlight) {
    return;
  }

  outputInFlight = true;

  const style = typeof command.style === 'string' ? command.style : 'lines';
  let run;
  switch (style) {
    case 'bulk-text':
      run = emitBulkText;
      break;
    case 'statusline':
      run = emitStatusline;
      break;
    case 'mixed':
      run = emitMixed;
      break;
    case 'markdown-burst':
    case 'markdown':
      run = (commandToRun) => emitChunkedWorkload(commandToRun, emitMarkdownBurst);
      break;
    case 'code-burst':
    case 'code':
      run = (commandToRun) => emitChunkedWorkload(commandToRun, emitCodeBurst);
      break;
    case 'diff-burst':
    case 'diff':
      run = (commandToRun) => emitChunkedWorkload(commandToRun, emitDiffBurst);
      break;
    case 'agent-cli-burst':
    case 'agent-cli':
      run = (commandToRun) => emitChunkedWorkload(commandToRun, emitAgentCliBurst);
      break;
    default:
      run = emitLineSpam;
      break;
  }

  const startGateFile =
    typeof command.startGateFile === 'string' && command.startGateFile.length > 0
      ? command.startGateFile
      : null;
  const readyMarker = typeof command.readyMarker === 'string' ? command.readyMarker : '';

  Promise.resolve(
    (async () => {
      if (startGateFile) {
        writeReadyMarker(readyMarker);
        await waitForStartGate(startGateFile);
        const gatedCommand = { ...command, readyMarker: '' };
        switch (style) {
          case 'bulk-text':
          case 'statusline':
          case 'mixed':
          case 'markdown-burst':
          case 'markdown':
          case 'code-burst':
          case 'code':
          case 'diff-burst':
          case 'diff':
          case 'agent-cli-burst':
          case 'agent-cli':
          default:
            await run(gatedCommand);
            break;
        }
        return;
      }

      await run(command);
    })(),
  ).finally(() => {
    outputInFlight = false;
  });
}
