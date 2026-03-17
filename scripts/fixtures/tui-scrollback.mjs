#!/usr/bin/env node
import { createRepeatedPayload, parseIntegerFlag, writeSection } from './tui-shared.mjs';

const lineCount = parseIntegerFlag(process.argv[2], 1200);
const lineWidth = parseIntegerFlag(process.argv[3], 100);
const payload = createRepeatedPayload('scrollback ', lineWidth);

writeSection('scrollback fixture');
for (let index = 0; index < lineCount; index += 1) {
  process.stdout.write(`${String(index + 1).padStart(5, '0')} ${payload}\r\n`);
}
process.stdout.write('scrollback fixture ready\r\n');
