#!/usr/bin/env node
import { writeFrames, writeSection } from './tui-shared.mjs';

writeSection('wide character fixture');
await writeFrames(
  [
    'emoji: 😀 😁 😂 🤖 🚀',
    'cjk: 你好 世界 終端 測試',
    'combining: Å é ñ ö ū',
    'mixed width: [表] [A] [🤖] [é]',
  ],
  12,
);
process.stdout.write('\r\nwide character fixture ready\r\n');
