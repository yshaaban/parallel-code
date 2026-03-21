#!/usr/bin/env node
import { parseIntegerFlag, sleep, writeSection } from './tui-shared.mjs';

const frameCount = parseIntegerFlag(process.argv[2], 96);
const frameDelayMs = parseIntegerFlag(process.argv[3], 18);
const chunkDelayMs = parseIntegerFlag(process.argv[4], 1);
const mode = process.argv[5] === 'combined' ? 'combined' : 'split';
const footerTopRow = parseIntegerFlag(process.argv[6], 20);
const spinnerFrames = ['-', '\\', '|', '/'];

function buildFooterFrame(frame, totalFrames) {
  const spinner = spinnerFrames[frame % spinnerFrames.length];
  const progress = String(frame + 1).padStart(3, '0') + '/' + String(totalFrames).padStart(3, '0');
  return [
    '\x1b[s',
    `\x1b[${footerTopRow};1H`,
    '\x1b[2K',
    ` ${spinner} scan ${progress} · redraw fixture`,
    `\x1b[${footerTopRow + 1};1H`,
    '\x1b[2K',
    ` waiting for terminal pacing evidence`,
    '\x1b[u',
  ];
}

async function writeSplitFrame(segments) {
  for (const segment of segments) {
    process.stdout.write(segment);
    if (chunkDelayMs > 0) {
      await sleep(chunkDelayMs);
    }
  }
}

function writeCombinedFrame(segments) {
  process.stdout.write(segments.join(''));
}

writeSection('footer redraw fixture');
for (let index = 0; index < 14; index += 1) {
  process.stdout.write(`warmup line ${String(index + 1).padStart(2, '0')}\r\n`);
}
process.stdout.write('fixture> ');

for (let frame = 0; frame < frameCount; frame += 1) {
  const segments = buildFooterFrame(frame, frameCount);
  if (mode === 'combined') {
    writeCombinedFrame(segments);
  } else {
    await writeSplitFrame(segments);
  }

  if (frameDelayMs > 0) {
    await sleep(frameDelayMs);
  }
}

process.stdout.write('\r\nfooter redraw fixture complete\r\n');
