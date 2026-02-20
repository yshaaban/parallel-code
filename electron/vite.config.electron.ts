import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "./",
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
});
