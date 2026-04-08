#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

import { rewriteDistServerRelativeImports } from './rewrite-dist-server-relative-imports.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_SERVER_DIR = path.join(PROJECT_ROOT, 'dist-server');

function getCommandBin(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

function runTypeScriptServerBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(getCommandBin('npx'), ['tsc', '-p', 'server/tsconfig.json'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
      });
    });
  });
}

async function distServerDirExists() {
  try {
    await access(DIST_SERVER_DIR);
    return true;
  } catch {
    return false;
  }
}

async function rewriteDistServerImportsIfPresent() {
  if (!(await distServerDirExists())) {
    return;
  }

  await rewriteDistServerRelativeImports({
    distServerDir: DIST_SERVER_DIR,
  });
}

async function main() {
  const result = await runTypeScriptServerBuild();
  await rewriteDistServerImportsIfPresent();

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exitCode = result.code;
}

await main();
