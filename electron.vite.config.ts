import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        // Three pages sharing one bundle graph: the app shell, the standalone
        // document window it opens for a previewed file, and the emergency
        // super-pilot window that must still work when the shell is broken.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          doc: resolve(__dirname, 'src/renderer/doc.html'),
          super: resolve(__dirname, 'src/renderer/super.html'),
        },
      },
    },
  },
})
