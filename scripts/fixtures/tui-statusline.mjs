#!/usr/bin/env node
import { parseIntegerFlag, sleep, writeSection, writeStatusLine } from './tui-shared.mjs';

const frameCount = parseIntegerFlag(process.argv[2], 80);
const delayMs = parseIntegerFlag(process.argv[3], 40);

writeSection('status line fixture');
for (let frame = 0; frame < frameCount; frame += 1) {
  writeStatusLine(`status ${String(frame + 1).padStart(3, '0')} / ${frameCount} · redraw test`);
  await sleep(delayMs);
}
process.stdout.write('\r\nstatus line fixture ready\r\n');
