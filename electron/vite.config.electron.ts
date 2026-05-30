import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

import packageMetadata from '../package.json';

const appVersion = packageMetadata.version ?? 'dev';
const buildStamp = new Date()
  .toISOString()
  .replace('T', ' ')
  .replace(/\.\d+Z$/, 'Z');
const buildMetadataFileName = 'build-metadata.json';
const buildOutputDir = path.resolve(
  __dirname,
  '..',
  process.env.PARALLEL_CODE_VITE_FRONTEND_OUT_DIR ?? 'dist',
);
let resolvedBuildOutputDir = buildOutputDir;

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
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD_STAMP__: JSON.stringify(buildStamp),
  },
  server: {
    port: 1421,
    strictPort: true,
  },
});
