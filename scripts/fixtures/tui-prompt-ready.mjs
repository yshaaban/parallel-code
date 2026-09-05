#!/usr/bin/env node
import { parseIntegerFlag, writeFrames, writeSection } from './tui-shared.mjs';

const delayMs = parseIntegerFlag(process.argv[2], 300);
const persistent = process.argv.includes('--persistent');

function writeReadyPrompt() {
  process.stdout.write('\r\n❯ ');
}

writeSection('prompt-ready fixture');
await writeFrames(['warming renderer...', 'measuring viewport...', 'settling prompt...'], delayMs);
// Keep this fixture on the same conservative prompt grammar used by production
// supervision and managed initial-prompt delivery. An arbitrary `word>` marker
// looks prompt-like to a person but is intentionally not trusted for byte
// admission.
writeReadyPrompt();

// Most browser-lab scenarios need only a deterministic startup frame and may
// let this process exit. Managed initial-prompt proof needs the prompt to stay
// live through the production 1.5 s quiescence window. Each complete input
// line redraws the prompt so supervision observes post-write activity; the PTY
// echo still supplies exact prompt-text evidence.
if (persistent) {
  let previousDelimiterWasCarriageReturn = false;
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    for (const character of chunk) {
      if (character === '\n' && previousDelimiterWasCarriageReturn) {
        previousDelimiterWasCarriageReturn = false;
        continue;
      }
      if (character === '\r' || character === '\n') {
        previousDelimiterWasCarriageReturn = character === '\r';
        writeReadyPrompt();
        continue;
      }
      previousDelimiterWasCarriageReturn = false;
    }
  });
}
