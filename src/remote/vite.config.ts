import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "path";

export default defineConfig({
  base: "./",
  root: path.resolve(__dirname),
  plugins: [solid()],
  build: {
    outDir: path.resolve(__dirname, "../../dist-remote"),
    emptyOutDir: true,
  },
});
