#!/usr/bin/env node
import {
  createRepeatedPayload,
  parseIntegerFlag,
  writeFrames,
  writeSection,
} from './tui-shared.mjs';

const repeatCount = parseIntegerFlag(process.argv[2], 2);
const lineWidth = parseIntegerFlag(process.argv[3], 160);
const wrapLine = createRepeatedPayload('wrap-check ', lineWidth);

writeSection('wrap fixture');
await writeFrames(
  Array.from({ length: repeatCount }, (_, index) => `${index + 1}: ${wrapLine}`),
  8,
);
process.stdout.write('\r\nwrap fixture ready\r\n');
