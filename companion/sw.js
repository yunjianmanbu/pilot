/* Pilot phone app shell cache. Network-first so local development never goes stale. */
const SHELL_CACHE = 'pilot-shell-v9'
const RUNTIME_CACHE = 'pilot-runtime-v9'
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/+$/, '')
const shellUrl = (name) => `${SCOPE_PATH}/${name}`
const SHELL = [
  shellUrl('index.html'),
  shellUrl('style.css'),
  shellUrl('app.js'),
  shellUrl('crypto.js'),
  shellUrl('manifest.webmanifest'),
  shellUrl('icons/icon.svg'),
  shellUrl('icons/maskable.svg'),
  shellUrl('icons/icon.png'),
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/ws') || url.pathname.endsWith('/healthz')) return
  // 接入凭据是一次性、有时效的：一旦进缓存，离线时会把过期凭据当成有效凭据
  // 返回，页面就卡在「申请访问」上。这类请求完全交给网络。
  if (url.pathname.startsWith('/access')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, shellUrl('index.html')))
    return
  }
  if (url.pathname.includes('/vendor/')) {
    event.respondWith(cacheFirst(request))
    return
  }
  event.respondWith(networkFirst(request))
})

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE)
      cache.put(request, response.clone()).catch(() => undefined)
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    if (fallbackUrl) {
      const shell = await caches.match(fallbackUrl)
      if (shell) return shell
    }
    return new Response('', { status: 503, statusText: 'Offline' })
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE)
    cache.put(request, response.clone()).catch(() => undefined)
  }
  return response
}
