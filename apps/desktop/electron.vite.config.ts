import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

// Only `dependencies` stay outside the bundle (native code). Everything in devDependencies is bundled.
export default defineConfig({
  main: {
    build: { externalizeDeps: true },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
    plugins: [solid()],
  },
})
