import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const appVersion = process.env.npm_package_version ?? 'dev';
const buildStamp = new Date()
  .toISOString()
  .replace('T', ' ')
  .replace(/\.\d+Z$/, 'Z');

export default defineConfig({
  base: './',
  plugins: [solid()],
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
