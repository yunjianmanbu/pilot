// 浏览器里的桌面界面：`/` 与 `/assets/*` 发的是 `out/web`（与桌面客户端
// 同一份 renderer 构建），`/pwa/*` 是手机面板，`/media/*` 把 `pilot-media:`
// 换成 HTTP（浏览器标签页注册不了自定义 scheme）。
//
// 桌面应用与 `pilot serve` 都可能带 `desktopDir`；不带时（没构建过 `out/web`）
// 根路径回落到手机面板。
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { MEDIA_HTTP_PREFIX } from '../../../shared/media'
import { serveMediaRequest } from '../../preview'
import { CONTENT_TYPES, STATIC_ROUTES } from '../helpers'
import type { CompanionServer } from '../server'

/** 桌面界面的入口文件；其余静态资源都从同一个目录里取。 */
const DESKTOP_ENTRY = 'index.html'

/**
 * 桌面入口 HTML 的内联引导。
 *
 * 旧版本的根路径是手机面板，它把自己的 Service Worker 注册在 `/` 上；那个
 * SW 会把 `/` 一直交给缓存里的手机壳。被它控制时先注销注册、清掉缓存再重载
 * 一次，页面才会真的变成桌面界面。
 *
 * `#p=` 是配对凭据：只有手机上（扫码进来的那个设备）才转到 `/pwa/`。电脑浏览器
 * 点同一个链接必须留在桌面界面——否则拿到配对链接的人看到的是一套手机面板，
 * 与桌面客户端完全不是同一个东西。
 *
 * 远端浏览器（非回环地址）也留在桌面界面：页面自己用 `POST /bridge/ticket`
 * 申请一份凭据，本机审批后经 `/bridge` 拿到与窗口同一份 IPC 面。所以这里不再
 * 把非本机浏览器重定向去 `/pwa/`。
 */
const ENTRY_BOOTSTRAP = `(() => {
  const mobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MiuiBrowser|MicroMessenger/i.test(
    navigator.userAgent,
  )
  if (mobile && /[#&]p=/.test(location.hash)) {
    location.replace('/pwa/' + location.hash)
    return
  }
  if (!mobile && /[#&]p=/.test(location.hash)) {
    // 桌面界面不认这条 hash；留着会让地址栏看起来像另一个页面。
    history.replaceState(null, '', location.pathname + location.search)
  }
  const container = navigator.serviceWorker
  if (!container || !container.controller) return
  if (sessionStorage.getItem('pilot-sw-reset')) return
  sessionStorage.setItem('pilot-sw-reset', '1')
  Promise.resolve(container.getRegistrations())
    .then((list) => Promise.all(list.map((item) => item.unregister().catch(() => false))))
    .then(() => (window.caches ? caches.keys() : []))
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key).catch(() => false))))
    .catch(() => {})
    .then(() => location.replace('/'))
})()`

/**
 * 桌面站点不再需要 Service Worker，但旧注册还在浏览器里。这里发一个自我
 * 注销的脚本：它的字节与手机面板的 `sw.js` 不同，浏览器下一次更新检查就会
 * 装上它，装上后清缓存、注销自己，并让已打开的标签页重新导航。
 */
const RETIRED_SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)))
      await self.registration.unregister()
      const clients = await self.clients.matchAll({ type: 'window' })
      await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => null)))
    })(),
  )
})`

/** 桌面构建的产物目录是否真的可用（有 index.html 才算）。 */
export function desktopDirOf(server: CompanionServer): string | null {
  const dir = (server.options.desktopDir ?? '').trim()
  if (!dir) return null
  const root = resolve(dir)
  return existsSync(join(root, DESKTOP_ENTRY)) ? root : null
}

/**
 * 关掉「网页服务」后浏览器就不该再拿到桌面界面。
 *
 * 两个开关共用同一个监听，关掉网页服务而手机连接还开着时端口仍在服务，所以
 * 光靠 `stop()` 挡不住刷新。只有桌面应用设了 `desktopRequiresServerMode`；
 * `pilot serve` 没有这个开关，始终返回 true。
 */
export function desktopServeAllowed(server: CompanionServer): boolean {
  if (!server.options.desktopRequiresServerMode) return true
  try {
    return server.options.store.settings().serverMode === true
  } catch {
    return true
  }
}

/** 网页服务已关闭时给浏览器的说明页：不是 404，让用户知道是关着而不是坏了。 */
const SERVER_OFF_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>网页服务已关闭</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#16171a;
color:#d1d5da;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;padding:28px 30px;border-radius:14px;background:#26282c}
h1{margin:0 0 10px;font-size:17px;font-weight:650}
p{margin:0;color:#aaaeb7}
</style></head>
<body><main>
<h1>网页服务已关闭</h1>
<p>这台电脑上的 Pilot 关闭了网页服务，浏览器无法再访问。需要时在桌面客户端
「设置 → 网页服务」里重新打开并保存。</p>
</main></body></html>`

function sendServerOff(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(SERVER_OFF_PAGE),
    'Cache-Control': 'no-store',
    'Retry-After': '30',
  })
  if (request.method === 'HEAD') response.end()
  else response.end(SERVER_OFF_PAGE)
}

/** `relative` 落在 `root` 里才返回绝对路径，挡掉 `..` 与盘符逃逸。 */
function insideRoot(root: string, relative: string): string | null {
  const target = resolve(join(root, relative))
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

function cacheControl(relative: string): string {
  // Vite 给每个 asset 文件名带内容哈希，可以长缓存；入口 HTML 必须每次回源。
  return relative.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable'
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  relative: string,
  /** 只有桌面入口需要注入引导脚本；手机面板的 HTML 原样下发。 */
  bootstrap = false,
): Promise<void> {
  const target = insideRoot(root, relative)
  if (!target) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Forbidden')
    return
  }
  const info = await stat(target)
  if (!info.isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  const raw = await readFile(target)
  const ext = relative.slice(relative.lastIndexOf('.'))
  const body =
    ext === '.html' && bootstrap
      ? Buffer.from(
          raw
            .toString('utf8')
            .replace(/<\/head>/i, `  <script>${ENTRY_BOOTSTRAP}</script>\n  </head>`),
        )
      : raw
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': cacheControl(relative),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  if (request.method === 'HEAD') response.end()
  else response.end(body)
}

/**
 * `pilot-media://local/<path>` 的浏览器替身。
 *
 * 复用桌面协议的同一个 `serveMediaRequest`，所以工作区越界判定、Range 与
 * Content-Type 都不会有两套实现。
 */
async function sendMedia(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(','))
  }
  const result = await serveMediaRequest(
    new Request(`http://pilot.local${url.pathname}${url.search}`, {
      method: request.method ?? 'GET',
      headers,
    }),
    () => server.options.store.activeWorkspace() ?? null,
  )
  const out: Record<string, string> = {}
  result.headers.forEach((value, key) => {
    out[key] = value
  })
  response.writeHead(result.status, out)
  if (request.method === 'HEAD' || !result.body) {
    response.end()
    return
  }
  const stream = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', () => response.end())
  stream.pipe(response)
}

/** 手机面板的资产：与桌面应用托管时完全一致的映射，只是挂在 `/pwa/` 下。 */
function companionAsset(pathname: string): string | null {
  const rest = pathname.slice('/pwa'.length).replace(/^\/+/, '')
  if (!rest) return 'index.html'
  if (STATIC_ROUTES[`/${rest}`]) return STATIC_ROUTES[`/${rest}`] as string
  if (rest.startsWith('vendor/') || rest.startsWith('icons/')) return rest
  return null
}

/**
 * 处理桌面界面相关请求；不属于这里时返回 false，交给原来的手机面板路由。
 */
export async function handleDesktopHttp(
  server: CompanionServer,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === MEDIA_HTTP_PREFIX || url.pathname.startsWith(`${MEDIA_HTTP_PREFIX}/`)) {
    await sendMedia(server, request, response, url)
    return true
  }

  const desktopDir = desktopDirOf(server)
  if (!desktopDir) return false

  // 自我注销脚本必须始终可下发，包括网页服务已经关闭的时候。
  //
  // 旧版本的根路径是 PWA，浏览器里可能还留着它的 Service Worker；那个 SW 把
  // `/` 存在 Cache Storage 里，关掉网页服务后新的导航仍会由它从缓存交出工作台
  // 界面——这就是「关掉了，刷新还能看到」。让 `/sw.js` 先过这里，浏览器下一次
  // 导航就能装上注销脚本、清掉缓存并注销自己；若把关卡放在它前面，这个请求会
  // 拿到 503 的 HTML，SW 更新失败，旧缓存继续生效。
  if (url.pathname === '/sw.js') {
    const script = RETIRED_SERVICE_WORKER
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(script),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else response.end(script)
    return true
  }

  // `/pwa/` 是手机面板，跟着「手机连接」走，与网页服务开关无关；其余桌面路径
  // 在开关关闭时一律回说明页。
  const pwaPath = url.pathname === '/pwa' || url.pathname.startsWith('/pwa/')
  if (!pwaPath && !desktopServeAllowed(server)) {
    sendServerOff(request, response)
    return true
  }

  if (pwaPath) {
    if (url.pathname === '/pwa') {
      // 相对路径（./app.js）要求尾斜杠，否则会解析到根目录。
      response.writeHead(301, { Location: `/pwa/${url.search}` })
      response.end()
      return true
    }
    const relative = companionAsset(url.pathname)
    if (!relative) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return true
    }
    await sendFile(request, response, server.options.assetsDir, relative)
    return true
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    await sendFile(request, response, desktopDir, DESKTOP_ENTRY, true)
    return true
  }
  if (url.pathname === '/doc.html') {
    await sendFile(request, response, desktopDir, 'doc.html')
    return true
  }
  if (url.pathname.startsWith('/assets/')) {
    await sendFile(request, response, desktopDir, url.pathname.slice(1))
    return true
  }
  return false
}
