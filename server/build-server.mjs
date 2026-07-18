#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import ts from 'typescript';

import { rewriteDistServerRelativeImports } from './rewrite-dist-server-relative-imports.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_SERVER_DIR = path.join(PROJECT_ROOT, 'dist-server');
const DEVELOPMENT_OUTPUT_PATH_PATTERN =
  /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:spec|test|test-helper)\.(?:c?js|mjs)(?:\.map)?$/u;
const JAVASCRIPT_OUTPUT_PATH_PATTERN = /\.(?:c?js|mjs)$/u;

function getCommandBin(commandName) {
  return process.platform === 'win32' ? `${commandName}.cmd` : commandName;
}

function runTypeScriptServerBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(getCommandBin('npx'), ['tsc', '-p', 'server/tsconfig.build.json'], {
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

async function listServerBuildFiles(
  directoryPath,
  { readdirFn = readdir, relativeDirectory = '' } = {},
) {
  const entries = await readdirFn(path.join(directoryPath, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await listServerBuildFiles(directoryPath, {
          readdirFn,
          relativeDirectory: relativePath,
        })),
      );
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath.split(path.sep).join('/'));
    }
  }

  return files;
}

export function isDevelopmentServerOutputPath(relativePath) {
  return DEVELOPMENT_OUTPUT_PATH_PATTERN.test(relativePath.replaceAll('\\', '/'));
}

export function containsVitestImport(source) {
  if (!source.includes('vitest')) {
    return false;
  }

  const sourceFile = ts.createSourceFile(
    'server-output.js',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  let found = false;

  function isVitestSpecifier(node) {
    return (
      ts.isStringLiteralLike(node) && (node.text === 'vitest' || node.text.startsWith('vitest/'))
    );
  }

  function visit(node) {
    if (
      ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        isVitestSpecifier(node.moduleSpecifier)) ||
      (ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        isVitestSpecifier(node.moduleReference.expression)) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] &&
        isVitestSpecifier(node.arguments[0]))
    ) {
      found = true;
      return;
    }

    if (!found) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  return found;
}

export async function validateServerBuildOutput({
  distServerDir = DIST_SERVER_DIR,
  listFiles = listServerBuildFiles,
  readFileFn = readFile,
} = {}) {
  const files = (await listFiles(distServerDir)).sort();
  const developmentArtifacts = files.filter(isDevelopmentServerOutputPath);
  const vitestImports = (
    await Promise.all(
      files
        .filter((filePath) => JAVASCRIPT_OUTPUT_PATH_PATTERN.test(filePath))
        .map(async (filePath) => {
          const source = await readFileFn(path.join(distServerDir, filePath), 'utf8');
          return containsVitestImport(source) ? filePath : null;
        }),
    )
  ).filter((filePath) => filePath !== null);
  const failures = [];

  if (developmentArtifacts.length > 0) {
    failures.push(
      `development artifacts (${developmentArtifacts.length}):\n${developmentArtifacts.join('\n')}`,
    );
  }
  if (vitestImports.length > 0) {
    failures.push(`Vitest imports (${vitestImports.length}):\n${vitestImports.join('\n')}`);
  }

  if (failures.length > 0) {
    throw new Error(`Invalid production server output:\n${failures.join('\n')}`);
  }
}

export async function cleanServerBuildOutput({ distServerDir = DIST_SERVER_DIR, rmFn = rm } = {}) {
  await rmFn(distServerDir, { force: true, recursive: true });
}

async function cleanFailedServerBuild(cleanOutput, error) {
  try {
    await cleanOutput();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Server build failed and cleanup also failed.');
  }
  throw error;
}

function createFailedCompilerResultError(result) {
  return new Error(
    result.signal
      ? `TypeScript server build exited from signal ${result.signal}`
      : `TypeScript server build exited with code ${result.code}`,
  );
}

export async function runServerBuild({
  cleanOutput = cleanServerBuildOutput,
  compile = runTypeScriptServerBuild,
  rewriteImports = rewriteDistServerImportsIfPresent,
  validateOutput = validateServerBuildOutput,
} = {}) {
  await cleanOutput();
  let result;
  try {
    result = await compile();
  } catch (error) {
    await cleanFailedServerBuild(cleanOutput, error);
  }
  if (result.signal || result.code !== 0) {
    try {
      await cleanOutput();
    } catch (cleanupError) {
      throw new AggregateError(
        [createFailedCompilerResultError(result), cleanupError],
        'Server build failed and cleanup also failed.',
      );
    }
    return result;
  }

  try {
    await rewriteImports();
    await validateOutput();
  } catch (error) {
    await cleanFailedServerBuild(cleanOutput, error);
  }
  return result;
}

async function main() {
  const result = await runServerBuild();

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }

  process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
