#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runCommand as spawnCommand } from './lib/run-command.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(PROJECT_ROOT, 'release');

export function getReleaseBuildSteps(electronBuilderArgs = []) {
  return [
    {
      args: ['run', 'prepare:browser-artifacts'],
      command: 'npm',
      label: 'prepare browser artifacts',
    },
    {
      args: ['run', 'compile'],
      command: 'npm',
      label: 'compile Electron adapter',
    },
    {
      args: ['electron-builder', ...electronBuilderArgs],
      command: 'npx',
      label: 'package Electron adapter',
    },
    {
      args: ['run', 'verify:electron-package'],
      command: 'npm',
      label: 'verify Electron package',
    },
  ];
}

function createSpawnRunner() {
  return (command, args) => spawnCommand(command, args, { cwd: PROJECT_ROOT });
}

export async function cleanReleaseOutput({ releaseDir = RELEASE_DIR, rmFn = rm } = {}) {
  await rmFn(releaseDir, { force: true, recursive: true });
}

export async function runReleaseBuild({
  electronBuilderArgs = [],
  cleanReleaseOutputFn = cleanReleaseOutput,
  runCommand = createSpawnRunner(),
} = {}) {
  await cleanReleaseOutputFn();

  for (const step of getReleaseBuildSteps(electronBuilderArgs)) {
    const result = await runCommand(step.command, step.args);
    if (result.signal) {
      return result;
    }

    if (result.code !== 0) {
      return result;
    }
  }

  return {
    code: 0,
    signal: null,
  };
}

async function main() {
  const result = await runReleaseBuild({
    electronBuilderArgs: process.argv.slice(2),
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
