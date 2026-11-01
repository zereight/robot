import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

// Only `dependencies` stay outside the bundle (native code). Everything in devDependencies is bundled.
export default defineConfig({
  main: {
    build: { externalizeDeps: true },
    resolve: {
      // The Node build of fflate declares its own `require`, which clashes in the bundle.
      // The plain build has no Node parts and works the same here.
      alias: { fflate: resolve(import.meta.dirname, "node_modules/fflate/esm/browser.js") },
    },
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
