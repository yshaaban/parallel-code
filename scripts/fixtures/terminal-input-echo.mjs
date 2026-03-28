process.stdin.setEncoding('utf8');

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdout.write('echo-ready\r\n');
process.stdin.resume();

process.stdin.on('data', (chunk) => {
  if (chunk.includes('\u0003')) {
    process.exit(0);
  }

  process.stdout.write(chunk);
});
