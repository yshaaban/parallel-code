#!/usr/bin/env node
// Repairs native dependencies that the npm install/extract path can leave broken on macOS.
//
// 1. node-pty ships a darwin `spawn-helper` prebuild whose execute bit is sometimes dropped
//    during extraction. Without +x, every PTY spawn fails with `posix_spawnp failed`, which
//    breaks the terminal/PTY backend and the entire terminal test suite.
// 2. Electron's `extract-zip` step can stop partway and leave `dist/` half-populated while
//    `install.js` still records success (it only checks `dist/version`). We repair from the
//    already-downloaded cache zip so no network access is required.
//
// This runs on every `npm install`/`npm ci`. It is best-effort and idempotent: it must never
// fail the install, and it does nothing when the dependencies are already healthy.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function log(message) {
  console.log(`[native-fixups] ${message}`);
}

// node-pty: ensure the prebuilt spawn-helper binaries are executable.
function fixNodePtySpawnHelper() {
  const prebuildsDir = join(repoRoot, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(prebuildsDir)) {
    return;
  }
  for (const entry of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, entry, 'spawn-helper');
    if (!existsSync(helper)) {
      continue;
    }
    const { mode } = statSync(helper);
    if (mode & 0o111) {
      continue; // already executable
    }
    chmodSync(helper, 0o755);
    log(`chmod +x ${relative(repoRoot, helper)}`);
  }
}

// Electron: re-extract from the cached zip when dist/ is incomplete (macOS only).
function repairElectron() {
  if (platform() !== 'darwin') {
    return;
  }
  const electronDir = join(repoRoot, 'node_modules', 'electron');
  if (!existsSync(electronDir)) {
    return;
  }
  const distDir = join(electronDir, 'dist');
  const pathTxt = join(electronDir, 'path.txt');
  const binRel = 'Electron.app/Contents/MacOS/Electron';
  if (existsSync(pathTxt) && existsSync(join(distDir, binRel))) {
    return; // healthy
  }

  const { version } = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'));
  const zipName = `electron-v${version}-darwin-${process.arch}.zip`;
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'electron');
  let zipPath = null;
  if (existsSync(cacheRoot)) {
    for (const sub of readdirSync(cacheRoot)) {
      const candidate = join(cacheRoot, sub, zipName);
      if (existsSync(candidate)) {
        zipPath = candidate;
        break;
      }
    }
  }
  if (!zipPath) {
    log(
      `electron dist looks incomplete and no cached ${zipName} was found; ` +
        `run \`node node_modules/electron/install.js\` with network access.`,
    );
    return;
  }

  rmSync(distDir, { recursive: true, force: true });
  rmSync(pathTxt, { force: true });
  execFileSync('unzip', ['-q', zipPath, '-d', distDir], { stdio: 'inherit' });
  writeFileSync(pathTxt, binRel);
  log('re-extracted electron from cache');
}

try {
  fixNodePtySpawnHelper();
} catch (error) {
  log(`node-pty fix skipped: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  repairElectron();
} catch (error) {
  log(`electron repair skipped: ${error instanceof Error ? error.message : String(error)}`);
}
