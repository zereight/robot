import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

// Only `dependencies` stay outside the bundle (native code). Everything in devDependencies is bundled.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        // The worker of the check (spec 010) is its own file: the main process starts it by name.
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          checkWorker: resolve(import.meta.dirname, "src/main/check/worker.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
        },
      },
    },
    plugins: [solid()],
  },
})
