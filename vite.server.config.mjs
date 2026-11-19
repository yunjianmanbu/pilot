import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Build for the headless server (`pilot serve`).
 *
 * Plain Node, CommonJS, no Electron: `electron` is aliased to a shim so the
 * desktop main-process modules can be reused, and every runtime dependency
 * (qrcode, ws) stays external because the installed package provides them.
 */
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(root, 'src/server/electron-shim.ts'),
    },
  },
  build: {
    outDir: 'out/server',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    sourcemap: false,
    lib: {
      entry: resolve(root, 'src/server/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        'qrcode',
        'ws',
      ],
    },
  },
})
