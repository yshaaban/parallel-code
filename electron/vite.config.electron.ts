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

export default defineConfig({
  base: './',
  plugins: [
    solid(),
    {
      name: 'parallel-code-build-metadata',
      async closeBundle() {
        const outputDir = path.resolve(__dirname, '..', 'dist');
        await mkdir(outputDir, { recursive: true });
        await writeFile(
          path.join(outputDir, buildMetadataFileName),
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
