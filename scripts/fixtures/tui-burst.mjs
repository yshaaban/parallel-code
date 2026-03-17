#!/usr/bin/env node
import { createRepeatedPayload, parseIntegerFlag, writeSection } from './tui-shared.mjs';

const lineCount = parseIntegerFlag(process.argv[2], 400);
const lineWidth = parseIntegerFlag(process.argv[3], 120);
const payload = createRepeatedPayload('burst ', lineWidth);

writeSection('burst fixture');
for (let index = 0; index < lineCount; index += 1) {
  process.stdout.write(`${String(index + 1).padStart(4, '0')} ${payload}\r\n`);
}
process.stdout.write('burst fixture ready\r\n');
