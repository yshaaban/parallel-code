import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'path';

export default defineConfig({
  base: './',
  root: path.resolve(__dirname),
  plugins: [solid()],
  build: {
    manifest: true,
    modulePreload: false,
    outDir: path.resolve(
      __dirname,
      '../..',
      process.env.PARALLEL_CODE_VITE_REMOTE_OUT_DIR ?? 'dist-remote',
    ),
    emptyOutDir: true,
  },
});
