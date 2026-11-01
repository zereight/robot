import { resolve } from "node:path"
import { defineConfig } from "electron-vite"
import solid from "vite-plugin-solid"

const bundled = { exclude: ["@robot/shared"] }

export default defineConfig({
  main: {
    build: { externalizeDeps: bundled },
  },
  preload: {
    build: {
      externalizeDeps: bundled,
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
