import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * 浏览器版 renderer 构建（`pilot serve` 托管的那份）。
 *
 * 和 `electron.vite.config.mts` 的 renderer 段是同一份源码、同一组页面，只是
 * 产物落在 `out/web`。两个入口（`main.tsx` / `doc.tsx`）最前面都 import 了
 * `browser-bridge.ts`：桌面端它看到 preload 已经放好的 `window.pilot` 就返回，
 * 浏览器里则用 `WS /bridge` 造出同一个对象，App 代码一行都不用改。
 */
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  // 从站点根路径托管：入口 HTML 里的 /assets/* 因此和 desktop.ts 的路由一致。
  base: '/',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'out/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'src/renderer/index.html'),
        doc: resolve(root, 'src/renderer/doc.html'),
      },
    },
  },
})
