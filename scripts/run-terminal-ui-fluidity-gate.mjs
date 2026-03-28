#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  formatTerminalUiFluidityDenseGateVisibleTerminalCounts,
  formatTerminalUiFluidityGateProfiles,
  formatTerminalUiFluidityGateVisibleTerminalCounts,
  formatTerminalUiFluidityMatrixGateVariants,
} from './terminal-ui-fluidity-gate.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MATRIX_SCRIPT_PATH = path.resolve(__dirname, 'terminal-ui-fluidity-matrix.mjs');

function getCommandBin(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

function getVisibleTerminalCountsArg(dense) {
  if (dense) {
    return formatTerminalUiFluidityDenseGateVisibleTerminalCounts();
  }

  return formatTerminalUiFluidityGateVisibleTerminalCounts();
}

function parseArgs(argv) {
  let dense = false;
  const extraArgs = [];

  for (const arg of argv) {
    if (arg === '--dense') {
      dense = true;
      continue;
    }

    extraArgs.push(arg);
  }

  return { dense, extraArgs };
}

export function buildTerminalUiFluidityGateMatrixArgs(
  options = {
    dense: false,
    extraArgs: [],
  },
) {
  return [
    MATRIX_SCRIPT_PATH,
    '--skip-build',
    '--variants',
    formatTerminalUiFluidityMatrixGateVariants(),
    '--profiles',
    formatTerminalUiFluidityGateProfiles(),
    '--visible-terminal-counts',
    getVisibleTerminalCountsArg(options.dense),
    ...options.extraArgs,
  ];
}

function runCommand(commandName, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(getCommandBin(commandName), args, {
      cwd: ROOT_DIR,
      env,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({
        code: code ?? 1,
        signal,
      });
    });
  });
}

export async function runTerminalUiFluidityGate(
  options = {
    dense: false,
    extraArgs: [],
    env: process.env,
  },
) {
  const prepareResult = await runCommand('npm', ['run', 'prepare:browser-artifacts'], options.env);
  if (prepareResult.code !== 0) {
    return prepareResult.code;
  }

  const matrixResult = await runCommand(
    process.execPath,
    buildTerminalUiFluidityGateMatrixArgs({
      dense: options.dense,
      extraArgs: options.extraArgs,
    }),
    options.env,
  );
  return matrixResult.code;
}

async function main() {
  const exitCode = await runTerminalUiFluidityGate(parseArgs(process.argv.slice(2)));
  process.exitCode = exitCode;
}

function isDirectRun() {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isDirectRun()) {
  await main();
}
