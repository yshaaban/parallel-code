#!/usr/bin/env node

let inputBuffer = '';
let questionActive = false;

function writeReadyPrompt(message = 'ready for prompt input') {
  // Use the same conservative prompt evidence as production agents. An
  // arbitrary `word>` marker looks prompt-like to a person but is
  // intentionally not trusted to clear question state or authorize input.
  process.stdout.write(`\r\n${message}\r\n\u001b[2J\u001b[H❯ `);
}

function writeQuestion() {
  questionActive = true;
  process.stdout.write('\r\nWould you like to continue? [Y/n]');
}

function handleCommand(command) {
  if (command === 'question') {
    writeQuestion();
    return;
  }

  if (questionActive) {
    questionActive = false;
    writeReadyPrompt('answer accepted');
    return;
  }

  writeReadyPrompt(command ? `received ${command}` : 'ready for prompt input');
}

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  for (const character of chunk) {
    if (character === '\u0003') {
      process.exit(0);
    }
    if (character === '\u007f') {
      inputBuffer = inputBuffer.slice(0, -1);
      continue;
    }
    if (character === '\r' || character === '\n') {
      const command = inputBuffer.trim();
      inputBuffer = '';
      handleCommand(command);
      continue;
    }

    inputBuffer += character;
  }
});

process.stdout.write('prompt-question fixture\r\nfixture> ');
