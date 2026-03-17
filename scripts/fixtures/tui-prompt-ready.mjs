#!/usr/bin/env node
import { parseIntegerFlag, writeFrames, writeSection } from './tui-shared.mjs';

const delayMs = parseIntegerFlag(process.argv[2], 300);

writeSection('prompt-ready fixture');
await writeFrames(['warming renderer...', 'measuring viewport...', 'settling prompt...'], delayMs);
process.stdout.write('\r\nfixture> ');
