import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

import packageMetadata from '../package.json';

const appVersion = packageMetadata.version ?? 'dev';
const buildStamp = new Date()
  .toISOString()
  .replace('T', ' ')
  .replace(/\.\d+Z$/, 'Z');
const buildCommit = resolveBuildCommit();
const buildDirty = resolveBuildDirty();
const buildMetadataFileName = 'build-metadata.json';
const buildOutputDir = path.resolve(
  __dirname,
  '..',
  process.env.PARALLEL_CODE_VITE_FRONTEND_OUT_DIR ?? 'dist',
);
let resolvedBuildOutputDir = buildOutputDir;

function readGitOutput(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveBuildCommit(): string {
  const envCommit = process.env.PARALLEL_CODE_BUILD_COMMIT?.trim();
  if (envCommit) {
    return envCommit;
  }

  return readGitOutput(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown';
}

function resolveBuildDirty(): boolean {
  const envDirty = process.env.PARALLEL_CODE_BUILD_DIRTY?.trim();
  if (envDirty === 'true' || envDirty === '1') {
    return true;
  }

  if (envDirty === 'false' || envDirty === '0') {
    return false;
  }

  const porcelain = readGitOutput(['status', '--short']);
  return porcelain !== null && porcelain.length > 0;
}

export default defineConfig({
  base: './',
  build: {
    outDir: buildOutputDir,
  },
  plugins: [
    solid(),
    {
      name: 'parallel-code-build-metadata',
      configResolved(config) {
        resolvedBuildOutputDir = path.resolve(config.root, config.build.outDir);
      },
      async closeBundle() {
        await mkdir(resolvedBuildOutputDir, { recursive: true });
        await writeFile(
          path.join(resolvedBuildOutputDir, buildMetadataFileName),
          JSON.stringify(
            {
              buildCommit,
              buildDirty,
              appVersion,
              buildStamp,
            },
            null,
            2,
          ),
          'utf8',
        );
      },
    },
  ],
  clearScreen: false,
  define: {
    __APP_BUILD_COMMIT__: JSON.stringify(buildCommit),
    __APP_BUILD_DIRTY__: JSON.stringify(buildDirty),
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  server: {
    port: 1421,
    strictPort: true,
  },
});
