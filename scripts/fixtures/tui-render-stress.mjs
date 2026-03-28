#!/usr/bin/env node
import { once } from 'node:events';

import {
  createRepeatedPayload,
  parseIntegerFlag,
  sleep,
  writeFrames,
  writeSection,
} from './tui-shared.mjs';

const mode = process.argv[2] ?? 'startup-buffer';
const lineCount = parseIntegerFlag(process.argv[3], 4_096);
const lineWidth = parseIntegerFlag(process.argv[4], 120);
const frameCount = parseIntegerFlag(process.argv[5], 240);
const frameDelayMs = parseIntegerFlag(process.argv[6], 24);
const settleMs = parseIntegerFlag(process.argv[7], 0);

let cleanedUp = false;
let renderTimer = null;

function createPaddedLine(text, width) {
  const clipped = text.slice(0, width);
  return `${clipped}${' '.repeat(Math.max(0, width - clipped.length))}`;
}

async function writeText(text) {
  if (process.stdout.write(text)) {
    return;
  }

  await once(process.stdout, 'drain');
}

async function writeLine(text) {
  await writeText(`${text}\r\n`);
}

function getTerminalSize() {
  return {
    columns: Math.max(20, process.stdout.columns ?? lineWidth),
    rows: Math.max(8, process.stdout.rows ?? 24),
  };
}

function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  if (renderTimer !== null) {
    globalThis.clearInterval(renderTimer);
    renderTimer = null;
  }

  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

process.on('exit', cleanup);

async function runStartupBufferMode() {
  writeSection('startup buffer fixture');

  const payload = createRepeatedPayload('startup-scrollback ', lineWidth);
  for (let index = 0; index < lineCount; index += 1) {
    await writeLine(`${String(index + 1).padStart(6, '0')} ${payload}`);
  }

  await writeLine('startup buffer fixture ready');

  if (settleMs > 0) {
    await sleep(settleMs);
  }

  renderTimer = globalThis.setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

async function runAdditiveBurstMode() {
  writeSection('additive burst fixture');

  const burstCount = Math.max(1, frameCount);
  const burstDelayMs = Math.max(0, frameDelayMs);
  const linesPerBurst = Math.max(1, Math.ceil(lineCount / burstCount));
  const payloadWidth = Math.max(1, lineWidth);
  let emittedLineCount = 0;

  for (
    let burstIndex = 0;
    burstIndex < burstCount && emittedLineCount < lineCount;
    burstIndex += 1
  ) {
    const remainingLineCount = lineCount - emittedLineCount;
    const burstLineCount = Math.min(linesPerBurst, remainingLineCount);
    const burstLines = [
      createPaddedLine(
        `additive-burst fixture | burst ${String(burstIndex + 1).padStart(4, '0')} of ${String(burstCount).padStart(4, '0')} | emitted ${String(emittedLineCount).padStart(6, '0')}/${String(lineCount).padStart(6, '0')}`,
        payloadWidth,
      ),
    ];

    for (let burstLineIndex = 0; burstLineIndex < burstLineCount; burstLineIndex += 1) {
      const lineNumber = emittedLineCount + 1;
      const payload = createRepeatedPayload(
        `additive ${String(burstIndex + 1).padStart(4, '0')} ${String(lineNumber).padStart(6, '0')} `,
        payloadWidth,
      );
      burstLines.push(`${String(lineNumber).padStart(6, '0')} ${payload}`);
      emittedLineCount += 1;
    }

    await writeFrames(burstLines, 0);

    if (burstDelayMs > 0) {
      await sleep(burstDelayMs);
    }
  }

  await writeLine('additive burst fixture ready');

  if (settleMs > 0) {
    await sleep(settleMs);
  }

  renderTimer = globalThis.setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

function getProgressRedrawRows() {
  const { columns, rows } = getTerminalSize();
  const progressRow = Math.max(3, Math.floor(rows / 2));
  const statusRow = Math.max(2, progressRow - 2);
  const footerRow = Math.min(rows - 1, progressRow + 2);
  return {
    columns,
    footerRow,
    progressRow,
    rows,
    statusRow,
  };
}

async function drawProgressRedrawFrame(frameIndex, totalFrames, clearScreen = false) {
  const { columns, footerRow, progressRow, rows, statusRow } = getProgressRedrawRows();
  const innerWidth = Math.max(8, columns - 4);
  const progressPercent = Math.min(
    100,
    Math.round((frameIndex / Math.max(1, totalFrames - 1)) * 100),
  );
  const statusLine = createPaddedLine(
    `progress redraw fixture | frame ${String(frameIndex).padStart(5, '0')} | ${columns}x${rows}`,
    innerWidth,
  );
  const progressLine = createPaddedLine(
    `progress redraw fixture | ${String(progressPercent).padStart(3, '0')}% complete`,
    innerWidth,
  );
  const footerLine = createPaddedLine(
    progressPercent < 100
      ? 'carriage-return progress redraw pressure'
      : 'carriage-return progress redraw complete',
    innerWidth,
  );

  if (clearScreen) {
    await writeText('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }

  await writeText(`\x1b[${statusRow};3H${statusLine}`);
  await writeText(`\x1b[${progressRow};1H\r\x1b[2K${progressLine}`);
  await writeText(`\x1b[${footerRow};3H${footerLine}`);
}

async function runProgressRedrawMode() {
  writeSection('progress redraw fixture');
  await writeLine('progress redraw fixture ready');
  await drawProgressRedrawFrame(0, Math.max(1, frameCount), true);

  let frameIndex = 0;
  renderTimer = globalThis.setInterval(() => {
    frameIndex += 1;
    void drawProgressRedrawFrame(frameIndex, Math.max(1, frameCount), false);
  }, frameDelayMs);

  await new Promise(() => {});
}

function buildResizeFrame(frameIndex, resizeCount) {
  const { columns, rows } = getTerminalSize();
  const innerWidth = Math.max(1, columns - 2);
  const contentWidth = Math.max(1, columns - 4);
  const bodyRows = Math.max(0, rows - 4);
  const token = createRepeatedPayload(frameIndex % 2 === 0 ? 'alpha ' : 'beta ', contentWidth);

  const lines = [];
  lines.push(`+${'-'.repeat(innerWidth)}+`);
  lines.push(
    `|${createPaddedLine(
      `resize-flicker fixture | frame ${String(frameIndex).padStart(6, '0')} | resize ${String(resizeCount).padStart(4, '0')}`,
      innerWidth,
    )}|`,
  );
  lines.push(
    `|${createPaddedLine(`viewport ${columns}x${rows} | alternate-screen redraw stress`, innerWidth)}|`,
  );

  for (let rowIndex = 0; rowIndex < bodyRows; rowIndex += 1) {
    const rowToken = createRepeatedPayload(
      `${String(rowIndex + 1).padStart(3, '0')} ${token}`,
      contentWidth,
    );
    lines.push(`| ${createPaddedLine(rowToken, contentWidth)} |`);
  }

  lines.push(`+${'-'.repeat(innerWidth)}+`);
  return lines;
}

async function renderResizeFrame(frameIndex, resizeCount, clearScreen = false) {
  const prefix = clearScreen ? '\x1b[H\x1b[2J' : '\x1b[H';
  await writeText(prefix);
  await writeText(buildResizeFrame(frameIndex, resizeCount).join('\r\n'));
}

async function runResizeFlickerMode() {
  writeSection('resize flicker fixture');
  await writeText('\x1b[?1049h\x1b[?25l');

  let frameIndex = 0;
  let resizeCount = 0;
  let renderScheduled = false;

  const renderNow = async (clearScreen = false) => {
    renderScheduled = false;
    await renderResizeFrame(frameIndex, resizeCount, clearScreen);
  };

  const scheduleRender = (clearScreen = false) => {
    if (renderScheduled) {
      return;
    }

    renderScheduled = true;
    void Promise.resolve().then(() => renderNow(clearScreen));
  };

  process.stdout.on('resize', () => {
    resizeCount += 1;
    scheduleRender(true);
  });

  await renderResizeFrame(frameIndex, resizeCount, true);

  renderTimer = globalThis.setInterval(() => {
    frameIndex += 1;
    void renderResizeFrame(frameIndex, resizeCount, frameIndex % Math.max(1, frameCount) === 0);
  }, frameDelayMs);

  await new Promise(() => {});
}

function getControlRedrawRows() {
  const { columns, rows } = getTerminalSize();
  const inputRow = Math.max(4, Math.floor(rows / 2));
  const statusRow = Math.max(2, inputRow - 2);
  const footerRow = Math.max(inputRow + 2, rows - 1);
  const promptColumn = Math.max(3, Math.min(12, Math.floor(columns / 6)));
  return {
    columns,
    footerRow,
    inputRow,
    promptColumn,
    rows,
    statusRow,
  };
}

async function drawControlRedrawFrame(frameIndex, clearScreen = false) {
  const { columns, footerRow, inputRow, promptColumn, rows, statusRow } = getControlRedrawRows();
  const innerWidth = Math.max(8, columns - 4);
  const bodyToken = createRepeatedPayload(
    frameIndex % 2 === 0 ? 'control-redraw alpha ' : 'control-redraw beta ',
    Math.max(1, innerWidth),
  );
  const statusLine = createPaddedLine(
    `control-redraw fixture | frame ${String(frameIndex).padStart(5, '0')} | ${columns}x${rows}`,
    innerWidth,
  );
  const footerLine = createPaddedLine(
    `${frameIndex % 2 === 0 ? 'syncing panes' : 'watching cursor stability'} | save/restore redraw pressure`,
    innerWidth,
  );

  if (clearScreen) {
    await writeText('\x1b[H\x1b[2J');
    for (let row = 1; row <= rows; row += 1) {
      await writeText(`\x1b[${row};1H\x1b[2K`);
    }
    await writeText(`\x1b[${statusRow};3H${statusLine}`);
    await writeText(`\x1b[${inputRow - 1};3H${createPaddedLine(bodyToken, innerWidth)}`);
    await writeText(`\x1b[${inputRow};${promptColumn}Hinput> rrrrw`);
    await writeText(`\x1b[${inputRow + 1};3H${createPaddedLine(bodyToken, innerWidth)}`);
  }

  await writeText('\x1b[s');
  await writeText(`\x1b[${statusRow};1H\x1b[2K`);
  await writeText(`\x1b[${statusRow};3H${statusLine}`);
  await writeText(`\x1b[${footerRow};1H\x1b[2K`);
  await writeText(`\x1b[${footerRow};3H${footerLine}`);
  await writeText(`\x1b[${inputRow + 1};1H\x1b[2K`);
  await writeText(
    `\x1b[${inputRow + 1};3H${createPaddedLine(
      `${bodyToken.slice(0, Math.max(1, innerWidth - 18))} | frame ${String(frameIndex).padStart(5, '0')}`,
      innerWidth,
    )}`,
  );
  await writeText('\x1b[u');
}

function getPromptMiddleRows() {
  const { columns, rows } = getTerminalSize();
  const promptRow = Math.max(4, Math.floor(rows / 2));
  const statusRow = Math.max(2, promptRow - 2);
  const footerRow = Math.max(promptRow + 2, rows - 1);
  const promptColumn = Math.max(3, Math.min(12, Math.floor(columns / 6)));
  return {
    columns,
    footerRow,
    promptColumn,
    promptRow,
    rows,
    statusRow,
  };
}

async function drawPromptMiddleFrame(frameIndex, clearScreen = false) {
  const { columns, footerRow, promptColumn, promptRow, rows, statusRow } = getPromptMiddleRows();
  const innerWidth = Math.max(10, columns - 4);
  const bodyToken = createRepeatedPayload(
    frameIndex % 2 === 0 ? 'prompt-middle alpha ' : 'prompt-middle beta ',
    innerWidth,
  );
  const promptLine = createPaddedLine(
    `input> ${bodyToken.slice(0, Math.max(1, innerWidth - 7))}`,
    innerWidth,
  );
  const statusLine = createPaddedLine(
    `prompt middle fixture | frame ${String(frameIndex).padStart(5, '0')} | ${columns}x${rows}`,
    innerWidth,
  );
  const footerLine = createPaddedLine(
    'prompt in the middle of the screen | cursor-position redraw pressure',
    innerWidth,
  );

  if (clearScreen) {
    await writeText('\x1b[?1049h\x1b[?25h\x1b[H\x1b[2J');
  }

  await writeText('\x1b[s');
  await writeText(`\x1b[${statusRow};3H${statusLine}`);
  await writeText(`\x1b[${promptRow};${promptColumn}H${promptLine}`);
  await writeText(`\x1b[${footerRow};3H${footerLine}`);
  await writeText('\x1b[u');
}

async function runPromptMiddleMode() {
  writeSection('prompt middle fixture');
  await writeLine('prompt middle fixture ready');
  await drawPromptMiddleFrame(0, true);

  let frameIndex = 0;
  renderTimer = globalThis.setInterval(() => {
    frameIndex += 1;
    void drawPromptMiddleFrame(frameIndex, false);
  }, frameDelayMs);

  await new Promise(() => {});
}

function getSaveRestoreResizeRows() {
  const { columns, rows } = getTerminalSize();
  const promptRow = Math.max(4, Math.floor(rows / 2));
  const statusRow = Math.max(2, promptRow - 2);
  const footerRow = Math.max(promptRow + 2, rows - 1);
  const promptColumn = Math.max(3, Math.min(12, Math.floor(columns / 5)));
  return {
    columns,
    footerRow,
    promptColumn,
    promptRow,
    rows,
    statusRow,
  };
}

async function drawSaveRestoreResizeFrame(frameIndex, resizeCount, clearScreen = false) {
  const { columns, footerRow, promptColumn, promptRow, rows, statusRow } =
    getSaveRestoreResizeRows();
  const innerWidth = Math.max(10, columns - 4);
  const bodyToken = createRepeatedPayload(
    frameIndex % 2 === 0 ? 'resize-friendly alpha ' : 'resize-friendly beta ',
    innerWidth,
  );
  const promptLine = createPaddedLine(
    `input> ${bodyToken.slice(0, Math.max(1, innerWidth - 7))}`,
    innerWidth,
  );
  const statusLine = createPaddedLine(
    `save-restore resize fixture | frame ${String(frameIndex).padStart(5, '0')} | resize ${String(resizeCount).padStart(4, '0')} | ${columns}x${rows}`,
    innerWidth,
  );
  const footerLine = createPaddedLine(
    'save/restore cursor redraw | resize-friendly terminal repaint',
    innerWidth,
  );

  if (clearScreen) {
    await writeText('\x1b[H\x1b[2J');
  }

  await writeText('\x1b[s');
  await writeText(`\x1b[${statusRow};1H\x1b[2K`);
  await writeText(`\x1b[${statusRow};3H${statusLine}`);
  await writeText(`\x1b[${promptRow};1H\x1b[2K`);
  await writeText(`\x1b[${promptRow};${promptColumn}H${promptLine}`);
  await writeText(`\x1b[${footerRow};1H\x1b[2K`);
  await writeText(`\x1b[${footerRow};3H${footerLine}`);
  await writeText('\x1b[u');
}

async function runSaveRestoreResizeMode() {
  writeSection('save-restore resize fixture');
  await writeLine('save-restore resize fixture ready');
  await writeText('\x1b[?1049h\x1b[?25h');

  let frameIndex = 0;
  let resizeCount = 0;
  let renderScheduled = false;

  const renderNow = async (clearScreen = false) => {
    renderScheduled = false;
    await drawSaveRestoreResizeFrame(frameIndex, resizeCount, clearScreen);
  };

  const scheduleRender = (clearScreen = false) => {
    if (renderScheduled) {
      return;
    }

    renderScheduled = true;
    void Promise.resolve().then(() => renderNow(clearScreen));
  };

  process.stdout.on('resize', () => {
    resizeCount += 1;
    scheduleRender(true);
  });

  await drawSaveRestoreResizeFrame(frameIndex, resizeCount, true);

  renderTimer = globalThis.setInterval(() => {
    frameIndex += 1;
    void drawSaveRestoreResizeFrame(
      frameIndex,
      resizeCount,
      frameIndex % Math.max(1, frameCount) === 0,
    );
  }, frameDelayMs);

  await new Promise(() => {});
}

async function runControlRedrawMode() {
  await writeLine('control redraw fixture ready');
  await writeText('\x1b[?1049h\x1b[?25h');
  await drawControlRedrawFrame(0, true);

  let frameIndex = 0;
  renderTimer = globalThis.setInterval(() => {
    frameIndex += 1;
    void drawControlRedrawFrame(frameIndex, frameIndex % Math.max(1, frameCount) === 0);
  }, frameDelayMs);

  await new Promise(() => {});
}

switch (mode) {
  case 'additive-burst':
    await runAdditiveBurstMode();
    break;
  case 'control-heavy':
  case 'control-redraw':
    await runControlRedrawMode();
    break;
  case 'progress-redraw':
    await runProgressRedrawMode();
    break;
  case 'resize-flicker':
    await runResizeFlickerMode();
    break;
  case 'prompt-middle':
    await runPromptMiddleMode();
    break;
  case 'save-restore-resize':
    await runSaveRestoreResizeMode();
    break;
  case 'startup-buffer':
    await runStartupBufferMode();
    break;
  default:
    throw new Error(`Unknown terminal render stress mode: ${mode}`);
}
