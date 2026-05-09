#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runCommand } from './lib/run-command.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_ELECTRON_DIR = path.join(PROJECT_ROOT, 'dist-electron');

function runTypeScriptElectronBuild() {
  return runCommand('npx', ['tsc', '-p', 'electron/tsconfig.json'], { cwd: PROJECT_ROOT });
}

async function main() {
  await rm(DIST_ELECTRON_DIR, { force: true, recursive: true });

  const result = await runTypeScriptElectronBuild();
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exitCode = result.code;
}

await main();
