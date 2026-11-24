import {
  base64url,
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  fromBase64url,
  importKey,
  randomBase64url,
  tokenProof,
  utf8Decode,
} from './crypto.js'

const PAIRING_KEY = 'pilot-link.pairing.v1'
const PHONE_KEY = 'pilot-link.phone-id.v1'
const THEME_KEY = 'pilot-link.theme.v1'
const INPUT_HISTORY_KEY = 'pilot.input-history.v1'
const INPUT_HISTORY_LIMIT = 40
const CACHE_KEY = 'pilot-link.cache.v1'

/* ── Storage ───────────────────────────────────────────────────────────── */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private browsing can reject storage writes; the session still works.
  }
}

function readInputHistory() {
  const raw = readJson(INPUT_HISTORY_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .slice(0, INPUT_HISTORY_LIMIT)
}

function rememberInput(text) {
  const previous = readInputHistory().filter((entry) => entry !== text)
  writeJson(INPUT_HISTORY_KEY, [text, ...previous].slice(0, INPUT_HISTORY_LIMIT))
}

function loadPairing() {
  const value = readJson(PAIRING_KEY)
  if (!value || value.v !== 1 || typeof value.relayUrl !== 'string') return null
  if (!value.keys?.pcToPhone || !value.keys?.phoneToPc) return null
  return value
}

function savePairing(pairing) {
  writeJson(PAIRING_KEY, pairing)
}

function clearPairing() {
  try {
    localStorage.removeItem(PAIRING_KEY)
  } catch {
    // ignore
  }
}

function readCache() {
  const value = readJson(CACHE_KEY)
  if (!value || value.v !== 1) return null
  return value
}

function saveOfflineCache() {
  if (!state.pairing) return
  writeJson(CACHE_KEY, {
    v: 1,
    savedAt: new Date().toISOString(),
    sessions: Array.isArray(state.sessions) ? state.sessions.slice(0, 100) : [],
    workspaces: Array.isArray(state.workspaces) ? state.workspaces : [],
    deviceInfo: state.deviceInfo,
    sessionId: state.sessionId,
    session: state.session,
    hasMore: state.hasMore,
  })
}

function clearOfflineCache() {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}

function phoneId() {
  let value = ''
  try {
    value = localStorage.getItem(PHONE_KEY) || ''
  } catch {
    // ignore
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    value = randomBase64url(12)
    try {
      localStorage.setItem(PHONE_KEY, value)
    } catch {
      // ignore
    }
  }
  return value
}

function phoneName() {
  const ua = navigator.userAgent || ''
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android 手机'
  return '手机'
}

/* ── Pairing link ──────────────────────────────────────────────────────── */

function normalizeRelayUrl(value) {
  let text = String(value || '').trim()
  if (!text) throw new Error('缺少中继地址')
  if (!/^[a-z]+:\/\//i.test(text)) text = `wss://${text}`
  const match = /^(wss?|https?):\/\/([^/?#]+)([^?#]*)/i.exec(text)
  if (!match) throw new Error('配对链接格式不正确')
  let protocol = match[1].toLowerCase()
  if (protocol === 'https') protocol = 'wss'
  if (protocol === 'http') protocol = 'ws'
  if (protocol !== 'ws' && protocol !== 'wss') throw new Error('中继地址不正确')
  let path = match[3] || ''
  if (!path || path === '/') path = '/ws'
  path = path.replace(/\/+$/, '')
  return `${protocol}://${match[2]}${path}`
}

function isWrappedUrl(url, pairing) {
  return /^wss:\/\//i.test(String(url || '')) && Boolean(pairing?.room && pairing?.roomKey)
}

function validatePayload(data) {
  if (!data || typeof data !== 'object') throw new Error('配对链接内容不正确')
  if (data.v !== 1) throw new Error('配对链接版本不受支持')
  if (typeof data.r !== 'string' || !data.r.trim()) throw new Error('配对链接缺少中继地址')
  if (typeof data.d !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(data.d)) {
    throw new Error('配对链接缺少电脑标识')
  }
  if (typeof data.k !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(data.k)) {
    throw new Error('配对链接缺少配对标识')
  }
  if (typeof data.s !== 'string' || data.s.length < 20) throw new Error('配对链接缺少配对密钥')
  if (typeof data.p !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(data.p)) {
    throw new Error('配对链接中的电脑公钥不正确')
  }
  const relayUrl = normalizeRelayUrl(data.r)
  const localRelayUrl =
    typeof data.l === 'string' && data.l.trim() ? normalizeRelayUrl(data.l) : ''
  const room = typeof data.x === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(data.x) ? data.x : ''
  const roomKey =
    typeof data.h === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(data.h) ? data.h : ''
  // L1 admission code (`id:secret`). Absent when the desktop predates 0.2.3;
  // an open connector still accepts that, a strict one answers 4009.
  const access =
    typeof data.a === 'string' && /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{16,128}$/.test(data.a)
      ? data.a
      : ''
  // Cloud rooms need both identifiers; LAN fallback keeps working without them.
  if (/^wss:\/\//i.test(relayUrl) && (!room || !roomKey)) {
    throw new Error('配对链接缺少云端连接信息')
  }
  return {
    v: 1,
    relayUrl,
    localRelayUrl,
    room,
    roomKey,
    access,
    deviceId: data.d,
    deviceName: String(data.n || '电脑').slice(0, 80),
    lookup: data.k,
    secret: data.s,
    publicKey: data.p,
  }
}

function decodePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('配对链接缺少配对内容')
  let json
  try {
    json = utf8Decode(fromBase64url(raw.trim(), '配对链接'))
  } catch {
    throw new Error('配对链接格式不正确')
  }
  let data
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error('配对链接内容无法解析')
  }
  return validatePayload(data)
}

function payloadFromText(text) {
  const value = String(text || '').trim()
  if (!value) throw new Error('请粘贴配对链接')
  const marker = value.indexOf('#p=')
  if (marker >= 0) return decodePayload(value.slice(marker + 3))
  if (/^[A-Za-z0-9_-]{40,}$/.test(value)) return decodePayload(value)
  throw new Error('这看起来不是有效的配对链接')
}

function extractPairingHash() {
  const hash = String(location.hash || '')
  const marker = hash.indexOf('#p=')
  if (marker < 0) return null
  try {
    return decodePayload(hash.slice(marker + 3))
  } catch {
    return null
  }
}

function joinPairing(payload) {
  return new Promise((resolve, reject) => {
    const pair = createKeyPair()
    const id = phoneId()
    const name = phoneName()
    const platform = navigator.userAgentData?.platform || navigator.platform || 'mobile'
    const urls = [payload.relayUrl, payload.localRelayUrl].filter(
      (url, index, list) => url && list.indexOf(url) === index,
    )
    let socket = null
    let settled = false
    let lastError = ''
    let index = 0
    let attemptTimer = null
    const totalTimer = setTimeout(
      () => finish(new Error('等待电脑确认超时，请在电脑上重新生成二维码')),
      90_000,
    )
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(totalTimer)
      clearTimeout(attemptTimer)
      try {
        socket?.close()
      } catch {
        // ignore
      }
      if (error) reject(error)
      else resolve(result)
    }
    const tryNext = (error) => {
      if (settled) return
      if (error) lastError = error.message || String(error)
      clearTimeout(attemptTimer)
      try {
        socket?.close()
      } catch {
        // ignore
      }
      socket = null
      index += 1
      if (index >= urls.length) {
        finish(new Error(lastError || '与电脑的连接已断开，请重试'))
        return
      }
      open(urls[index], index > 0)
    }
    const open = (url, fallback) => {
      let next
      try {
        next = new WebSocket(url)
      } catch (error) {
        lastError = `无法连接电脑：${error?.message || error}`
        tryNext()
        return
      }
      socket = next
      // A cloud relay connection needs a plain-text relay.hello first. Only
      // after relay.ready may the encrypted business frames be wrapped in
      // relay.frame; the LAN fallback talks to the desktop directly.
      const wrapped = isWrappedUrl(url, payload)
      let ready = false
      const send = (frame, raw = false) => {
        if (socket !== next || settled) return
        try {
          next.send(JSON.stringify(raw || !wrapped ? frame : { type: 'relay.frame', data: frame }))
        } catch (error) {
          lastError = error?.message || String(error)
          tryNext()
        }
      }
      const join = () => {
        send({
          type: 'pair.join',
          lookup: payload.lookup,
          phoneId: id,
          name,
          phonePub: pair.publicBase64,
          platform,
          protocol: 2,
        })
      }
      attemptTimer = setTimeout(() => {
        if (socket !== next || settled) return
        lastError = fallback ? '局域网连接超时' : '连接电脑超时'
        tryNext()
      }, 15_000)
      next.onopen = () => {
        if (socket !== next || settled) return
        if (wrapped) {
          send(
            {
              type: 'relay.hello',
              role: 'phone',
              room: payload.room,
              key: payload.roomKey,
              protocol: 1,
              ...(payload.access ? { access: payload.access } : {}),
            },
            true,
          )
        } else {
          join()
        }
      }
      next.onmessage = (event) => {
        if (socket !== next || settled) return
        let frame
        try {
          frame = JSON.parse(String(event.data || ''))
        } catch {
          return
        }
        if (!frame || typeof frame.type !== 'string') return
        if (frame.type === 'relay.ready') {
          if (wrapped && !ready) {
            ready = true
            join()
          }
          return
        }
        if (frame.type === 'relay.frame') {
          frame = frame.data
          if (!frame || typeof frame.type !== 'string') return
        }
        if (frame.type === 'relay.error' || frame.type === 'relay.offline') {
          lastError = frame.message || '云端连接器暂时不可用'
          tryNext()
          return
        }
        if (frame.type === 'pair.rejected' || frame.type === 'error') {
          finish(new Error(frame.reason || frame.message || '电脑端拒绝了配对'))
          return
        }
        if (frame.type === 'pair.pending') {
          // The desktop is asking its user to confirm. The socket is up; keep it
          // open so a person taking a few seconds is not read as a dead link.
          clearTimeout(attemptTimer)
          setPairBusy(true, '等待电脑确认授权…')
          return
        }
        if (frame.type !== 'pair.accepted') return
        clearTimeout(attemptTimer)
        try {
          const keys = derivePairKeys(pair.privateKey, payload.publicKey, payload.secret)
          const decoded = decryptPayload(keys.pcToPhone, frame.payload)
          if (decoded.seq !== 1) throw new Error('配对确认序号不正确')
          const value = decoded.value
          if (!value || value.type !== 'pair.accept') throw new Error('配对确认内容不正确')
          if (value.deviceId !== payload.deviceId) {
            throw new Error('电脑身份与配对链接不一致')
          }
          const token = typeof value.token === 'string' ? value.token : frame.token
          if (typeof token !== 'string' || token.length < 20) {
            throw new Error('电脑没有返回配对凭证')
          }
          const now = new Date().toISOString()
          finish(null, {
            v: 1,
            relayUrl: url,
            fallbackUrl: urls.find((candidate) => candidate !== url) || '',
            room: payload.room,
            roomKey: payload.roomKey,
            access: payload.access || '',
            deviceId: payload.deviceId,
            deviceName: value.deviceName || payload.deviceName,
            phoneId: id,
            phoneName: name,
            token,
            keys: {
              pcToPhone: base64url(keys.pcToPhone),
              phoneToPc: base64url(keys.phoneToPc),
            },
            outSeq: 0,
            inSeq: 1,
            pairedAt: now,
            lastActiveAt: now,
          })
        } catch (error) {
          finish(error)
        }
      }
      next.onerror = () => {
        if (socket !== next || settled) return
        lastError = '连接电脑失败'
      }
      next.onclose = () => {
        if (socket !== next || settled) return
        lastError = lastError || '与电脑的连接已断开，请重试'
        tryNext()
      }
    }
    if (urls.length === 0) {
      finish(new Error('配对链接缺少中继地址'))
      return
    }
    open(urls[0], false)
  })
}

/* ── Relay client ──────────────────────────────────────────────────────── */

class RelayClient {
  constructor(pairing, handlers = {}) {
    this.pairing = pairing
    this.handlers = handlers
    this.urls = [pairing.relayUrl, pairing.fallbackUrl].filter(
      (url, index, list) => url && list.indexOf(url) === index,
    )
    this.urlIndex = 0
    this.currentUrl = ''
    this.pcToPhone = importKey(pairing.keys.pcToPhone)
    this.phoneToPc = importKey(pairing.keys.phoneToPc)
    this.outSeq = Number(pairing.outSeq) || 0
    this.inSeq = Number(pairing.inSeq) || 0
    this.requestSeq = 0
    this.pending = new Map()
    this.socket = null
    this.stopped = false
    this.connected = false
    this.relayReady = false
    this.wrapped = false
    this.state = 'idle'
    this.attempt = 0
    this.lastError = ''
    this.reconnectTimer = null
    this.welcomeTimer = null
    this.pingTimer = null
    this.lastFrameAt = 0
    this.lastPingAt = 0
    this.pingFailures = 0
  }

  setState(state, message = '') {
    this.state = state
    try {
      this.handlers.onState?.({ state, message })
    } catch {
      // ignore
    }
  }

  connect() {
    if (this.stopped) return
    this.closeSocket()
    this.connected = false
    this.lastError = ''
    this.setState(this.attempt > 0 ? 'reconnecting' : 'connecting', this.attempt > 0 ? '正在重新连接电脑…' : '正在连接电脑…')
    const url = this.urls[this.urlIndex % Math.max(1, this.urls.length)] || this.pairing.relayUrl
    this.currentUrl = url
    this.wrapped = isWrappedUrl(url, this.pairing)
    this.relayReady = false
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.lastError = error?.message || String(error)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.welcomeTimer = setTimeout(() => {
      if (this.socket !== socket || this.connected) return
      this.lastError = '电脑没有响应'
      this.closeSocket()
      this.scheduleReconnect()
    }, 15_000)
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return
      this.lastFrameAt = Date.now()
      if (this.wrapped) {
        // 云端连接器先做明文 relay 握手，业务帧在 relay.ready 之后才加密发送。
        this.sendSocket({
          type: 'relay.hello',
          role: 'phone',
          room: this.pairing.room,
          key: this.pairing.roomKey,
          protocol: 1,
          ...(this.pairing.access ? { access: this.pairing.access } : {}),
        })
      } else {
        this.sendHello()
      }
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket) return
      this.lastFrameAt = Date.now()
      let frame
      try {
        frame = JSON.parse(String(event.data || ''))
      } catch {
        return
      }
      this.handleFrame(frame)
    }
    socket.onerror = () => {
      if (this.socket !== socket) return
      this.lastError = '连接电脑失败'
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.connected = false
      this.stopHeartbeat()
      this.rejectPending('连接已断开')
      if (this.stopped) return
      this.setState('disconnected', this.lastError || '连接已断开')
      this.scheduleReconnect()
    }
  }

  closeSocket() {
    clearTimeout(this.welcomeTimer)
    this.welcomeTimer = null
    const socket = this.socket
    this.socket = null
    this.connected = false
    this.lastPingAt = 0
    this.stopHeartbeat()
    if (!socket) return
    try {
      socket.close()
    } catch {
      // ignore
    }
  }

  scheduleReconnect() {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    const attempt = Math.min(this.attempt, 8)
    const delay = Math.min(6_000, 600 * Math.pow(1.7, attempt))
    this.attempt += 1
    this.urlIndex += 1
    this.setState('reconnecting', this.lastError || '连接已断开，正在重连…')
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  reconnect() {
    this.stopped = false
    this.attempt = 0
    this.lastError = ''
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.closeSocket()
    this.rejectPending('连接已关闭')
    this.setState('idle')
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.lastFrameAt = Date.now()
    this.lastPingAt = 0
    this.pingFailures = 0
    this.pingTimer = setInterval(() => {
      if (!this.connected) return
      const now = Date.now()
      if (now - this.lastFrameAt > 45_000) {
        this.lastError = '连接超时'
        this.closeSocket()
        this.scheduleReconnect()
        return
      }
      // 上一次心跳之后一个帧都没收到，说明连接已经假在线。
      if (this.lastPingAt && this.lastFrameAt < this.lastPingAt) {
        this.pingFailures += 1
        if (this.pingFailures >= 2) {
          this.lastError = '连接无响应'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
      } else {
        this.pingFailures = 0
      }
      if (!this.sendRaw({ type: 'ping' })) {
        this.pingFailures += 1
        if (this.pingFailures >= 2) {
          this.lastError = '连接已断开'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
        return
      }
      this.lastPingAt = now
    }, 15_000)
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  sendHello() {
    this.sendRaw({
      type: 'hello',
      role: 'phone',
      deviceId: this.pairing.deviceId,
      phoneId: this.pairing.phoneId,
      protocol: 2,
    })
  }

  sendSocket(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  sendRaw(frame) {
    // 云端连接器只接受 relay.frame 包装；局域网直连仍发送原始帧。
    const payload = this.wrapped ? { type: 'relay.frame', data: frame } : frame
    return this.sendSocket(payload)
  }

  send(value) {
    if (!this.connected) throw new Error('尚未连接电脑')
    const seq = this.outSeq + 1
    const envelope = encryptPayload(this.phoneToPc, value, seq)
    if (!this.sendRaw({ type: 'message', payload: envelope })) {
      throw new Error('连接已断开')
    }
    this.outSeq = seq
    this.pairing.outSeq = seq
    savePairing(this.pairing)
  }

  request(method, params = {}, timeout = 20_000) {
    if (!this.connected) return Promise.reject(new Error('尚未连接电脑'))
    const id = `${++this.requestSeq}-${Date.now().toString(36)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('电脑没有响应，请稍后重试'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'request', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  rejectPending(message) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
      this.pending.delete(id)
    }
  }

  handleFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return
    switch (frame.type) {
      case 'relay.ready': {
        if (!this.relayReady) {
          this.relayReady = true
          this.sendHello()
        }
        return
      }
      case 'relay.frame': {
        const inner = frame.data
        if (inner && typeof inner === 'object') this.handleFrame(inner)
        return
      }
      case 'hello.challenge': {
        try {
          const proof = tokenProof(this.pairing.token, String(frame.challenge || ''))
          this.sendRaw({
            type: 'hello.proof',
            deviceId: this.pairing.deviceId,
            phoneId: this.pairing.phoneId,
            proof,
          })
        } catch {
          this.lastError = '配对凭证不正确，请重新扫码'
          this.closeSocket()
          this.scheduleReconnect()
        }
        return
      }
      case 'hello.legacy': {
        // The desktop was paired before protocol 2 and has no sealed token yet.
        this.sendRaw({
          type: 'hello',
          role: 'phone',
          deviceId: this.pairing.deviceId,
          phoneId: this.pairing.phoneId,
          token: this.pairing.token,
        })
        return
      }
      case 'relay.error': {
        this.lastError = String(frame.message || '云端连接器暂时不可用')
        this.closeSocket()
        this.scheduleReconnect()
        return
      }
      case 'welcome': {
        if (
          frame.deviceId !== this.pairing.deviceId ||
          frame.phoneId !== this.pairing.phoneId
        ) {
          this.lastError = '电脑返回的身份信息不一致'
          this.closeSocket()
          this.scheduleReconnect()
          return
        }
        clearTimeout(this.welcomeTimer)
        this.welcomeTimer = null
        this.connected = true
        this.attempt = 0
        this.lastError = ''
        if (this.currentUrl && this.currentUrl !== this.pairing.relayUrl) {
          this.pairing.fallbackUrl = this.pairing.relayUrl
          this.pairing.relayUrl = this.currentUrl
          this.urls = [this.pairing.relayUrl, this.pairing.fallbackUrl].filter(
            (url, index, list) => url && list.indexOf(url) === index,
          )
          this.urlIndex = 0
          savePairing(this.pairing)
        }
        this.startHeartbeat()
        this.setState('connected')
        try {
          this.handlers.onReady?.()
        } catch {
          // ignore
        }
        return
      }
      case 'message':
        this.handleEnvelope(frame.payload)
        return
      case 'error':
        this.handleError(frame)
        return
      case 'pair.revoked':
        this.fatal('revoked', String(frame.reason || '电脑已解除这台手机的配对'))
        return
      case 'pong':
        return
      default:
        return
    }
  }

  handleEnvelope(envelope) {
    let decoded
    try {
      decoded = decryptPayload(this.pcToPhone, envelope)
    } catch {
      return
    }
    if (decoded.seq <= this.inSeq) return
    this.inSeq = decoded.seq
    this.pairing.inSeq = decoded.seq
    savePairing(this.pairing)
    const value = decoded.value
    if (!value || typeof value !== 'object') return
    if (value.type === 'response') {
      const pending = this.pending.get(value.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(value.id)
      if (value.ok) pending.resolve(value.data)
      else pending.reject(new Error(value.error || '操作失败'))
      return
    }
    if (value.type === 'event') {
      try {
        this.handlers.onEvent?.(value.data)
      } catch {
        // ignore
      }
      return
    }
    if (value.type === 'pong') {
      this.lastFrameAt = Date.now()
    }
  }

  handleError(frame) {
    const message = String(frame.message || '电脑返回错误').slice(0, 300)
    const code = frame.code
    this.lastError = message
    if (code === 'replaced') {
      this.fatal('replaced', '这个配对正在另一处使用')
    } else if (code === 'auth_failed') {
      this.fatal('auth', message)
    } else if (code === 'pair_expired') {
      this.fatal('expired', '配对已过期，请在电脑上重新生成二维码')
    } else if (code === 'auth_required') {
      // 电脑端重启后旧虚拟连接未认证；重连并重新握手即可。
      this.lastError = '连接已失效，正在重新连接'
      this.rejectPending(this.lastError)
      this.closeSocket()
      this.scheduleReconnect()
    }
  }

  fatal(code, message) {
    this.stopped = true
    this.setState('error', message)
    this.closeSocket()
    try {
      this.handlers.onFatal?.({ code, message })
    } catch {
      // ignore
    }
  }
}

/* ── State ─────────────────────────────────────────────────────────────── */

const state = {
  pairing: loadPairing(),
  client: null,
  route: 'sessions',
  pendingPayload: null,
  // 直接打开这台电脑的服务地址时的自助接入状态（不走二维码）：
  // idle 未处理 / checking 正在申请 / choose 等待选定身份 / error 申请失败 /
  // unavailable 这个页面不是本机服务提供的（照旧扫码或粘贴配对链接）。
  access: { status: 'idle', local: false, requestedRole: 'client', error: '', busy: false },
  manualEntry: false,
  fatal: '',
  connection: 'idle',
  connectionMessage: '',
  deviceInfo: null,
  sessions: [],
  workspaces: [],
  workspaceRoots: [],
  workspaceRoot: '',
  workspaceDraft: '',
  workspaceBusy: false,
  workspacePath: '',
  workspaceParent: '',
  workspaceEntries: [],
  workspaceBrowseBusy: false,
  workspaceBrowseError: '',
  workspaceBrowseSeq: 0,
  workspaceTruncated: false,
  sessionId: null,
  session: null,
  plan: null,
  queue: [],
  approvals: [],
  hasMore: false,
  loadingEarlier: false,
  offline: false,
  cachedSession: null,
  schedules: {
    loading: false,
    items: [],
    error: '',
    content: '',
    kind: 'once',
    delay: '10',
    interval: '60',
    time: '09:00',
    busy: false,
  },
  running: false,
  live: null,
  loading: false,
  loadError: '',
  sessionsError: '',
  search: '',
  runningOnly: false,
  manualPair: '',
  composer: '',
  historyIndex: -1,
  historyDraft: '',
  todoDraft: '',
  todosOpen: false,
  delivery: 'queue',
  sending: false,
  menuOpen: false,
  sheet: null,
  files: { open: false, dir: '.', nodes: [], loading: false, error: '', preview: null },
  artifacts: { loading: false, items: [], error: '', preview: null },
  checkpoints: { loading: false, items: [], error: '', busy: '' },
  changes: { loading: false, items: [], error: '', busy: '', expanded: {} },
  resources: {
    loading: false,
    error: '',
    tab: 'links',
    links: [],
    tools: [],
    memory: [],
    knowledge: [],
    files: [],
    preview: null,
    loaded: {},
  },
  billing: { loading: false, error: '', report: null },
  models: { loading: false, resources: [], sessionModelId: '', approvalMode: '', error: '', busy: '' },
  learning: {
    loading: false,
    error: '',
    busy: '',
    enabled: false,
    hosts: [],
    effectiveHosts: [],
    defaultHosts: [],
    ledger: '',
    entryTotal: 0,
    summary: {},
    entries: [],
    hostsDraft: '',
  },
  check: {
    loading: false,
    error: '',
    busy: '',
    enabled: false,
    lastRunAt: '',
    nextRunAt: '',
    historyCount: 0,
    decisions: 0,
    proposals: 0,
    report: null,
    expanded: {},
    selfCheck: null,
  },
  evolution: {
    loading: false,
    error: '',
    busy: '',
    workspacePath: '',
    state: null,
  },
  quickCommands: [],  quickCommandsLoaded: false,
  expandedProcess: false,
  expandedItems: {},
  expandedReasoning: {},
  theme: (() => {
    try {
      const value = localStorage.getItem(THEME_KEY)
      return value === 'light' || value === 'dark' ? value : 'dark'
    } catch {
      return 'dark'
    }
  })(),
  scrollToBottom: false,
  focusComposer: false,
  runtime: { loading: false, sandbox: null, tools: [], error: '' },
  update: null,
}

const sessionRefreshTimer = { id: null }
const sessionsRefreshTimer = { id: null }
const processUpdateTimer = { id: null }

/* ── Icons ─────────────────────────────────────────────────────────────── */

const ICON_PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-3v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-3h.04A1.7 1.7 0 0 0 4.6 9.94a1.7 1.7 0 0 0-.34-1.88L4.2 8l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 9.29 4.7V4h3v.7a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L17.38 8l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H19v3h-.46A1.7 1.7 0 0 0 19.4 15Z"/>',
  phone:
    '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M10.5 5.5h3"/><circle cx="12" cy="18" r="0.9" fill="currentColor" stroke="none"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="7" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5" width="3.4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l11-6.5Z" fill="currentColor" stroke="none"/>',
  fork: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M8 7h5a5 5 0 0 1 5 5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>',
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  file: '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9Z"/><path d="M13 3v6h6"/>',
  spark: '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 9v5"/><circle cx="12" cy="17.2" r="0.8" fill="currentColor" stroke="none"/>',
  terminal: '<path d="m5 7 5 5-5 5M13 17h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
  insert: '<path d="M12 4v16M6 14l6 6 6-6"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.4"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 14h2v6h-2zM14 18h2v2h-2z"/>',
  menu: '<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
}

function icon(name, size = 18, className = '') {
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`
}

function brandMark(size = 22) {
  // 正体圆角 P，与桌面端 / 官网 / 手机 App 使用同一套字形。
  const p = 'M22.5 15H23.5A3.5 3.5 0 0 1 27 18.5V45.5A3.5 3.5 0 0 1 23.5 49H22.5A3.5 3.5 0 0 1 19 45.5V18.5A3.5 3.5 0 0 1 22.5 15Z' +
    'M22.5 15H33V23H22.5A3.5 3.5 0 0 1 19 19.5V18.5A3.5 3.5 0 0 1 22.5 15Z' +
    'M22.5 31H33V39H22.5A3.5 3.5 0 0 1 19 35.5V34.5A3.5 3.5 0 0 1 22.5 31Z' +
    'M33 15A12 12 0 0 1 33 39L33 31A4 4 0 0 0 33 23Z'
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="${p}"/></svg>`
}

/* ── Formatting / escaping ─────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function relativeTime(value) {
  if (!value) return ''
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function formatElapsed(value) {
  if (!value) return ''
  const start = new Date(value).getTime()
  if (!Number.isFinite(start)) return ''
  const ms = Math.max(0, Date.now() - start)
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function formatJson(value, max = 2000) {
  let text
  try {
    text = JSON.stringify(value ?? {}, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

function compactArgs(value) {
  let text
  try {
    text = JSON.stringify(value ?? {})
  } catch {
    text = String(value)
  }
  if (text === '{}') return ''
  return text.length > 100 ? `${text.slice(0, 100)}…` : text
}

function connectionLabel() {
  switch (state.connection) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    case 'disconnected':
      return '已断开'
    case 'error':
      return '连接异常'
    default:
      return '待连接'
  }
}

function runningNow() {
  return Boolean(state.running || state.live?.status === 'running')
}

function workspaceNameFor(path) {
  return state.workspaces.find((workspace) => workspace.path === path)?.name || path
}

function sessionWorkspaceName() {
  return state.session?.workspaceName || state.session?.workspacePath || ''
}

/* ── Markdown ──────────────────────────────────────────────────────────── */

function renderInlinePlain(text) {
  let value = escapeHtml(text)
  value = value.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  )
  value = value.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  value = value.replace(/\n/g, '<br>')
  return value
}

function renderInline(text) {
  let output = ''
  let last = 0
  const code = /`([^`\n]+)`/g
  let match
  while ((match = code.exec(text))) {
    output += renderInlinePlain(text.slice(last, match.index))
    output += `<code>${escapeHtml(match[1])}</code>`
    last = code.lastIndex
  }
  output += renderInlinePlain(text.slice(last))
  return output
}

function renderMarkdown(text) {
  const source = String(text ?? '')
  let output = ''
  let last = 0
  const fence = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g
  let match
  while ((match = fence.exec(source))) {
    const before = source.slice(last, match.index)
    output += before
      .split(/\n{2,}/)
      .filter((block) => block.trim())
      .map((block) => `<p>${renderInline(block.trim())}</p>`)
      .join('')
    output += `<pre><code>${escapeHtml(match[2])}</code></pre>`
    last = fence.lastIndex
  }
  const rest = source.slice(last)
  output += rest
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => `<p>${renderInline(block.trim())}</p>`)
    .join('')
  return output || '<p></p>'
}

function renderPlain(text) {
  return escapeHtml(text).replace(/\n/g, '<br>')
}

/* ── Toast / clipboard ─────────────────────────────────────────────────── */

let toastTimer = null

function showToast(message, level = 'info') {
  const layer = document.getElementById('toast-layer')
  if (!layer) return
  layer.innerHTML = `<div class="toast ${level}">${escapeHtml(message)}</div>`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    layer.innerHTML = ''
  }, level === 'error' ? 6000 : 3200)
}

/**
 * Synchronous legacy copy. Must run before any await so the tap's user
 * activation is still valid; used directly on LAN pages served over plain
 * HTTP, where navigator.clipboard does not exist.
 */
function legacyCopy(text) {
  let area = null
  try {
    area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '-9999px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, area.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (area?.parentNode) area.parentNode.removeChild(area)
  }
}

async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  // Insecure contexts (http://<LAN-IP>) have no navigator.clipboard. Do the
  // synchronous copy first: awaiting a rejected API would consume the user
  // gesture and make execCommand fail as well.
  if (window.isSecureContext === false || !navigator.clipboard?.writeText) {
    return legacyCopy(value)
  }
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return legacyCopy(value)
  }
}

/* ── Rendering: shared chrome ──────────────────────────────────────────── */

function connectionPill() {
  return `<span class="conn-pill ${state.connection}"><i class="dot"></i>${connectionLabel()}</span>`
}

/**
 * True when this page is the server-mode console rather than the phone PWA.
 * Server mode adds `data-surface="desktop"` to the document (see
 * `src/main/companion/server.ts`); the PWA never sets it.
 */
function isDesktopSurface() {
  return document.documentElement.dataset.surface === 'desktop'
}

function sessionsHeader() {
  const deviceName = state.deviceInfo?.deviceName || state.pairing?.deviceName || '电脑'
  // "手机连接" is the PWA's framing; the console is the browser face of the
  // server, so it names the host instead.
  const subtitle = isDesktopSurface() ? '服务器控制台' : '手机连接'
  return `<header class="app-header">
    <div class="brand">
      <span class="brand-mark">${brandMark(22)}</span>
      <div class="brand-text">
        <h1>Pilot</h1>
        <p>${escapeHtml(deviceName)} · ${subtitle}</p>
      </div>
    </div>
    <span class="header-spacer"></span>
    <div class="header-actions">
      ${connectionPill()}
      <button type="button" class="icon-button" data-action="open-settings" aria-label="设置">${icon('settings', 19)}</button>
    </div>
  </header>`
}

function chatHeader() {
  const title = state.session?.title || '会话'
  const workspace =
    state.session?.workspaceName ||
    (state.session?.workspacePath ? workspaceNameFor(state.session.workspacePath) : '')
  return `<header class="app-header">
    <button type="button" class="icon-button" data-action="back-sessions" aria-label="返回会话列表">${icon('back', 20)}</button>
    <div class="chat-title">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(workspace || 'Pilot')}</span>
    </div>
    ${connectionPill()}
    <div class="header-actions">
      <button type="button" class="icon-button" data-action="toggle-menu" aria-label="会话菜单">${icon('menu', 19)}</button>
    </div>
    ${state.menuOpen ? chatMenu() : ''}
  </header>`
}

function chatMenu() {
  return `<div class="sheet-backdrop" style="position:fixed;inset:0;background:transparent;backdrop-filter:none" data-action="close-menu">
    <div class="chat-menu" data-stop="true">
      <button type="button" data-action="rename-session">${icon('settings', 15)}重命名会话</button>
      <button type="button" data-action="open-artifacts">${icon('file', 15)}本次产出文件</button>
      <button type="button" data-action="open-files">${icon('folder', 15)}会话文件</button>
      <button type="button" data-action="open-resources">${icon('list', 15)}会话资源</button>
      <button type="button" data-action="open-changes">${icon('terminal', 15)}变更审阅</button>
      <button type="button" data-action="open-checkpoints">${icon('clock', 15)}回退点</button>
      <button type="button" data-action="open-models">${icon('spark', 15)}模型与权限</button>
      <button type="button" data-action="open-schedules">${icon('clock', 15)}定时任务</button>
      ${canManageHost() ? `<button type="button" data-action="open-learning">${icon('list', 15)}自主学习</button>` : ''}
      ${canManageHost() ? `<button type="button" data-action="open-check">${icon('check', 15)}体检</button>
      <button type="button" data-action="open-evolution">${icon('spark', 15)}自我进化</button>` : ''}
      <button type="button" data-action="copy-transcript">${icon('copy', 15)}复制全部对话</button>
      <button type="button" data-action="fork-session">${icon('fork', 15)}创建会话副本</button>
      ${state.session?.running ? '' : `<button type="button" data-action="retry-run">${icon('refresh', 15)}重新执行上一轮</button>`}
      <button type="button" class="danger" data-action="delete-session">${icon('trash', 15)}删除这个会话</button>
      <button type="button" data-action="open-settings">${icon('phone', 15)}连接设置</button>
    </div>
  </div>`
}

function sandboxTitle() {
  const sandbox = state.runtime.sandbox
  if (!sandbox) return state.runtime.loading ? '正在检查沙箱…' : '沙箱状态未知'
  if (sandbox.mode === 'off') return '沙箱已关闭'
  return sandbox.available ? `沙箱已启用（${sandbox.backend}）` : '没有可用的系统沙箱'
}

function sandboxDetail() {
  const sandbox = state.runtime.sandbox
  if (state.runtime.error) return state.runtime.error
  if (!sandbox) return '在电脑上检查后显示'
  const network = sandbox.networkIsolation ? '可阻断外网访问' : '未能隔离外网'
  return `${sandbox.detail || ''}${sandbox.detail ? ' · ' : ''}${network}`
}

function updateVersionLabel() {
  const update = state.update
  const current = update?.currentVersion ? `当前 ${update.currentVersion}` : '当前版本未知'
  if (update?.status === 'available' && update.release) {
    return `${current} → ${update.release.version}`
  }
  return current
}

/**
 * What this host can actually do, declared by the host in `device.info`.
 * Absent on older hosts, so every read must tolerate `null` and fall back to
 * the desktop assumption the panel shipped with.
 */
function capabilities() {
  const declared = state.deviceInfo && state.deviceInfo.capabilities
  return declared && typeof declared === 'object' ? declared : null
}

/**
 * 这次页面是以谁的身份在用这台电脑。服务端在 device.info 里下发四档：
 * local（本机）/ paired（扫码配对的本机手机）/ host（被批准为主机用户的远端）
 * / client（客户机用户，独立身份与独立数据）。
 *
 * 不认识的取值一律按 client：主机升级后下发的新身份不能因为这份前端没更新
 * 就被当成「本机」，宁可少几个入口也不能多给权限。旧主机不发这个字段，
 * 才是真的本机页面（那里也没有远端访问）。
 */
function accessLevel() {
  const level = state.deviceInfo && state.deviceInfo.accessLevel
  if (level === 'local' || level === 'paired' || level === 'host') return level
  if (level === 'client') return 'client'
  return level === undefined || level === null ? 'local' : 'client'
}

/** 客户机用户：独立身份，只有工作内容，动不了这台电脑本身。 */
function isClientUser() {
  return accessLevel() === 'client'
}

/**
 * 能不能改这台电脑本身（升级、进化、反思、计费、挂载目录、改模型）。
 * 本机、扫码配对的本机手机、以及被批准为主机用户的远端都是全部功能；
 * 客户机用户只给工作内容。
 */
function canManageHost() {
  return !isClientUser()
}

function updateDetailLabel() {
  const update = state.update
  if (!update) return '在电脑上检查后显示'
  if (update.status === 'disabled') return '这台电脑的安装方式不支持自己升级'
  if (update.status === 'downloading') {
    return `下载中 ${Math.round((update.progress || 0) * 100)}%（${update.transferred}/${update.total} 字节）`
  }
  return update.message || '可以检查新版本'
}

/** One button at a time: check → download → install, matching the host state. */
function updateActionsHtml() {
  const update = state.update
  const busy = ['checking', 'downloading', 'installing'].includes(update?.status)
  if (busy) {
    return `<button type="button" class="button ghost small" disabled><span class="spinner"></span>${escapeHtml(
      update.status === 'checking' ? '检查中…' : update.status === 'downloading' ? '下载中…' : '安装中…',
    )}</button>`
  }
  if (update?.canInstall) {
    // A server install rewrites files in place and needs the service restarted,
    // so "安装并重启" would be a lie: nothing restarts on its own there.
    const files = capabilities()?.update === 'files'
    return `<button type="button" class="button primary small" data-action="update-install">${icon('refresh', 14)}${files ? '应用更新（需重启服务）' : '安装并重启'}</button>`
  }
  if (update?.status === 'available') {
    return `<button type="button" class="button primary small" data-action="update-download">${icon('refresh', 14)}下载更新</button>`
  }
  return `<button type="button" class="button ghost small" data-action="update-check">${icon('refresh', 14)}检查更新</button>`
}

/** Sandbox backend and agent-written tools, read on demand from the host. */
async function loadRuntime() {
  if (!state.client?.connected) return
  state.runtime.loading = true
  state.runtime.error = ''
  if (state.route === 'settings') render()
  try {
    const sandbox = await state.client.request('sandbox.status')
    state.runtime.sandbox = sandbox?.status || null
    const update = await state.client.request('update.state')
    state.update = update?.state || null
    const workspacePath = state.session?.workspacePath || state.workspaces[0]?.path || ''
    if (workspacePath) {
      const listed = await state.client.request('tools.list', { workspacePath })
      state.runtime.tools = Array.isArray(listed?.tools) ? listed.tools : []
    } else {
      state.runtime.tools = []
    }
  } catch (error) {
    state.runtime.error = methodError(error)
  } finally {
    state.runtime.loading = false
    if (state.route === 'settings') render()
  }
}

function settingsHeader() {
  return `<header class="app-header">
    <button type="button" class="icon-button" data-action="back-sessions" aria-label="返回会话列表">${icon('back', 20)}</button>
    <div class="chat-title">
      <strong>设置</strong>
      <span>连接、外观与安全</span>
    </div>
  </header>`
}

/* ── Rendering: pair view ──────────────────────────────────────────────── */

function renderPair() {
  const pending = state.pendingPayload
  const paired = state.pairing
  const error = state.fatal
  const access = state.access
  // 直接打开服务地址时的自助接入：只在尚未拿到配对凭据时占用这个页面。
  const accessView =
    !pending &&
    (access.status === 'checking' || access.status === 'choose' || access.status === 'error')
  const manual = !pending && !accessView && (!paired || state.manualEntry)
  const device = pending?.deviceName || paired?.deviceName || '电脑'
  const address = pending?.relayUrl?.replace(/^ws/, 'http')?.replace(/\/ws$/, '') || ''
  return `<div class="pair-page">
    <div class="pair-hero">
      <span class="pair-logo">${brandMark(44)}</span>
      <h1>${pending ? '连接 Pilot' : accessView ? '访问这台电脑' : 'Pilot 手机端'}</h1>
      <p>${pending ? '确认连接后，你可以在手机上继续电脑上的任务、查看执行过程并审批工具调用。' : accessView ? '这个页面由电脑上的 Pilot 直接提供。选定以什么身份使用它，再由电脑前的人确认。' : paired && !manual ? '已保存这台电脑的配对，可以继续使用，也可以扫描新的二维码重新配对。' : '在电脑上打开 Pilot，点击顶栏的手机图标生成二维码，然后用手机扫描；也可以粘贴电脑上复制的配对链接。'}</p>
    </div>

    <div class="card">
      <div class="card-body">
        ${
          pending
            ? `<h3>准备配对</h3>
            <p>即将连接的电脑</p>
            <div class="device-chip">
              <span class="device-chip-icon">${icon('phone', 19)}</span>
              <div>
                <strong>${escapeHtml(device)}</strong>
                <span>${escapeHtml(address || '局域网连接')}</span>
              </div>
            </div>
            <button type="button" class="button primary block" id="pair-button" data-action="confirm-pair">${icon('link', 17)}确认配对</button>
            <div class="pair-note">${icon('spark', 16)}<span>手机与电脑之间的消息使用端到端加密，配对完成后凭证只保存在这台手机和电脑上。</span></div>`
            : accessView
              ? renderAccessCard(access)
              : paired && !manual
              ? `<h3>已配对</h3>
              <p>这台手机已经可以连接 ${escapeHtml(device)}。</p>
              <div class="device-chip">
                <span class="device-chip-icon">${icon('phone', 19)}</span>
                <div>
                  <strong>${escapeHtml(device)}</strong>
                  <span>${escapeHtml(paired.phoneName || '手机')} · ${relativeTime(paired.pairedAt)}配对</span>
                </div>
              </div>
              <button type="button" class="button primary block" data-action="continue-paired">${icon('arrow', 17)}继续使用</button>
              <div class="pair-actions">
                <button type="button" class="button ghost block" data-action="show-manual-pair">${icon('qr', 17)}使用新的配对链接</button>
              </div>`
              : `<h3>等待配对</h3>
              <p>先确保手机和电脑连接同一个局域网。扫码会自动打开这个页面；也可以粘贴电脑上复制的配对链接。</p>
              <div class="manual-pair">
                <textarea id="manual-pair-input" class="text-input" placeholder="粘贴配对链接…">${escapeHtml(state.manualPair)}</textarea>
                <button type="button" class="button primary block" data-action="manual-pair">${icon('link', 17)}连接</button>
              </div>`
        }
        ${error ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(error)}</span></div>` : ''}
      </div>
    </div>

    ${
      pending
        ? `<div class="pair-actions"><button type="button" class="button ghost block" data-action="manual-pair-cancel">使用其他配对链接</button></div>`
        : manual && paired
          ? `<div class="pair-actions"><button type="button" class="button ghost block" data-action="cancel-manual-pair">返回已配对</button></div>`
          : ''
    }
    <div class="pair-note" style="margin-top:18px">${icon('alert', 16)}<span>请只在可信网络中开启手机连接。Pilot 不会上传会话内容或 API Key，也不会要求登录。</span></div>
  </div>`
}

/**
 * 远端浏览器的身份选择。两种身份的区别写在按钮下面，因为这一步决定了
 * 对方能不能看到这台电脑上的历史会话、能不能改这台电脑本身。
 */
function renderAccessCard(access) {
  if (access.status === 'checking') {
    return `<h3>正在申请访问</h3>
      <p>正在向这台电脑确认这个地址是否可以接入…</p>`
  }
  if (access.status === 'error') {
    return `<h3>没能接入这台电脑</h3>
      <p>${escapeHtml(access.error || '申请访问失败，请重试')}</p>
      <button type="button" class="button primary block" data-action="access-host">${icon('link', 17)}以主机用户重试</button>
      <div class="pair-actions">
        <button type="button" class="button ghost block" data-action="access-client">以客户机用户重试</button>
        <button type="button" class="button ghost block" data-action="access-skip">改用配对链接</button>
      </div>`
  }
  return `<h3>选择接入身份</h3>
    <p>申请后需要电脑前的人确认；对方也可以改成另一种身份。</p>
    <button type="button" class="button primary block" data-action="access-host" ${access.busy ? 'disabled' : ''}>
      ${icon('phone', 17)}以主机用户接入
    </button>
    <div class="pair-note">${icon('spark', 16)}<span>主机用户：看到和电脑上相同的会话、文件与设置，也能改这台电脑本身。</span></div>
    <button type="button" class="button ghost block" data-action="access-client" ${access.busy ? 'disabled' : ''}>
      ${icon('list', 17)}以客户机用户接入
    </button>
    <div class="pair-note">${icon('alert', 16)}<span>客户机用户：独立的会话与工作区，看不到这台电脑上其他会话，也动不了它的设置、升级或计费。</span></div>
    <div class="pair-actions">
      <button type="button" class="button ghost block" data-action="access-skip">我有配对链接</button>
    </div>`
}

/* ── Rendering: sessions ───────────────────────────────────────────────── */

function filteredSessions() {
  const query = state.search.trim().toLowerCase()
  return state.sessions.filter((session) => {
    if (state.runningOnly && !session.running && !session.paused) return false
    if (!query) return true
    return (
      session.title.toLowerCase().includes(query) ||
      (session.workspaceName || '').toLowerCase().includes(query) ||
      session.workspacePath.toLowerCase().includes(query)
    )
  })
}

function sessionPreview(session) {
  if (session.running && session.runInstruction) return `正在：${session.runInstruction}`
  if (session.running) return '任务执行中…'
  if (session.paused && session.pauseInstruction) return `已暂停：${session.pauseInstruction}`
  if (session.paused) return '已暂停，可从中断处继续'
  if (session.queueCount > 0) return `${session.queueCount} 条排队消息`
  return ''
}

function sessionListHtml() {
  const sessions = filteredSessions()
  if (state.sessionsError && state.sessions.length === 0) {
    return `<div class="empty-state">
      <span class="empty-state-icon" style="color:var(--red)">${icon('alert', 25)}</span>
      <strong>读取会话失败</strong>
      <p>${escapeHtml(state.sessionsError)}</p>
      <button type="button" class="button ghost small" data-action="retry-sessions">${icon('refresh', 14)}重试</button>
    </div>`
  }
  if (state.loading && state.sessions.length === 0) {
    return `<div class="empty-state"><span class="spinner"></span><p>正在读取会话…</p></div>`
  }
  if (sessions.length === 0) {
    return `<div class="empty-state">
      <span class="empty-state-icon">${icon('list', 26)}</span>
      <strong>${state.search ? '没有匹配的会话' : '还没有会话'}</strong>
      <p>${state.search ? '换一个关键词试试。' : '在电脑上开始一个任务，或点右下角新建会话。'}</p>
    </div>`
  }
  return `<div class="session-list">${sessions
    .map((session) => {
      const running = session.running
      const paused = session.paused
      const elapsed = running && session.runStartedAt ? formatElapsed(session.runStartedAt) : ''
      return `<button type="button" class="session-card${running ? ' is-running' : ''}${paused ? ' is-paused' : ''}" data-action="open-session" data-id="${escapeHtml(session.id)}">
        <span class="session-avatar">${
          running ? `<span class="live-dot"></span>` : paused ? icon('pause', 16) : icon('spark', 17)
        }</span>
        <span class="session-main">
          <span class="session-title"><span>${escapeHtml(session.title)}</span></span>
          <span class="session-meta">
            <span>${escapeHtml(session.workspaceName || workspaceNameFor(session.workspacePath))}</span>
            <span class="sep">·</span>
            <span>${escapeHtml(elapsed ? `已运行 ${elapsed}` : relativeTime(session.updatedAt))}</span>
          </span>
          ${sessionPreview(session) ? `<span class="session-preview">${escapeHtml(sessionPreview(session))}</span>` : ''}
          <span class="session-shortcuts">${SESSION_SHORTCUTS.map(
            (entry) =>
              `<span class="session-chip" data-action="open-session-resources" data-id="${escapeHtml(session.id)}" data-tab="${entry.id}">${entry.label}</span>`,
          ).join('')}</span>
        </span>
        <span class="session-badges">
          ${running ? `<span class="badge mint">执行中</span>` : ''}
          ${paused ? `<span class="badge paused">暂停</span>` : ''}
          ${session.todoCount > 0 ? `<span class="badge todo">待办 ${session.todoCount}</span>` : ''}
          ${session.queueCount > 0 ? `<span class="badge queue">${session.queueCount}</span>` : ''}
        </span>
      </button>`
    })
    .join('')}</div>`
}

/**
 * 浏览器直连时的能力说明。
 * 比“点了才报错”更直接：进来就知道自己能做什么、不能做什么。
 */
function remoteAccessNotice() {
  if (accessLevel() === 'client') {
    return `<div class="notice-banner" style="margin:0 0 12px;padding:10px 12px;border-radius:10px;background:rgba(255,176,32,.12);display:flex;gap:8px;align-items:flex-start">
      ${icon('alert', 15)}
      <div style="font-size:13px;line-height:1.5">
        <strong>客户机用户</strong><br/>
        这里只属于你自己：会话、工作区与记忆都是独立的一份，看不到这台电脑上其他人的内容。升级、进化、反思、计费与挂载目录由电脑上的人操作。
      </div>
    </div>`
  }
  return ''
}

function renderSessions() {
  return `<div class="sessions-page">
    ${sessionsHeader()}
    <div class="page">
      ${remoteAccessNotice()}
      <div class="search-box">
        ${icon('search', 17)}
        <input id="session-search" type="search" value="${escapeHtml(state.search)}" placeholder="搜索会话或工作区" autocomplete="off" />
      </div>
      <div class="session-filters">
        <button type="button" class="filter-chip${state.runningOnly ? ' is-active' : ''}" data-action="toggle-running-filter">
          <i class="live-dot${state.sessions.some((session) => session.running) ? '' : ' idle'}"></i>
          执行中 ${state.sessions.filter((session) => session.running).length}
        </button>
      </div>
      <div class="section-label">最近会话 <span>${filteredSessions().length}</span></div>
      <div id="session-list">${sessionListHtml()}</div>
    </div>
    <button type="button" class="fab" data-action="new-session" aria-label="新建会话">${icon('plus', 23)}</button>
    ${state.sheet === 'workspace' ? renderWorkspaceSheet() : ''}
  </div>`
}

function selectedWorkspaceRoot() {
  const roots = Array.isArray(state.workspaceRoots) ? state.workspaceRoots : []
  return roots.includes(state.workspaceRoot) ? state.workspaceRoot : roots[0] ?? ''
}

function workspaceBrowseLabel(root, path) {
  if (!path) return root
  return `${String(root || '').replace(/[\\/]+$/, '')} / ${path.split('/').join(' / ')}`
}

function renderWorkspaceBrowser() {
  const roots = Array.isArray(state.workspaceRoots) ? state.workspaceRoots : []
  if (roots.length === 0) return ''
  const root = selectedWorkspaceRoot()
  const path = state.workspacePath
  const entries = Array.isArray(state.workspaceEntries) ? state.workspaceEntries : []
  const list = state.workspaceBrowseBusy
    ? '<p class="workspace-browse-empty">正在读取文件夹…</p>'
    : state.workspaceBrowseError
      ? `<p class="workspace-browse-empty">${escapeHtml(state.workspaceBrowseError)}</p>`
      : entries.length === 0
        ? '<p class="workspace-browse-empty">这里还没有子文件夹，可以在下面新建</p>'
        : entries
            .map(
              (entry) =>
                `<button type="button" class="workspace-browse-row" data-action="workspace-enter" data-path="${escapeHtml(entry.path)}">${icon('folder', 14)}<span>${escapeHtml(entry.name)}</span>${icon('arrow', 13)}</button>`,
            )
            .join('')
  return `<div class="workspace-browser">
    <div class="workspace-browser-head">
      <span class="workspace-browser-path">${escapeHtml(workspaceBrowseLabel(root, path))}</span>
      ${path ? '<button type="button" class="workspace-browser-up" data-action="workspace-up">上一级</button>' : ''}
    </div>
    <div class="workspace-browser-list">
      ${list}
      ${state.workspaceTruncated ? '<p class="workspace-browse-empty">文件夹太多，只显示前 300 个</p>' : ''}
    </div>
    <button type="button" class="workspace-open-button" data-action="open-workspace"${state.workspaceBusy || state.workspaceBrowseBusy ? ' disabled' : ''}>使用此文件夹</button>
  </div>`
}

function renderWorkspaceCreate() {
  const roots = Array.isArray(state.workspaceRoots) ? state.workspaceRoots : []
  if (roots.length === 0) return ''
  const root = selectedWorkspaceRoot()
  const choices =
    roots.length > 1
      ? `<label class="workspace-root-field">
          <span>授权目录</span>
          <select id="workspace-root">
            ${roots
              .map(
                (entry) =>
                  `<option value="${escapeHtml(entry)}"${entry === root ? ' selected' : ''}>${escapeHtml(entry)}</option>`,
              )
              .join('')}
          </select>
        </label>`
      : `<p class="workspace-root-hint">授权目录 <code>${escapeHtml(root)}</code></p>`
  return `<div class="workspace-create">
    ${choices}
    ${renderWorkspaceBrowser()}
    <div class="workspace-create-row">
      <input id="workspace-name-input" type="text" maxlength="64" placeholder="新文件夹名称" value="${escapeHtml(state.workspaceDraft)}" autocomplete="off" spellcheck="false" />
      <button type="button" class="workspace-create-button" data-action="create-workspace"${state.workspaceDraft.trim() ? '' : ' disabled'}>新建</button>
    </div>
    <span class="workspace-create-note">可把任意层级的已有文件夹作为工作区，也可以在当前浏览的位置新建；文件夹由电脑端校验后创建。</span>
  </div>`
}

function renderWorkspaceSheet() {
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>新建会话</h3>
          <p>选择电脑上的一个工作区，或在授权目录里新建</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      <div class="sheet-list">
        ${canManageHost() ? renderWorkspaceCreate() : ''}
        ${
          state.workspaces.length === 0
            ? `<div class="empty-state"><strong>电脑上还没有打开工作区</strong><p>${
                !canManageHost()
                  ? '远程访问不能挂载或新建目录，请让电脑上的人先打开一个工作区。'
                  : state.workspaceRoots.length > 0
                    ? '可以在上方输入名称新建一个工作区。'
                    : '请在电脑端先打开一个工作区，或在「手机连接」里授权可创建的目录。'
              }</p></div>`
            : state.workspaces
                .map(
                  (workspace) => `<div class="sheet-row-group">
                    <button type="button" class="sheet-row" data-action="select-workspace" data-path="${escapeHtml(workspace.path)}">
                      <span class="sheet-row-icon">${icon('folder', 17)}</span>
                      <div><strong>${escapeHtml(workspace.name)}</strong><span>${escapeHtml(workspace.path)}</span></div>
                      ${icon('arrow', 15)}
                    </button>
                    ${
                      state.workspaces.length <= 1
                        ? ''
                        : `<button type="button" class="sheet-row-remove" data-action="remove-workspace" data-path="${escapeHtml(workspace.path)}" aria-label="从列表移除 ${escapeHtml(workspace.name)}">${icon('trash', 15)}</button>`
                    }
                  </div>`,
                )
                .join('')
        }
      </div>
    </div>
  </div>`
}

/* ── Rendering: chat ───────────────────────────────────────────────────── */

function messageHtml(message) {
  if (message.role !== 'user' && message.role !== 'assistant') return ''
  if (message.role === 'user' && message.control) {
    return `<div class="control-message">${icon('spark', 11)}<span>从中断处继续任务</span></div>`
  }
  const content = String(message.content || '')
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
  if (!content.trim() && message.role === 'assistant') {
    if (toolCalls.length === 0) return ''
    return `<div class="message assistant">
      <div class="message-tools">${toolCalls
        .map((call) => `<span>${icon('terminal', 10)}${escapeHtml(call.name || 'tool')}</span>`)
        .join('')}</div>
    </div>`
  }
  const isUser = message.role === 'user'
  return `<article class="message ${isUser ? 'user' : 'assistant'}" data-message-id="${escapeHtml(message.id)}">
    <div class="message-head">
      <span class="message-avatar">${isUser ? '你' : brandMark(13)}</span>
      <span>${isUser ? '你' : 'Pilot'}</span>
      <span>${escapeHtml(formatTime(message.createdAt))}</span>
    </div>
    <div class="bubble">${isUser ? renderPlain(content) : renderMarkdown(content)}</div>
    ${toolCalls.length > 0 ? `<div class="message-tools">${toolCalls
      .map((call) => `<span>${icon('terminal', 10)}${escapeHtml(call.name || 'tool')}</span>`)
      .join('')}</div>` : ''}
    ${message.reasoning ? `<details class="message-reasoning"><summary>思考过程</summary><div>${escapeHtml(message.reasoning)}</div></details>` : ''}
    ${content ? `<div class="message-actions"><button type="button" data-action="copy-message" data-id="${escapeHtml(message.id)}">${icon('copy', 11)}复制</button></div>` : ''}
  </article>`
}

function messagesHtml() {
  const messages = state.session?.messages || []
  return messages.map(messageHtml).join('')
}

function liveMessageHtml() {
  if (!state.live?.text) return ''
  return `<article class="message assistant live-bubble">
    <div class="message-head">
      <span class="message-avatar">${brandMark(13)}</span>
      <span>Pilot</span>
      <span>${runningNow() ? '正在回复' : ''}</span>
    </div>
    <div class="bubble" data-live-content>${renderMarkdown(state.live.text)}<span class="stream-caret"></span></div>
  </article>`
}

function typingHtml() {
  if (!runningNow() || state.live?.text) return ''
  return `<div class="typing"><span class="spinner small"></span><span>Pilot 正在处理</span><span class="typing-dots"><i></i><i></i><i></i></span></div>`
}

function planHtml() {
  const plan = state.plan
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return ''
  const running = runningNow()
  const items = plan.items.map((item) => {
    const isDone = item.status === 'done' || (!running && item.status === 'in_progress')
    const isActive = item.status === 'in_progress' && running
    return {
      ...item,
      isDone,
      isActive,
      className: isDone ? 'done' : isActive ? 'active' : 'pending',
    }
  })
  const done = items.filter((item) => item.isDone).length
  const percent = Math.round((done / items.length) * 100)
  return `<section class="plan-card">
    <div class="plan-head">
      ${icon('list', 15)}
      <strong>${escapeHtml(plan.goal || '执行计划')}</strong>
      <span>${done}/${items.length}</span>
    </div>
    <div class="plan-progress"><i style="width:${percent}%"></i></div>
    <div class="plan-items">
      ${items
        .map(
          (item) => `<div class="plan-item ${item.className}">
            <span class="marker">${icon('check', 10)}</span>
            <span>${escapeHtml(item.text)}</span>
          </div>`,
        )
        .join('')}
    </div>
  </section>`
}

function toolStatus(tool) {
  if (tool.status === 'waiting') return 'waiting'
  if (tool.status === 'error' || tool.status === 'denied') return 'error'
  if (tool.status === 'ok') return 'ok'
  return 'running'
}

function toolStatusIcon(tool) {
  if (tool.status === 'waiting') return icon('alert', 10)
  if (tool.status === 'error' || tool.status === 'denied') return icon('close', 10)
  if (tool.status === 'ok') return icon('check', 10)
  return `<span class="spinner small" style="width:9px;height:9px;border-width:1.5px"></span>`
}

function processItems() {
  const live = state.live
  if (!live) return []
  const items = []
  if (live.reasoning?.trim()) {
    items.push({ kind: 'reasoning', id: 'reasoning', text: live.reasoning, status: 'ok' })
  }
  for (const tool of live.tools || []) {
    items.push({ kind: 'tool', ...tool })
  }
  return items
}

function processItemHtml(item) {
  if (item.kind === 'reasoning') {
    const expanded = Boolean(state.expandedReasoning.reasoning)
    return `<div class="process-item ok" data-kind="reasoning">
      <button type="button" class="process-row" data-action="toggle-process-item" data-kind="reasoning" data-id="reasoning">
        <span class="process-icon">${icon('spark', 10)}</span>
        <span class="process-text"><strong>思考</strong> ${escapeHtml(item.text.slice(0, 120))}</span>
      </button>
      ${expanded ? `<div class="process-detail">${escapeHtml(item.text)}</div>` : ''}
    </div>`
  }
  const status = toolStatus(item)
  const expanded = Boolean(state.expandedItems[item.id])
  const args = compactArgs(item.args)
  const result = item.result?.output || item.result?.error || ''
  return `<div class="process-item ${status}" data-kind="tool">
    <button type="button" class="process-row" data-action="toggle-process-item" data-kind="tool" data-id="${escapeHtml(item.id)}">
      <span class="process-icon">${toolStatusIcon(item)}</span>
      <span class="process-text"><strong>${escapeHtml(item.name)}</strong>${args ? ` ${escapeHtml(args)}` : ''}</span>
    </button>
    ${
      expanded
        ? `<div class="process-detail">${escapeHtml(
            `参数\n${formatJson(item.args, 1200)}${result ? `\n\n结果\n${String(result).slice(0, 4000)}` : ''}`,
          )}</div>`
        : ''
    }
  </div>`
}

function processHtml() {
  const items = processItems()
  if (items.length === 0) return ''
  const shown = state.expandedProcess ? items : items.slice(-5)
  return `<section class="process-panel${state.expandedProcess ? ' expanded' : ''}">
    <button type="button" class="process-head" data-action="toggle-process">
      ${icon('terminal', 13)}
      <strong>执行过程</strong>
      <span class="count">${items.length} 项</span>
      ${icon('chevron', 13, 'chev')}
    </button>
    <div class="process-list">${shown.map(processItemHtml).join('')}</div>
  </section>`
}

function riskLabel(risk) {
  if (risk === 'write') return '写入'
  if (risk === 'exec') return '执行'
  if (risk === 'control') return '控制'
  return '读取'
}

function countdownLabel(expiresAt) {
  const target = new Date(expiresAt).getTime()
  if (!Number.isFinite(target)) return ''
  const left = target - Date.now()
  if (left <= 0) return '即将自动拒绝'
  const seconds = Math.ceil(left / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')} 后自动拒绝`
}

function approvalCountdownHtml(approval) {
  if (!approval.expiresAt) return ''
  const left = new Date(approval.expiresAt).getTime() - Date.now()
  return `<span class="approval-countdown${left <= 30_000 ? ' urgent' : ''}" data-expires="${escapeHtml(
    approval.expiresAt,
  )}">${escapeHtml(countdownLabel(approval.expiresAt))}</span>`
}

function updateApprovalCountdowns() {
  const nodes = document.querySelectorAll('.approval-countdown[data-expires]')
  if (!nodes.length) return
  nodes.forEach((node) => {
    const expiresAt = node.getAttribute('data-expires') || ''
    const left = new Date(expiresAt).getTime() - Date.now()
    node.textContent = countdownLabel(expiresAt)
    node.classList.toggle('urgent', left <= 30_000)
  })
}

/**
 * 能不能放行一条待批调用。命令类工具（risk=exec）批一次就等于把这台电脑的
 * 命令行交给远端浏览器，所以只留给电脑前的人；读和写在工作区限制内，远端可以批。
 */
function canApprove(approval) {
  return canManageHost() || approval.risk !== 'exec'
}

function approvalsHtml() {
  if (!state.approvals.length) return ''
  return state.approvals
    .map(
      (approval) => `<section class="approval-card">
        <div class="approval-head">${icon('alert', 12)}需要审批<span class="risk">${escapeHtml(riskLabel(approval.risk))}</span>${approvalCountdownHtml(approval)}</div>
        <div class="approval-body">
          <strong>${escapeHtml(approval.tool)}</strong>
          <pre>${escapeHtml(formatJson(approval.arguments, 1800))}</pre>
        </div>
        ${
          approval.tool === 'run_shell'
            ? `<div class="approval-shell-warning">${icon('alert', 12)}Shell 命令可访问工作区之外的文件和网络；当前模式下需要你确认。</div>`
            : ''
        }
        ${
          canApprove(approval)
            ? ''
            : `<div class="approval-shell-warning">${icon('alert', 12)}这条命令会在这台电脑上执行，只能由电脑前的人批准。你也可以拒绝。</div>`
        }
        <div class="approval-actions">
          <button type="button" class="deny" data-action="approval-deny" data-call="${escapeHtml(approval.callId)}">拒绝</button>
          ${canApprove(approval) ? `<button type="button" data-action="approval-always" data-call="${escapeHtml(approval.callId)}" data-session="${escapeHtml(approval.sessionId)}">本会话改为全部自动</button>
          <button type="button" class="allow" data-action="approval-allow" data-call="${escapeHtml(approval.callId)}">允许</button>` : ''}
        </div>
      </section>`,
    )
    .join('')
}

function queueHtml() {
  if (!state.queue.length) return ''
  return `<div class="queue-chips">${state.queue
    .map(
      (item) => `<span class="queue-chip">
        ${icon('clock', 10)}
        <span>${escapeHtml(item.content)}</span>
        <button type="button" data-action="queue-insert" data-id="${escapeHtml(item.id)}" title="插入当前任务">${icon('insert', 10)}</button>
        <button type="button" data-action="queue-remove" data-id="${escapeHtml(item.id)}" title="删除">${icon('close', 10)}</button>
      </span>`,
    )
    .join('')}</div>`
}

function disconnectedBar() {
  if (state.connection === 'connected' || state.connection === 'connecting') return ''
  return `<div class="disconnected-bar">${icon('alert', 13)}<span>${escapeHtml(state.connectionMessage || '与电脑的连接已断开')}</span><button type="button" data-action="retry-connect">重连</button></div>`
}

function todoItemHtml(todo) {
  const sent = todo.status === 'sent'
  return `<div class="todo-item${sent ? ' sent' : ''}">
    <button type="button" class="todo-send" data-action="todo-send" data-id="${escapeHtml(todo.id)}" title="${sent ? '已发送' : '发送给 Pilot'}"${sent ? ' disabled' : ''}>${icon(sent ? 'check' : 'send', 11)}</button>
    <button type="button" class="todo-text" data-action="todo-edit" data-id="${escapeHtml(todo.id)}" title="点击编辑">${escapeHtml(todo.text)}</button>
    <button type="button" class="todo-remove" data-action="todo-remove" data-id="${escapeHtml(todo.id)}" title="删除">${icon('close', 11)}</button>
  </div>`
}

function todosHtml() {
  if (!state.session) return ''
  const todos = Array.isArray(state.session.todos) ? state.session.todos : []
  const pending = todos.filter((todo) => todo.status !== 'sent')
  const sent = todos.filter((todo) => todo.status === 'sent')
  const label = pending.length > 0 ? `待办 ${pending.length}` : '待办'
  return `<section class="todo-card${state.todosOpen ? ' open' : ''}">
    <div class="todo-head">
      <button type="button" class="todo-toggle" data-action="toggle-todos" aria-expanded="${state.todosOpen}">
        ${icon('check', 12)}
        <strong>${label}</strong>
        ${sent.length > 0 ? `<span>${sent.length} 已发送</span>` : ''}
        ${icon('chevron', 12, 'chev')}
      </button>
      <button type="button" class="todo-add-open" data-action="toggle-todos" title="添加待办" aria-label="添加待办">${icon('plus', 13)}</button>
    </div>
    ${
      state.todosOpen
        ? `<div class="todo-body">
            ${
              todos.length > 0
                ? `<div class="todo-list">${todos.map(todoItemHtml).join('')}</div>`
                : `<div class="todo-empty">还没有待办，添加后可以随时发给 Pilot。</div>`
            }
            <form class="todo-add" id="todo-form" autocomplete="off">
              <input id="todo-input" maxlength="4000" placeholder="添加一条待办…" value="${escapeHtml(state.todoDraft)}" />
              <button type="submit" id="todo-submit"${state.todoDraft.trim() ? '' : ' disabled'}>${icon('plus', 15)}</button>
            </form>
            ${
              pending.length > 1 || sent.length > 0
                ? `<div class="todo-actions">
                    ${pending.length > 1 ? `<button type="button" data-action="todo-send-all">${icon('send', 11)}发送全部</button>` : ''}
                    ${sent.length > 0 ? `<button type="button" data-action="todo-clear-sent">清理已发送</button>` : ''}
                  </div>`
                : ''
            }
          </div>`
        : ''
    }
  </section>`
}

function continueBarHtml() {
  if (runningNow() || !state.session) return ''
  if (!state.session.paused && !state.session.canContinue) return ''
  const paused = Boolean(state.session.paused)
  const hint = paused
    ? state.session.pauseInstruction || '任务已暂停，可从中断处继续。'
    : '上次执行中断，可从中断处继续。'
  return `<div class="continue-bar">
    ${icon('play', 12)}
    <span>${escapeHtml(hint.slice(0, 140))}</span>
    <button type="button" data-action="resume-run">继续</button>
  </div>`
}

function quickCommandLabel(command) {
  const text = String(command?.content || '').trim().split('\n')[0]
  return text.length > 16 ? `${text.slice(0, 16)}…` : text || '快捷指令'
}

/**
 * 快捷指令是电脑端设置里维护的整段提示词，点一下就填进输入框，
 * 手机端不提供编辑入口（改文案在桌面端更安全）。
 */
function quickCommandsHtml() {
  // 快捷命令的保存是本机专属，受限访问者只看得到别人的命令列表没意义。
  if (!canManageHost()) return ''
  const commands = Array.isArray(state.quickCommands) ? state.quickCommands : []
  if (!commands.length) return ''
  return `<div class="quick-commands">
    ${commands
      .map(
        (command, index) =>
          `<button type="button" class="quick-command" data-action="use-quick-command" data-index="${index}" title="${escapeHtml(String(command.content || ''))}">${icon('spark', 11)}${escapeHtml(quickCommandLabel(command))}</button>`,
      )
      .join('')}
  </div>`
}

function composerHtml() {
  const running = runningNow()
  return `<form class="composer" id="composer" autocomplete="off">
    <textarea id="composer-input" rows="1" placeholder="${running ? '输入要排队或插入的消息…' : '给 Pilot 发送消息…'}">${escapeHtml(state.composer)}</textarea>
    <div class="composer-row">
      <button type="button" class="delivery-toggle${state.delivery === 'insert' ? ' insert' : ''}" data-action="toggle-delivery" title="发送方式">
        ${icon(state.delivery === 'insert' ? 'insert' : 'clock', 11)}
        ${state.delivery === 'insert' ? '插入当前任务' : '排队'}
      </button>
      <span class="composer-spacer"></span>
      ${
        running
          ? `<button type="button" class="pause-button" data-action="pause-run" title="暂停任务，稍后从中断处继续">${icon('pause', 11)}暂停</button>
             <button type="button" class="stop-button" data-action="stop-run">${icon('stop', 11)}停止</button>`
          : `<button type="submit" class="send-button" data-action="send" ${!state.composer.trim() || state.connection !== 'connected' ? 'disabled' : ''}>${icon('send', 18)}</button>`
      }
      ${running ? `<button type="submit" class="send-button" data-action="send" ${!state.composer.trim() || state.connection !== 'connected' ? 'disabled' : ''}>${icon('send', 17)}</button>` : ''}
    </div>
  </form>`
}

function renderChat() {
  const workspace = state.session?.workspaceName || sessionWorkspaceName()
  return `<div class="chat-page">
    ${chatHeader()}
    <div class="chat-scroll" id="chat-scroll">
      <div class="chat-inner">
        <div class="chat-topline">
          ${icon('clock', 11)}
          <span>${state.offline ? '离线缓存' : state.session ? `更新于 ${escapeHtml(relativeTime(state.session.updatedAt))}` : '正在载入'}</span>
          ${workspace ? `<span class="sep">·</span><span>${escapeHtml(workspace)}</span>` : ''}
          ${
            state.hasMore
              ? `<span class="sep">·</span>
                 <button type="button" class="load-earlier" data-action="load-earlier"${state.loadingEarlier ? ' disabled' : ''}>
                   ${state.loadingEarlier ? '<i class="spinner small"></i>加载中…' : `${icon('chevron', 11, 'rotate-up')}加载更早消息`}
                 </button>`
              : ''
          }
        </div>
        ${planHtml()}
        <div id="message-list">${messagesHtml()}${liveMessageHtml()}</div>
        ${typingHtml()}
        ${state.loadError ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(state.loadError)}</span></div>` : ''}
      </div>
    </div>
    <div class="composer-dock">
      <div class="composer-inner">
        ${disconnectedBar()}
        <div id="continue-slot">${continueBarHtml()}</div>
        <div id="approval-slot">${approvalsHtml()}</div>
        <div id="process-slot">${processHtml()}</div>
        <div id="queue-slot">${queueHtml()}</div>
        <div id="todo-slot">${todosHtml()}</div>
        <div id="quick-command-slot">${quickCommandsHtml()}</div>
        ${composerHtml()}
      </div>
    </div>
    ${state.sheet === 'files' ? renderFilesSheet() : ''}
    ${state.sheet === 'artifacts' ? renderArtifactsSheet() : ''}
    ${state.sheet === 'schedules' ? renderSchedulesSheet() : ''}
    ${state.sheet === 'checkpoints' ? renderCheckpointsSheet() : ''}
    ${state.sheet === 'changes' ? renderChangesSheet() : ''}
    ${state.sheet === 'resources' ? renderResourcesSheet() : ''}
    ${state.sheet === 'models' ? renderModelsSheet() : ''}
    ${state.sheet === 'learning' ? renderLearningSheet() : ''}
    ${state.sheet === 'check' ? renderCheckSheet() : ''}
    ${state.sheet === 'evolution' ? renderEvolutionSheet() : ''}
  </div>`
}

/* ── Rendering: files ──────────────────────────────────────────────────── */

function renderFilesSheet() {
  const files = state.files
  if (!files.open) return ''
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>${files.preview ? '文件预览' : '会话文件'}</h3>
          <p>${files.preview ? escapeHtml(files.preview.path) : escapeHtml(state.session?.workspaceName || '工作区')}</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${
        files.preview
          ? `<button type="button" class="button ghost small" data-action="file-back" style="margin-bottom:10px">${icon('back', 14)}返回文件列表</button>
             <div class="file-preview">${escapeHtml(files.preview.content)}</div>
             <button type="button" class="button ghost small block" data-action="download-file" data-scope="files" style="margin-top:10px">${icon('download', 14)}下载到手机</button>`
          : files.loading
            ? `<div class="empty-state"><span class="spinner"></span><p>正在读取文件…</p></div>`
            : files.error
              ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(files.error)}</span></div>`
              : `<div class="file-breadcrumb">${icon('folder', 12)}<span>${escapeHtml(files.dir)}</span></div>
                 <div class="sheet-list">
                   ${
                     files.dir !== '.'
                       ? `<button type="button" class="sheet-row" data-action="file-dir" data-path="${escapeHtml(
                           files.dir.split('/').slice(0, -1).join('/') || '.',
                         )}"><span class="sheet-row-icon">${icon('back', 16)}</span><div><strong>上一级</strong></div></button>`
                       : ''
                   }
                   ${
                     files.nodes.length === 0
                       ? `<div class="empty-state"><strong>这个目录是空的</strong></div>`
                       : files.nodes
                           .map(
                             (node) => `<button type="button" class="sheet-row" data-action="${node.type === 'dir' ? 'file-dir' : 'file-open'}" data-path="${escapeHtml(node.path)}">
                               <span class="sheet-row-icon">${icon(node.type === 'dir' ? 'folder' : 'file', 16)}</span>
                               <div><strong>${escapeHtml(node.name)}</strong><span>${node.type === 'dir' ? '文件夹' : node.size != null ? `${Math.max(1, Math.round(node.size / 1024))} KB` : '文件'}</span></div>
                               ${icon('arrow', 14)}
                             </button>`,
                           )
                           .join('')
                   }
                 </div>`
      }
    </div>
  </div>`
}

function renderArtifactsSheet() {
  const artifacts = state.artifacts
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>${artifacts.preview ? '文件预览' : '本次产出文件'}</h3>
          <p>${artifacts.preview ? escapeHtml(artifacts.preview.path) : 'Pilot 成功写入或修改的文件'}</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${
        artifacts.preview
          ? `<button type="button" class="button ghost small" data-action="artifact-back" style="margin-bottom:10px">${icon('back', 14)}返回文件列表</button>
             <div class="file-preview">${escapeHtml(artifacts.preview.content)}</div>
             <button type="button" class="button ghost small block" data-action="download-file" data-scope="artifacts" style="margin-top:10px">${icon('download', 14)}下载到手机</button>`
          : artifacts.loading
            ? `<div class="empty-state"><span class="spinner"></span><p>正在汇总产出文件…</p></div>`
            : artifacts.error
              ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(artifacts.error)}</span></div>`
              : artifacts.items.length === 0
                ? `<div class="empty-state"><span class="empty-state-icon">${icon('file', 26)}</span><strong>这个会话还没有产出文件</strong><p>Pilot 成功写入或修改的文件会自动收集到这里。</p></div>`
                : `<div class="sheet-list">${artifacts.items
                    .map(
                      (artifact) => `<button type="button" class="sheet-row" data-action="artifact-open" data-path="${escapeHtml(artifact.path)}">
                        <span class="sheet-row-icon">${icon('file', 16)}</span>
                        <div><strong>${escapeHtml(artifact.name)}</strong><span>${escapeHtml(artifact.path)}</span></div>
                        <span class="badge ${artifact.action === 'write' ? 'mint' : 'queue'}">${artifact.action === 'write' ? '新建' : '修改'}</span>
                      </button>`,
                    )
                    .join('')}</div>`
      }
      <p class="sheet-note">只汇总本次会话成功写入的文件 · 只读预览</p>
    </div>
  </div>`
}

/* ── Rendering: schedules ──────────────────────────────────────────────── */

function scheduleKindLabel(task) {
  if (task.kind === 'interval') return `每 ${task.intervalMinutes ?? 60} 分钟`
  if (task.kind === 'daily') return `每天 ${task.timeOfDay ?? '09:00'}`
  return '一次性'
}

function scheduleLocal(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function renderSchedulesSheet() {
  const schedules = state.schedules
  const kind = schedules.kind
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet schedule-sheet" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>定时任务</h3>
          <p>到点加入这个会话的队列，与手动发送走同样的审批边界</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${canManageHost() ? `<form class="schedule-form" data-schedule-form="true">
        <textarea id="schedule-content" class="schedule-content" rows="3" maxlength="4000" placeholder="例如：检查项目测试结果，失败则修复并重新运行">${escapeHtml(
          schedules.content,
        )}</textarea>
        <div class="schedule-form-row">
          <select id="schedule-kind" class="schedule-select" aria-label="频率">
            <option value="once"${kind === 'once' ? ' selected' : ''}>稍后一次</option>
            <option value="interval"${kind === 'interval' ? ' selected' : ''}>每隔一段时间</option>
            <option value="daily"${kind === 'daily' ? ' selected' : ''}>每天固定时间</option>
          </select>
          ${
            kind === 'once'
              ? `<label class="schedule-field"><span>延迟（分钟）</span><input id="schedule-delay" type="number" min="1" max="10080" value="${escapeHtml(schedules.delay)}" /></label>`
              : kind === 'interval'
                ? `<label class="schedule-field"><span>间隔（分钟）</span><input id="schedule-interval" type="number" min="1" max="10080" value="${escapeHtml(schedules.interval)}" /></label>`
                : `<label class="schedule-field"><span>每天时间</span><input id="schedule-time" type="time" value="${escapeHtml(schedules.time)}" /></label>`
          }
          <button type="button" class="button primary schedule-add" data-action="schedule-add"${schedules.busy ? ' disabled' : ''}>${schedules.busy ? '<i class="spinner small"></i>' : icon('plus', 14)}添加</button>
        </div>
        ${schedules.error ? `<div class="error-banner">${icon('alert', 14)}<span>${escapeHtml(schedules.error)}</span></div>` : ''}
      </form>` : `<p class="sheet-note">远程访问只能查看定时任务；新增、暂停与删除请在这台电脑上操作。</p>`}
      <div class="schedule-list">
        ${
          schedules.loading
            ? `<div class="empty-state"><span class="spinner"></span><p>正在读取定时任务…</p></div>`
            : schedules.items.length === 0
              ? `<div class="empty-state"><span class="empty-state-icon">${icon('clock', 26)}</span><strong>还没有定时任务</strong><p>只会在电脑客户端运行时触发。</p></div>`
              : schedules.items
                  .map(
                    (task) => `<div class="schedule-item${task.enabled ? '' : ' is-off'}">
                      <div class="schedule-item-main">
                        <div class="schedule-item-title">
                          <span class="schedule-kind kind-${escapeHtml(task.kind)}">${escapeHtml(task.kind === 'once' ? '一次' : task.kind === 'interval' ? '间隔' : '每天')}</span>
                          <span>${escapeHtml(scheduleKindLabel(task))}</span>
                          ${task.lastStatus === 'failed' ? `<span class="schedule-failed" title="${escapeHtml(task.lastError || '')}">上次失败</span>` : ''}
                        </div>
                        <p>${escapeHtml(task.content)}</p>
                        <small>${task.enabled ? `下次 ${escapeHtml(scheduleLocal(task.nextRunAt))}` : '已暂停'}${task.lastRunAt ? ` · 上次 ${escapeHtml(scheduleLocal(task.lastRunAt))}` : ''}</small>
                      </div>
                      <div class="schedule-item-actions">
                        ${
                          canManageHost()
                            ? `<button type="button" class="schedule-toggle" data-action="schedule-toggle" data-id="${escapeHtml(task.id)}"${schedules.busy === task.id ? ' disabled' : ''}>${task.enabled ? '暂停' : '启用'}</button>
                        <button type="button" class="schedule-remove" data-action="schedule-remove" data-id="${escapeHtml(task.id)}" aria-label="删除定时任务"${schedules.busy === task.id ? ' disabled' : ''}>${icon('trash', 13)}</button>`
                            : ''
                        }
                      </div>
                    </div>`,
                  )
                  .join('')
        }
      </div>
      <p class="sheet-note">定时任务保存在电脑本机 · 电脑关闭后不会后台执行</p>
    </div>
  </div>`
}

/* ── Rendering: checkpoints / changes / resources / models ─────────────── */

function checkpointMeta(checkpoint) {
  const parts = []
  if (checkpoint?.createdAt) parts.push(relativeTime(checkpoint.createdAt))
  if (Number.isFinite(Number(checkpoint?.files))) parts.push(`${Number(checkpoint.files)} 个文件`)
  if (Number.isFinite(Number(checkpoint?.messageCount))) {
    parts.push(`${Number(checkpoint.messageCount)} 条消息`)
  }
  return parts.join(' · ')
}

function checkpointTitle(checkpoint) {
  if (checkpoint?.label) return checkpoint.label
  if (checkpoint?.baseline) return '初始快照'
  if (checkpoint?.trigger === 'prerestore') return '回退前安全点'
  return '快照'
}

function renderCheckpointsSheet() {
  const sheet = state.checkpoints
  const list = Array.isArray(sheet.items) ? sheet.items : []
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>回退点</h3>
          <p>把文件或对话恢复到某个快照 · 恢复前会自动存一份安全点</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      <div class="sheet-toolbar">
        <button type="button" class="button ghost tiny" data-action="load-checkpoints">刷新</button>
        <span class="sheet-toolbar-hint">${list.length > 0 ? `${list.length} 个快照` : ''}</span>
        <button type="button" class="button tiny" data-action="create-checkpoint" ${sheet.busy === 'create' ? 'disabled' : ''}>${sheet.busy === 'create' ? '正在保存…' : '新建快照'}</button>
      </div>
      <div class="sheet-list">
        ${
          sheet.loading
            ? `<div class="sheet-empty">读取中…</div>`
            : sheet.error
              ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>`
              : list.length === 0
                ? `<div class="sheet-empty">这个会话还没有回退点。跑完一轮或手动新建后会出现。</div>`
                : list
                    .map(
                      (checkpoint) => `<div class="sheet-row-block">
                        <div class="sheet-row">
                          <span class="sheet-row-icon">${icon('clock', 16)}</span>
                          <div>
                            <strong>${escapeHtml(checkpointTitle(checkpoint))}</strong>
                            <span>${escapeHtml(checkpointMeta(checkpoint))}${checkpoint.complete === false ? ' · 部分文件未快照' : ''}</span>
                          </div>
                        </div>
                        <div class="row-actions">
                          <button type="button" class="button tiny ghost" data-action="restore-checkpoint" data-id="${escapeHtml(checkpoint.id || '')}" data-mode="code" ${sheet.busy === checkpoint.id ? 'disabled' : ''}>只恢复文件</button>
                          <button type="button" class="button tiny ghost" data-action="restore-checkpoint" data-id="${escapeHtml(checkpoint.id || '')}" data-mode="both" ${sheet.busy === checkpoint.id ? 'disabled' : ''}>连对话一起恢复</button>
                        </div>
                      </div>`,
                    )
                    .join('')
        }
      </div>
      <p class="sheet-note">恢复会覆盖当前工作区文件；对话恢复会把该快照之后的消息移出会话</p>
    </div>
  </div>`
}

function changeStatusLabel(status) {
  if (status === 'added') return '新增'
  if (status === 'deleted') return '删除'
  if (status === 'unreadable') return '无法读取'
  return '修改'
}

function renderChangesSheet() {
  const sheet = state.changes
  const list = Array.isArray(sheet.items) ? sheet.items : []
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>变更审阅</h3>
          <p>这个任务改过的文件 · 点一行看差异</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      <div class="sheet-toolbar">
        <button type="button" class="button ghost tiny" data-action="load-changes">刷新</button>
        <span class="sheet-toolbar-hint">${list.length > 0 ? `${list.length} 个文件` : ''}</span>
      </div>
      <div class="sheet-list">
        ${
          sheet.loading
            ? `<div class="sheet-empty">读取中…</div>`
            : sheet.error
              ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>`
              : list.length === 0
                ? `<div class="sheet-empty">这个任务还没改动文件。</div>`
                : list
                    .map((change, index) => {
                      const key = String(change.path || index)
                      const expanded = Boolean(sheet.expanded[key])
                      const diff = String(change.diff || '')
                      return `<div class="sheet-row-block">
                        <button type="button" class="sheet-row" data-action="toggle-change" data-key="${escapeHtml(key)}">
                          <span class="sheet-row-icon">${icon('file', 16)}</span>
                          <div>
                            <strong>${escapeHtml(change.name || key)} <span class="change-stat add">+${Number(change.added) || 0}</span> <span class="change-stat del">−${Number(change.removed) || 0}</span></strong>
                            <span>${escapeHtml(change.path || '')}</span>
                          </div>
                          <span class="badge ${escapeHtml(String(change.status || 'modified'))}">${escapeHtml(changeStatusLabel(change.status))}</span>
                        </button>
                        ${expanded ? `<pre class="change-diff">${escapeHtml(diff.trim() ? (diff.length > 4000 ? `${diff.slice(0, 4000)}\n…` : diff) : change.note || '没有可显示的差异。')}</pre>` : ''}
                        ${change.canRevert ? `<div class="row-actions"><button type="button" class="button tiny danger" data-action="revert-change" data-path="${escapeHtml(change.path || '')}" ${sheet.busy === change.path ? 'disabled' : ''}>还原这个文件</button></div>` : `
                          <p class="row-note">${escapeHtml(change.note || '')}</p>`}
                      </div>`
                    })
                    .join('')
        }
      </div>
      <p class="sheet-note">还原前需要等当前任务结束 · 不能撤销二进制文件</p>
    </div>
  </div>`
}

const RESOURCE_TABS = [
  { id: 'links', label: '链接' },
  { id: 'tools', label: '工具' },
  { id: 'memory', label: '记忆' },
  { id: 'knowledge', label: '知识库' },
  { id: 'files', label: '文件' },
]

/** 会话卡片上的快捷入口：点一下就跳到这条会话的对应分类。 */
const SESSION_SHORTCUTS = [
  { id: 'files', label: '文件' },
  { id: 'knowledge', label: '知识库' },
  { id: 'links', label: '链接' },
  { id: 'tools', label: '工具' },
  { id: 'memory', label: '记忆' },
]

function resourceEmptyText(tab) {
  if (tab === 'links') return '这个会话还没出现过链接。'
  if (tab === 'tools') return '这个会话还没调用过工具。'
  if (tab === 'memory') return '这个会话没有用到项目记忆。'
  if (tab === 'files') return '这个会话还没写过文件。'
  return '还没有可以检索的对话内容。'
}

function resourceListHtml() {
  const sheet = state.resources
  const tab = sheet.tab
  if (tab === 'links') {
    return sheet.links
      .map(
        (link) => `<a class="sheet-row" href="${escapeHtml(link.url || '#')}" target="_blank" rel="noreferrer noopener">
          <span class="sheet-row-icon">${icon('list', 16)}</span>
          <div>
            <strong>${escapeHtml(link.title || link.context || link.url || '')}</strong>
            <span>${escapeHtml(link.host || link.url || '')}${Number(link.count) > 1 ? ` · 出现 ${Number(link.count)} 次` : ''}</span>
          </div>
        </a>`,
      )
      .join('')
  }
  if (tab === 'tools') {
    return sheet.tools
      .map(
        (tool) => `<div class="sheet-row">
          <span class="sheet-row-icon">${icon('terminal', 16)}</span>
          <div>
            <strong>${escapeHtml(tool.name || '')}</strong>
            <span>${escapeHtml([tool.source, tool.risk, tool.version ? `v${tool.version}` : ''].filter(Boolean).join(' · '))}</span>
          </div>
          <span class="badge ${tool.approved === false ? 'amber' : 'mint'}">${tool.enabled === false ? '已停用' : tool.approved === false ? '待批准' : '可用'}</span>
        </div>`,
      )
      .join('')
  }
  if (tab === 'memory') {
    return sheet.memory
      .map(
        (entry) => `<div class="sheet-row">
          <span class="sheet-row-icon">${icon('spark', 16)}</span>
          <div>
            <strong>${escapeHtml(entry.content || '')}</strong>
            <span>${escapeHtml([entry.category, entry.createdAt ? relativeTime(entry.createdAt) : '', entry.written ? '本次写下' : entry.injected ? '本次注入' : ''].filter(Boolean).join(' · '))}</span>
          </div>
        </div>`,
      )
      .join('')
  }
  if (tab === 'files') {
    return sheet.files
      .map(
        (file) => `<button type="button" class="sheet-row" data-action="resource-file-open" data-path="${escapeHtml(file.path || '')}">
          <span class="sheet-row-icon">${icon('file', 16)}</span>
          <div>
            <strong>${escapeHtml(file.name || file.path || '')}</strong>
            <span>${escapeHtml(file.path || '')}</span>
          </div>
          <span class="badge ${file.action === 'write' ? 'mint' : 'queue'}">${file.action === 'write' ? '新建' : '修改'}</span>
        </button>`,
      )
      .join('')
  }
  return sheet.knowledge
    .map((pair) => {
      const question = String(pair.instruction || pair.user || '').trim()
      const answer = String(pair.reply || '').trim()
      return `<div class="knowledge-pair">
        <strong>${escapeHtml(question.length > 160 ? `${question.slice(0, 160)}…` : question || '（无提问）')}</strong>
        <p>${escapeHtml(answer.length > 400 ? `${answer.slice(0, 400)}…` : answer || '（无回答）')}</p>
        <span class="knowledge-meta">${escapeHtml([pair.instructionAt ? relativeTime(pair.instructionAt) : '', Number(pair.replyCount) > 1 ? `${Number(pair.replyCount)} 条回答` : ''].filter(Boolean).join(' · '))}</span>
      </div>`
    })
    .join('')
}

function renderResourcesSheet() {
  const sheet = state.resources
  const items = resourceListHtml()
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>会话资源</h3>
          <p>${RESOURCE_TABS.map((tab) => tab.label).join(' · ')}</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      <div class="tabs">
        ${RESOURCE_TABS.map(
          (tab) =>
            `<button type="button" class="filter-chip${sheet.tab === tab.id ? ' is-active' : ''}" data-action="resource-tab" data-tab="${tab.id}">${tab.label}</button>`,
        ).join('')}
      </div>
      <div class="sheet-list">
        ${
          sheet.tab === 'files' && sheet.preview
            ? `<button type="button" class="button ghost small" data-action="resource-file-back" style="margin-bottom:10px">${icon('back', 14)}返回文件列表</button>
               <div class="file-preview">${escapeHtml(sheet.preview.content)}</div>`
            : sheet.loading
              ? `<div class="sheet-empty">读取中…</div>`
              : sheet.error
                ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>`
                : items || `<div class="sheet-empty">${resourceEmptyText(sheet.tab)}</div>`
        }
      </div>
      ${
        sheet.tab === 'knowledge'
          ? `<p class="sheet-note">只显示前几条提问与回答 · 完整正文在会话里</p>`
          : sheet.tab === 'files'
            ? `<p class="sheet-note">${sheet.preview ? '只读预览' : '只列出这个任务里新增或修改的文件'} · 完整正文在电脑上</p>`
            : ''
      }
      ${sheet.tab === 'files' && sheet.preview ? `<button type="button" class="button ghost small block" data-action="download-file" data-scope="resources">${icon('download', 14)}下载到手机</button>` : ''}
    </div>
  </div>`
}

const APPROVAL_MODE_OPTIONS = [
  { value: 'auto', label: '全部自动', hint: '直接执行工具，不再逐条询问' },
  { value: 'manual', label: '只读自动', hint: '读取自动执行，写入和命令需要审批' },
  { value: 'ask', label: '逐条审批', hint: '每次工具调用都等你确认' },
]

function renderModelsSheet() {
  const sheet = state.models
  const resources = Array.isArray(sheet.resources) ? sheet.resources : []
  const enabled = resources.filter((entry) => entry && entry.enabled !== false)
  const currentMode = sheet.approvalMode || 'auto'
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>模型与权限</h3>
          <p>只影响这个会话的后续请求</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${
        sheet.loading
          ? `<div class="sheet-empty">读取模型设置…</div>`
          : sheet.error
            ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>`
            : ''
      }
      ${
        canManageHost()
          ? `<div class="section-label">执行模式</div>
      <div class="sheet-list">
        ${APPROVAL_MODE_OPTIONS.map(
          (option) => `<button type="button" class="sheet-row option-row${currentMode === option.value ? ' is-active' : ''}" data-action="set-approval-mode" data-mode="${option.value}" ${sheet.busy === 'mode' ? 'disabled' : ''}>
            <span class="sheet-row-icon">${currentMode === option.value ? icon('check', 16) : icon('clock', 16)}</span>
            <div>
              <strong>${option.label}</strong>
              <span>${option.hint}</span>
            </div>
          </button>`,
        ).join('')}
      </div>`
          : `<div class="section-label">执行模式</div>
      <div class="sheet-list">
        <div class="sheet-row">
          <span class="sheet-row-icon">${icon('clock', 16)}</span>
          <div>
            <strong>由电脑端决定</strong>
            <span>远程访问不能降低审批门槛，需要在这台电脑上切换</span>
          </div>
        </div>
      </div>`
      }
      <div class="section-label">会话模型</div>
      <div class="sheet-list">
        <button type="button" class="sheet-row option-row${sheet.sessionModelId ? '' : ' is-active'}" data-action="set-session-model" data-model="" ${sheet.busy === 'model' ? 'disabled' : ''}>
          <span class="sheet-row-icon">${sheet.sessionModelId ? icon('spark', 16) : icon('check', 16)}</span>
          <div>
            <strong>跟随项目设置</strong>
            <span>用电脑端当前默认的模型</span>
          </div>
        </button>
        ${enabled
          .map(
            (resource) => `<button type="button" class="sheet-row option-row${sheet.sessionModelId === resource.id ? ' is-active' : ''}" data-action="set-session-model" data-model="${escapeHtml(resource.id)}" ${sheet.busy === 'model' ? 'disabled' : ''}>
              <span class="sheet-row-icon">${sheet.sessionModelId === resource.id ? icon('check', 16) : icon('spark', 16)}</span>
              <div>
                <strong>${escapeHtml(resource.label || resource.model || resource.id)}</strong>
                <span>${escapeHtml([resource.model, resource.tag, resource.hasKey === false ? '未配置密钥' : ''].filter(Boolean).join(' · '))}</span>
              </div>
            </button>`,
          )
          .join('')}
      </div>
      <p class="sheet-note">权限边界（工作区路径、受保护文件、拒绝规则）在任何模式下都生效</p>
    </div>
  </div>`
}

/* ── Rendering: learning ────────────────────────────────────────────────── */

function learningKindLabel(entry) {
  if (entry?.kind === 'source') return '来源'
  if (entry?.kind === 'task') return '任务'
  return '阶段成果'
}

function learningVerdictLabel(verdict) {
  if (verdict === 'approved') return '已确认'
  if (verdict === 'rejected') return '已驳回'
  return '待确认'
}

function learningEntryTitle(entry) {
  if (!entry) return ''
  if (entry.kind === 'source') return entry.host || entry.url || '来源'
  if (entry.kind === 'task') return entry.title || '未命名任务'
  return entry.note || '阶段成果'
}

/** Second line of a ledger row: what it was, when, and the user verdict. */
function learningEntryMeta(entry) {
  const parts = []
  if (entry?.at) parts.push(relativeTime(entry.at))
  if (entry?.kind === 'source' && entry.url) parts.push(entry.url)
  if (entry?.kind === 'task' && entry.goal) parts.push(entry.goal)
  if (entry?.kind === 'outcome') {
    parts.push(learningVerdictLabel(entry.verdict))
    if (typeof entry.quality === 'number' && Number.isFinite(entry.quality)) {
      parts.push(`质量 ${Math.round(entry.quality * 100)}%`)
    }
  }
  return parts.join(' · ')
}

/**
 * 自主学习面板：开关与白名单是电脑端全局设置，账本按当前会话的工作区读。
 * 手机端只负责开合与看账本，改提示词/策略仍然回桌面端。
 */
function renderLearningSheet() {
  const sheet = state.learning
  const summary = sheet.summary || {}
  const entries = Array.isArray(sheet.entries) ? sheet.entries : []
  const percent = (value) => `${Math.round((Number(value) || 0) * 100)}%`
  const hostField = sheet.hostsDraft
  const stats = [
    { value: Number(summary.sources) || 0, label: '来源' },
    { value: Number(summary.tasks) || 0, label: '任务' },
    { value: Number(summary.pending) || 0, label: '待确认' },
    { value: percent(summary.approvalRate), label: '通过率' },
  ]
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>自主学习</h3>
          <p>只读访问白名单站点，自己挑任务并把过程记进账本</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${sheet.error ? `<div class="error-banner">${escapeHtml(sheet.error)}</div>` : ''}
      ${
        sheet.loading
          ? `<div class="sheet-empty">正在读取学习账本…</div>`
          : `
        <div class="learning-stats">
          ${stats
            .map(
              (stat) => `<div class="learning-stat">
                <strong>${escapeHtml(String(stat.value))}</strong>
                <span>${stat.label}</span>
              </div>`,
            )
            .join('')}
        </div>
        <button type="button" class="sheet-row option-row${sheet.enabled ? ' is-active' : ''}" data-action="toggle-learning" ${sheet.busy ? 'disabled' : ''}>
          <span class="sheet-row-icon">${sheet.enabled ? icon('check', 16) : icon('spark', 16)}</span>
          <div>
            <strong>${sheet.enabled ? '已开启' : '已关闭'}</strong>
            <span>${sheet.enabled ? '下一步探索会先记来源，再做任务' : '开启后才会自己找任务做'}</span>
          </div>
        </button>
        <div class="section-label">白名单 <span>${sheet.effectiveHosts.length} 个生效</span></div>
        <textarea id="learning-hosts" class="learning-hosts" rows="4" placeholder="每行一个主机名，例如 developer.mozilla.org">${escapeHtml(hostField)}</textarea>
        <div class="row-actions">
          <button type="button" class="button tiny ghost" data-action="fill-learning-hosts">填入默认</button>
          <button type="button" class="button tiny primary" data-action="save-learning-hosts" ${sheet.busy === 'hosts' ? 'disabled' : ''}>保存白名单</button>
        </div>
        <p class="row-note">留空则使用内置默认：${escapeHtml(sheet.defaultHosts.join('、') || '无')}</p>
        <div class="section-label">账本 <span>最近 ${entries.length} 条 / 共 ${sheet.entryTotal} 条</span></div>
        ${
          entries.length
            ? `<div class="sheet-list learning-ledger">
                ${entries
                  .map(
                    (entry) => `<div class="learning-entry">
                      <div class="learning-entry-top">
                        <span class="learning-kind ${escapeHtml(String(entry.kind || ''))}">${escapeHtml(learningKindLabel(entry))}</span>
                        <span class="learning-entry-time">${escapeHtml(entry.at ? relativeTime(entry.at) : '')}</span>
                      </div>
                      <strong>${escapeHtml(learningEntryTitle(entry))}</strong>
                      <span class="learning-entry-meta">${escapeHtml(learningEntryMeta(entry))}</span>
                    </div>`,
                  )
                  .join('')}
              </div>`
            : `<div class="sheet-empty">账本还是空的：开启后第一次探索会写下第一条来源记录</div>`
        }
        <p class="sheet-note">完整账本留在电脑端 ${escapeHtml(sheet.ledger || '.pilot/learning/ledger.jsonl')}；裁决在电脑端做</p>
      `
      }
    </div>
  </div>`
}

/* ── Rendering: module check / self check ──────────────────────────────── */

const SEVERITY_LABEL = { high: '高', medium: '中', low: '低' }
const SELF_CHECK_LABEL = { ok: '正常', warn: '注意', off: '未启用', broken: '异常' }
const SELF_CHECK_GROUP_LABEL = {
  runtime: '运行环境',
  model: '模型接入',
  exec: '审批与执行',
  ext: '扩展',
  data: '数据',
}

function checkReportMeta(report) {
  if (!report) return ''
  const parts = []
  if (report.finishedAt) parts.push(relativeTime(report.finishedAt))
  if (Number.isFinite(Number(report.score))) parts.push(`健康分 ${Number(report.score)}`)
  if (Number.isFinite(Number(report.risks?.length))) parts.push(`${report.risks.length} 个风险点`)
  if (Number.isFinite(Number(report.scannedFiles))) parts.push(`扫了 ${report.scannedFiles} 个文件`)
  return parts.join(' · ')
}

/**
 * 体检面板：「模块自检」扫工作区代码风险，「内视」读运行中的服务实例。
 * 手机端只做「看结果」与「发起扫描」；生成改造提案（会建会话改代码）留在电脑端。
 */
function renderCheckSheet() {
  const sheet = state.check
  const report = sheet.report
  const risks = Array.isArray(report?.risks) ? report.risks : []
  const selfCheck = sheet.selfCheck
  const counts = selfCheck?.counts || {}
  const items = Array.isArray(selfCheck?.items) ? selfCheck.items : []
  const rank = { broken: 0, warn: 1, off: 2, ok: 3 }
  const ordered = items
    .slice()
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
    .slice(0, 12)
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>体检</h3>
          <p>模块自检看代码风险，内视看运行中的服务能不能用</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${sheet.error ? `<div class="error-banner">${escapeHtml(sheet.error)}</div>` : ''}
      <div class="section-label">模块自检 <span>${sheet.historyCount ? `历史 ${sheet.historyCount} 份` : '还没跑过'}</span></div>
      <button type="button" class="sheet-row option-row${sheet.enabled ? ' is-active' : ''}" data-action="toggle-module-check" ${sheet.busy ? 'disabled' : ''}>
        <span class="sheet-row-icon">${sheet.enabled ? icon('check', 16) : icon('clock', 16)}</span>
        <div>
          <strong>定期自检${sheet.enabled ? '已开启' : '已关闭'}</strong>
          <span>${sheet.nextRunAt ? `下次约 ${relativeTime(sheet.nextRunAt)}` : '开启后按间隔自动扫一遍'}</span>
        </div>
      </button>
      ${
        sheet.loading
          ? `<div class="sheet-empty">正在读取自检状态…</div>`
          : `<div class="check-meta">${escapeHtml(checkReportMeta(report) || '还没有自检报告')}</div>`
      }
      <div class="row-actions">
        <button type="button" class="button tiny primary" data-action="run-module-check" ${sheet.busy ? 'disabled' : ''}>${sheet.busy === 'run' ? '正在扫描…' : '立即自检'}</button>
        <button type="button" class="button tiny ghost" data-action="run-self-check" ${sheet.busy === 'self' ? 'disabled' : ''}>${sheet.busy === 'self' ? '正在内视…' : '运行内视'}</button>
      </div>
      ${
        risks.length
          ? `<div class="sheet-list check-list">
              ${risks
                .map((risk) => {
                  const key = String(risk.id || '')
                  const open = sheet.expanded[key] === true
                  return `<div class="check-entry">
                    <button type="button" class="check-entry-head" data-action="toggle-risk" data-key="${escapeHtml(key)}">
                      <span class="badge ${escapeHtml(String(risk.severity || 'low'))}">${escapeHtml(SEVERITY_LABEL[risk.severity] || '低')}</span>
                      <strong>${escapeHtml(String(risk.title || ''))}</strong>
                      <span class="check-entry-count">${Number(risk.count) > 1 ? `×${Number(risk.count)}` : ''}</span>
                      ${icon(open ? 'chevron' : 'arrow', 13)}
                    </button>
                    <span class="check-entry-module">${escapeHtml(String(risk.moduleName || risk.moduleId || ''))}</span>
                    ${
                      open
                        ? `<p class="row-note check-entry-detail">${escapeHtml(String(risk.detail || ''))}</p>
                           ${risk.recommendation ? `<p class="row-note check-entry-detail">建议：${escapeHtml(String(risk.recommendation))}</p>` : ''}
                           ${(risk.evidence || []).length ? `<p class="row-note check-entry-evidence">${escapeHtml((risk.evidence || []).slice(0, 4).join('\n'))}</p>` : ''}`
                        : ''
                    }
                  </div>`
                })
                .join('')}
            </div>`
          : ''
      }
      <p class="sheet-note">生成改造提案会在电脑端开会话改源码，这一步只在电脑端做</p>
      <div class="section-label">内视 <span>${selfCheck ? `${counts.broken || 0} 异常 / ${counts.warn || 0} 注意` : '未运行'}</span></div>
      ${
        selfCheck
          ? `<div class="check-selfcheck">
              ${['ok', 'warn', 'off', 'broken']
                .map(
                  (status) => `<div class="check-count ${status}">
                    <strong>${counts[status] || 0}</strong>
                    <span>${SELF_CHECK_LABEL[status]}</span>
                  </div>`,
                )
                .join('')}
            </div>
            <div class="sheet-list check-list">
              ${ordered
                .map(
                  (item) => `<div class="check-entry selfcheck">
                    <div class="check-entry-head static">
                      <span class="badge ${escapeHtml(String(item.status || 'ok'))}">${escapeHtml(SELF_CHECK_LABEL[item.status] || '正常')}</span>
                      <strong>${escapeHtml(String(item.title || ''))}</strong>
                    </div>
                    <span class="check-entry-module">${escapeHtml(SELF_CHECK_GROUP_LABEL[item.group] || item.group || '')}${item.detail ? ` · ${escapeHtml(String(item.detail))}` : ''}</span>
                  </div>`,
                )
                .join('')}
            </div>`
          : `<div class="sheet-empty">内视不读任何路径，只看这台电脑现在的模型、审批、沙箱与扩展状态</div>`
      }
    </div>
  </div>`
}

/* ── Rendering: self evolution ─────────────────────────────────────────── */

const PROFILE_STATUS_LABEL = { draft: '待评审', active: '已启用', retired: '已退役' }
const PROFILE_STATUS_BADGE = { draft: 'amber', active: 'mint', retired: '' }
const CYCLE_STATUS_LABEL = { completed: '完成', rejected: '未通过', failed: '失败' }
const CYCLE_STATUS_BADGE = { completed: 'mint', rejected: 'amber', failed: 'high' }

/** 进化面板要读哪个工作区：手选优先，其次当前会话，再退到第一个工作区。 */
function evolutionWorkspacePath() {
  return (
    state.evolution.workspacePath ||
    state.session?.workspacePath ||
    state.workspaces[0]?.path ||
    ''
  )
}

function evolutionScoreLabel(review) {
  if (!review) return ''
  const score = Number(review.score)
  if (!Number.isFinite(score)) return ''
  return `${score} 分${review.independent === true ? ' · 独立评审' : ' · 自评'}`
}

function evolutionProfileHtml(profile, scope) {
  const status = String(profile.status || 'draft')
  const badge = PROFILE_STATUS_BADGE[status] || ''
  const score = evolutionScoreLabel(profile.review)
  const rationale = String(profile.rationale || '').trim()
  const scopeLabel = scope === 'global' ? '全局' : '工作区'
  const acts = []
  if (status === 'draft') {
    acts.push(
      `<button type="button" class="button tiny ghost" data-action="evolution-do" data-op="${
        scope === 'global' ? 'globalReview' : 'review'
      }" data-id="${escapeHtml(String(profile.id || ''))}"${state.evolution.busy ? ' disabled' : ''}>评审</button>`,
    )
    acts.push(
      `<button type="button" class="button tiny primary" data-action="evolution-do" data-op="${
        scope === 'global' ? 'globalActivate' : 'activate'
      }" data-id="${escapeHtml(String(profile.id || ''))}"${state.evolution.busy ? ' disabled' : ''}>启用</button>`,
    )
  } else if (status === 'active') {
    acts.push(
      `<button type="button" class="button tiny ghost" data-action="evolution-do" data-op="${
        scope === 'global' ? 'globalRollback' : 'rollback'
      }"${state.evolution.busy ? ' disabled' : ''}>回滚</button>`,
    )
  }
  acts.push(
    `<button type="button" class="button tiny danger" data-action="evolution-do" data-op="${
      scope === 'global' ? 'globalDelete' : 'delete'
    }" data-id="${escapeHtml(String(profile.id || ''))}"${state.evolution.busy ? ' disabled' : ''}>删除</button>`,
  )
  return `<div class="evo-profile">
    <div class="evo-profile-head">
      <span class="badge ${badge}">${scopeLabel} v${Number(profile.version) || 0}</span>
      <span class="evo-status">${escapeHtml(PROFILE_STATUS_LABEL[status] || status)}</span>
      ${score ? `<span class="evo-score">${escapeHtml(score)}</span>` : ''}
    </div>
    ${rationale ? `<p class="row-note evo-rationale">${escapeHtml(rationale)}</p>` : ''}
    <div class="evo-actions">${acts.join('')}</div>
  </div>`
}

function evolutionCycleHtml(cycle) {
  const status = String(cycle.status || 'completed')
  return `<div class="evo-cycle">
    <div class="evo-cycle-head">
      <span class="evo-cycle-time">${escapeHtml(relativeTime(cycle.finishedAt || cycle.startedAt))}</span>
      <span class="badge ${CYCLE_STATUS_BADGE[status] || ''}">${escapeHtml(CYCLE_STATUS_LABEL[status] || status)}</span>
      ${Number.isFinite(Number(cycle.score)) ? `<span class="evo-score">${Number(cycle.score)} 分</span>` : ''}
      ${cycle.activated ? '<span class="badge mint">已启用</span>' : ''}
    </div>
    ${cycle.summary ? `<p class="row-note evo-summary">${escapeHtml(String(cycle.summary))}</p>` : ''}
  </div>`
}

/**
 * 自我进化面板：手机端只能看快照和点「评审/启用/回滚」，
 * 改提示词、个人源码版本仍回电脑端。
 */
function renderEvolutionSheet() {
  const sheet = state.evolution
  const snap = sheet.state
  const path = evolutionWorkspacePath()
  const profiles = Array.isArray(snap?.profiles) ? snap.profiles : []
  const globalProfiles = Array.isArray(snap?.globalProfiles) ? snap.globalProfiles : []
  const cycles = Array.isArray(snap?.cycles) ? snap.cycles : []
  const policy = snap?.policy || null
  const busy = sheet.busy
  const stats = snap
    ? [
        { value: snap.completedRuns, label: '完成运行' },
        { value: snap.failures, label: '失败' },
        { value: snap.avgSteps, label: '平均步数' },
        { value: snap.minRuns, label: '开跑门槛' },
      ]
    : []
  return `<div class="sheet-backdrop" data-action="close-sheet">
    <div class="sheet tall" data-stop="true">
      <div class="sheet-grip"></div>
      <div class="sheet-head">
        <div>
          <h3>自我进化</h3>
          <p>看运行统计，决定要不要让 Pilot 改自己的策略</p>
        </div>
        <button type="button" class="icon-button" data-action="close-sheet" aria-label="关闭">${icon('close', 18)}</button>
      </div>
      ${sheet.error ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>` : ''}
      ${
        state.workspaces.length > 1
          ? `<div class="tabs">${state.workspaces
              .map(
                (workspace) =>
                  `<button type="button" class="filter-chip${workspace.path === path ? ' is-active' : ''}" data-action="evolution-workspace" data-path="${escapeHtml(String(workspace.path || ''))}">${escapeHtml(String(workspace.name || workspace.path || ''))}</button>`,
              )
              .join('')}</div>`
          : path
            ? `<div class="check-meta">${escapeHtml(workspaceNameFor(path))}</div>`
            : ''
      }
      ${
        !path
          ? `<div class="sheet-empty">还没有打开过工作区，先在电脑上打开一个项目</div>`
          : sheet.loading
            ? `<div class="sheet-empty">正在读取进化状态…</div>`
            : !snap
              ? `<div class="sheet-empty">还没有读到进化状态，点刷新再试</div>`
              : `
        <div class="evo-stats">${stats
          .map(
            (stat) => `<div class="evo-stat">
              <strong>${Number(stat.value) || 0}</strong>
              <span>${escapeHtml(stat.label)}</span>
            </div>`,
          )
          .join('')}</div>
        <button type="button" class="sheet-row option-row${snap.autoEvolve ? ' is-active' : ''}" data-action="evolution-auto" ${busy ? 'disabled' : ''}>
          <span class="sheet-row-icon">${snap.autoEvolve ? icon('check', 16) : icon('clock', 16)}</span>
          <div>
            <strong>自动进化${snap.autoEvolve ? '已开启' : '已关闭'}</strong>
            <span>每 ${Number(policy?.cooldownRuns) || 0} 次运行后自己挑一轮，评审不过不改策略</span>
          </div>
        </button>
        <div class="row-actions">
          <button type="button" class="button tiny primary" data-action="evolution-do" data-op="cycle" ${snap.canRunCycle && !busy ? '' : 'disabled'}>${busy === 'cycle' ? '正在跑…' : '跑一轮进化'}</button>
          <button type="button" class="button tiny ghost" data-action="evolution-do" data-op="improvePolicy" ${busy ? 'disabled' : ''}>${busy === 'improvePolicy' ? '正在改…' : '改进机制'}</button>
          <button type="button" class="button tiny ghost" data-action="evolution-do" data-op="rollbackPolicy" ${snap.canRollbackPolicy && !busy ? '' : 'disabled'}>回滚机制</button>
        </div>
        <div class="check-meta">${
          snap.hasKey
            ? `策略 v${Number(snap.activePolicyVersion?.version) || 0} · 评审及格线 ${Number(policy?.reviewScore) || 0} 分 · ${policy?.autoApply ? '评审通过自动启用' : '评审通过也等你手动启用'}`
            : '电脑上没有配置 API Key，跑不了进化'
        }</div>
        <div class="section-label">工作区版本 <span>${profiles.length} 个</span></div>
        ${profiles.length ? `<div class="sheet-list">${profiles.map((profile) => evolutionProfileHtml(profile, 'workspace')).join('')}</div>` : '<div class="sheet-empty">这个工作区还没生成过进化版本</div>'}
        <div class="section-label">全局版本 <span>${globalProfiles.length} 个</span></div>
        ${globalProfiles.length ? `<div class="sheet-list">${globalProfiles.map((profile) => evolutionProfileHtml(profile, 'global')).join('')}</div>` : '<div class="sheet-empty">还没有跨工作区的全局版本</div>'}
        <div class="section-label">最近轮次 <span>${cycles.length} 条</span></div>
        ${cycles.length ? `<div class="sheet-list">${cycles.map(evolutionCycleHtml).join('')}</div>` : '<div class="sheet-empty">还没跑过进化轮次</div>'}
      `
      }
      <p class="sheet-note">改提示词、个人源码版本与发布仍在电脑端；手机只负责评审和启用</p>
    </div>
  </div>`
}

/* ── Rendering: settings ───────────────────────────────────────────────── */
/* ── Billing (余额与费用) ─────────────────────── */

/** 与 `shared/billing.ts` 的 USD_CNY_RATE 保持一致：电脑端存美元，界面显示人民币。 */
const USD_CNY_RATE = 7.1

const BALANCE_ERROR_TEXT = {
  'missing-key': '电脑端还没保存 API Key',
  unauthorized: 'API Key 无效或已过期',
  unsupported: '当前模型服务不提供余额查询',
  network: '读取余额超时',
  'invalid-response': '余额接口返回了无法识别的数据',
}

function currencySymbol(code) {
  return String(code || 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
}

function moneyText(amount, currency) {
  const value = Number(amount)
  if (!Number.isFinite(value)) return '—'
  return `${currencySymbol(currency)}${value.toFixed(2)}`
}

function tokenText(count) {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(Math.round(value))
}

function renderBillingCard() {
  const sheet = state.billing
  const report = sheet.report
  const balance = report?.balance || null
  const usage = report?.usage || null
  const entry = Array.isArray(balance?.entries) ? balance.entries[0] : null
  const currency = String(entry?.currency || 'CNY').toUpperCase()
  const costUsd = Number(usage?.estimatedCostUsd)
  const cost = Number.isFinite(costUsd) ? (currency === 'USD' ? costUsd : costUsd * USD_CNY_RATE) : null
  const rows = Array.isArray(usage?.rows) ? usage.rows.slice(0, 4) : []
  const totalTokens = usage ? Number(usage.promptTokens || 0) + Number(usage.completionTokens || 0) : 0
  const balanceError = balance && balance.ok === false ? BALANCE_ERROR_TEXT[balance.error] || '读取余额失败' : ''
  const balanceDetail = balanceError
    ? balanceError
    : `可用余额${entry?.grantedBalance ? ` · 赠送 ${moneyText(entry.grantedBalance, currency)}` : ''}${
        entry?.toppedUpBalance ? ` · 充值 ${moneyText(entry.toppedUpBalance, currency)}` : ''
      }`
  return `<div class="page-heading" style="margin-top:24px"><div><h2>模型与费用</h2><p>余额来自模型服务，费用是本机估算</p></div></div>
  <div class="card">
    ${
      sheet.loading && !report
        ? `<div class="setting-row"><span class="setting-icon"><span class="spinner small"></span></span><div class="setting-body"><strong>正在读取余额…</strong><span>电脑端在向模型服务查询</span></div></div>`
        : sheet.error
          ? `<div class="error-banner">${icon('alert', 15)}<span>${escapeHtml(sheet.error)}</span></div>`
          : !report
            ? `<div class="setting-row"><span class="setting-icon">${icon('spark', 18)}</span><div class="setting-body"><strong>还没读取</strong><span>点下面的按钮从电脑端取一次余额与用量</span></div></div>`
            : `<div class="setting-row">
                 <span class="setting-icon">${icon('spark', 18)}</span>
                 <div class="setting-body">
                   <strong>${balanceError ? '余额不可用' : moneyText(entry?.totalBalance, currency)}</strong>
                   <span>${escapeHtml(balanceDetail)}</span>
                 </div>
               </div>
               <div class="setting-row">
                 <span class="setting-icon">${icon('terminal', 18)}</span>
                 <div class="setting-body">
                   <strong>${cost == null ? '本机费用未估算' : `${moneyText(cost, currency)} 估算`}</strong>
                   <span>${escapeHtml(
                     `${Number(usage?.runs || 0)} 次运行 · ${tokenText(totalTokens)} tokens${
                       currency === 'USD' ? '' : ` · 按 1 美元 ≈ ¥${USD_CNY_RATE} 换算`
                     }`,
                   )}</span>
                 </div>
               </div>
               ${rows
                 .map((row) => {
                   const rowCostUsd = Number(row.estimatedCostUsd)
                   const rowCost = Number.isFinite(rowCostUsd)
                     ? moneyText(currency === 'USD' ? rowCostUsd : rowCostUsd * USD_CNY_RATE, currency)
                     : '未定价'
                   const rowTokens = Number(row.promptTokens || 0) + Number(row.completionTokens || 0)
                   return `<div class="setting-row">
                     <span class="setting-icon">${icon('list', 18)}</span>
                     <div class="setting-body">
                       <strong>${escapeHtml(row.model || '未知模型')}</strong>
                       <span>${escapeHtml(`${Number(row.runs || 0)} 次 · ${tokenText(rowTokens)} tokens · ${rowCost}`)}</span>
                     </div>
                   </div>`
                 })
                 .join('')}`
    }
    <div class="setting-actions">
      <button type="button" class="button ghost small" data-action="refresh-billing"${sheet.loading ? ' disabled' : ''}>
        ${sheet.loading ? '<span class="spinner"></span>' : icon('refresh', 14)}${report ? '刷新余额' : '读取余额'}
      </button>
    </div>
  </div>`
}

async function loadBilling(refresh) {
  if (!state.client?.connected) {
    state.billing.error = '与电脑的连接已断开。'
    if (state.route === 'settings') render()
    return
  }
  const sheet = state.billing
  sheet.loading = true
  sheet.error = ''
  if (state.route === 'settings') render()
  try {
    // 余额要等模型服务的网络往返，给足时间；电脑端自己还有缓存与并发合并。
    const report = await agentRequest('billing.get', refresh ? { refresh: true } : {}, 20000)
    sheet.report = report || null
    sheet.loading = false
  } catch (error) {
    sheet.loading = false
    sheet.error = methodError(error)
  }
  if (state.route === 'settings') render()
}

function renderSettings() {
  const info = state.deviceInfo || {}
  const themes = [
    { id: 'dark', label: '深色', icon: 'moon' },
    { id: 'light', label: '浅色', icon: 'sun' },
  ]
  return `<div class="settings-page">
    ${settingsHeader()}
    <div class="page">
      ${remoteAccessNotice()}
      <div class="page-heading">
        <div>
          <h2>连接</h2>
          <p>${escapeHtml(state.pairing?.deviceName || info.deviceName || '电脑')}</p>
        </div>
        ${connectionPill()}
      </div>
      <div class="card">
        <div class="setting-row">
          <span class="setting-icon">${icon('phone', 18)}</span>
          <div class="setting-body">
            <strong>${escapeHtml(info.deviceName || state.pairing?.deviceName || 'Pilot 电脑')}</strong>
            <span>${escapeHtml(info.platform || 'desktop')} · Pilot ${escapeHtml(info.appVersion || '')}</span>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-icon">${icon('spark', 18)}</span>
          <div class="setting-body">
            <strong>${escapeHtml(info.model || 'DeepSeek')}</strong>
            <span>电脑端当前模型</span>
          </div>
        </div>
        <div class="setting-row">
          <span class="setting-icon">${icon('clock', 18)}</span>
          <div class="setting-body">
            <strong>${connectionLabel()}</strong>
            <span>${escapeHtml(state.connectionMessage || '端到端加密连接')}</span>
          </div>
        </div>
        ${state.connection !== 'connected' ? `<div class="setting-actions"><button type="button" class="button primary" data-action="retry-connect">${icon('refresh', 15)}重新连接</button></div>` : ''}
      </div>

      <div class="page-heading" style="margin-top:24px"><div><h2>外观</h2><p>保存在这台手机上</p></div></div>
      <div class="card">
        <div class="theme-options">
          ${themes
            .map(
              (theme) => `<button type="button" class="theme-option${state.theme === theme.id ? ' active' : ''}" data-action="set-theme" data-theme="${theme.id}">
                ${icon(theme.icon, 18)}${theme.label}
              </button>`,
            )
            .join('')}
        </div>
      </div>

      ${canManageHost() ? renderBillingCard() : ''}

      ${
        canManageHost()
          ? `<div class="page-heading" style="margin-top:24px"><div><h2>升级</h2><p>只下载有变化的文件，重启后生效</p></div></div>
      <div class="card">
        <div class="setting-row">
          <span class="setting-icon">${icon('refresh', 18)}</span>
          <div class="setting-body">
            <strong>${updateVersionLabel()}</strong>
            <span>${escapeHtml(updateDetailLabel())}</span>
          </div>
        </div>
        <div class="setting-actions">${updateActionsHtml()}</div>
      </div>`
          : `<div class="page-heading" style="margin-top:24px"><div><h2>升级与维护</h2><p>由电脑上的人操作</p></div></div>
      <div class="card">
        <div class="setting-row">
          <span class="setting-icon">${icon('refresh', 18)}</span>
          <div class="setting-body">
            <strong>升级、进化、反思、体检</strong>
            <span>这些会改变电脑上的软件与配置，只能在电脑前操作</span>
          </div>
        </div>
      </div>`
      }

      <div class="page-heading" style="margin-top:24px"><div><h2>运行环境</h2><p>沙箱与自写工具（来自电脑端）</p></div></div>
      <div class="card">
        <div class="setting-row">
          <span class="setting-icon">${icon('terminal', 18)}</span>
          <div class="setting-body">
            <strong>${sandboxTitle()}</strong>
            <span>${escapeHtml(sandboxDetail())}</span>
          </div>
        </div>
        ${
          state.runtime.tools && state.runtime.tools.length > 0
            ? `<div class="setting-row">
                <span class="setting-icon">${icon('list', 18)}</span>
                <div class="setting-body">
                  <strong>自写工具 ${state.runtime.tools.length} 个</strong>
                  <span>${escapeHtml(
                    state.runtime.tools
                      .map(
                        (tool) =>
                          `${tool.name}${tool.enabled ? '' : '（已停用）'}${tool.approved ? '' : '（未批准）'}`,
                      )
                      .join('、'),
                  )}</span>
                </div>
              </div>`
            : ''
        }
        <div class="setting-actions">
          <button type="button" class="button ghost small" data-action="refresh-runtime"${state.runtime.loading ? ' disabled' : ''}>
            ${state.runtime.loading ? '<span class="spinner"></span>' : icon('refresh', 14)}重新检查
          </button>
        </div>
      </div>

      <div class="page-heading" style="margin-top:24px"><div><h2>安全</h2><p>配对凭证只保存在本机</p></div></div>
      <div class="card">
        <div class="card-body">
          <h3>端到端加密</h3>
          <p>手机与电脑使用 ECDH P-256 + HKDF + AES-256-GCM。中继只看到密文，电脑上的 API Key 不会发到手机。</p>
        </div>
      </div>
      ${
        canManageHost()
          ? `<div class="danger-zone">
        <button type="button" class="button danger" data-action="unpair">${icon('trash', 15)}解除配对</button>
      </div>`
          : ''
      }
    </div>
  </div>`
}

/* ── Render orchestration ──────────────────────────────────────────────── */

function captureFocus() {
  const active = document.activeElement
  if (!active || active.id !== 'composer-input') return null
  return { start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop }
}

function restoreFocus(saved) {
  if (!saved) return
  const el = document.getElementById('composer-input')
  if (!el) return
  el.focus()
  try {
    el.setSelectionRange(saved.start, saved.end)
    el.scrollTop = saved.scroll
  } catch {
    // ignore
  }
}

function render() {
  const root = document.getElementById('app')
  if (!root) return
  const focus = captureFocus()
  applyTheme()
  if (state.route === 'pair') root.innerHTML = renderPair()
  else if (state.route === 'settings') root.innerHTML = renderSettings()
  else if (state.route === 'chat') root.innerHTML = renderChat()
  else root.innerHTML = renderSessions()
  restoreFocus(focus)
  const scroll = document.getElementById('chat-scroll')
  if (scroll) {
    if (state.scrollToBottom) {
      scroll.scrollTop = scroll.scrollHeight
      state.scrollToBottom = false
    } else if (focus) {
      // Rerendering for a non-scroll reason should not jump the transcript.
    }
  }
  const input = document.getElementById('composer-input')
  if (input) resizeComposer(input)
}

function renderSlots() {
  if (state.route !== 'chat') return
  const processSlot = document.getElementById('process-slot')
  if (processSlot) processSlot.innerHTML = processHtml()
  const approvalSlot = document.getElementById('approval-slot')
  if (approvalSlot) approvalSlot.innerHTML = approvalsHtml()
  const queueSlot = document.getElementById('queue-slot')
  if (queueSlot) queueSlot.innerHTML = queueHtml()
  const todoSlot = document.getElementById('todo-slot')
  if (todoSlot) todoSlot.innerHTML = todosHtml()
  const continueSlot = document.getElementById('continue-slot')
  if (continueSlot) continueSlot.innerHTML = continueBarHtml()
  updateSendAvailability()
}

function renderSessionListOnly() {
  const list = document.getElementById('session-list')
  if (list) list.innerHTML = sessionListHtml()
  const label = document.querySelector('.section-label span')
  if (label) label.textContent = String(filteredSessions().length)
}

function updateSendAvailability() {
  const button = document.querySelector('.send-button')
  if (!button) return
  const disabled = !state.composer.trim() || state.connection !== 'connected' || state.sending
  button.disabled = disabled
}

function updateStreamingDom() {
  if (state.route !== 'chat') return
  const bubble = document.querySelector('[data-live-content]')
  if (bubble) {
    bubble.innerHTML = `${renderMarkdown(state.live?.text || '')}<span class="stream-caret"></span>`
    const scroll = document.getElementById('chat-scroll')
    if (scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120) {
      scroll.scrollTop = scroll.scrollHeight
    }
    return
  }
  if (state.live?.text) {
    state.scrollToBottom = true
    render()
  }
}

function scheduleProcessUpdate() {
  if (processUpdateTimer.id) return
  processUpdateTimer.id = setTimeout(() => {
    processUpdateTimer.id = null
    renderSlots()
  }, 120)
}

function resizeComposer(el) {
  el.style.height = 'auto'
  el.style.height = `${Math.min(128, Math.max(26, el.scrollHeight))}px`
}

/* ── Theme ─────────────────────────────────────────────────────────────── */

function applyTheme() {
  const light = state.theme === 'light'
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', themeColor(light))
}

/**
 * Browser chrome color. Server mode paints the console like the desktop client,
 * whose canvas is pure black (or #f2f2f2 when light); the phone PWA keeps its
 * own tinted palette.
 */
function themeColor(light) {
  if (document.documentElement.dataset.surface === 'desktop') {
    return light ? '#f2f2f2' : '#000000'
  }
  return light ? '#f3f6f9' : '#080c11'
}

function setTheme(theme) {
  state.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // ignore
  }
  applyTheme()
  render()
}

/* ── Data loading ──────────────────────────────────────────────────────── */

async function loadSessions() {
  if (!state.client?.connected) {
    const cached = readCache()
    if (cached) {
      state.sessions = Array.isArray(cached.sessions) ? cached.sessions : []
      state.workspaces = Array.isArray(cached.workspaces) ? cached.workspaces : []
      state.deviceInfo = state.deviceInfo || cached.deviceInfo || null
      state.offline = true
      state.loading = false
      state.sessionsError = ''
      if (state.route === 'sessions') render()
    } else {
      state.loading = false
      state.sessionsError = '与电脑的连接已断开，且这台手机还没有离线缓存。'
      if (state.route === 'sessions') render()
    }
    return
  }
  state.loading = true
  if (state.route === 'sessions') renderSessionListOnly()
  try {
    const data = await state.client.request('sessions.list')
    state.sessions = Array.isArray(data.sessions) ? data.sessions : []
    state.workspaces = Array.isArray(data.workspaces) ? data.workspaces : []
    state.workspaceRoots = Array.isArray(data.roots) ? data.roots.filter(Boolean) : []
    state.loading = false
    state.sessionsError = ''
    state.offline = false
    saveOfflineCache()
    if (state.route === 'sessions') render()
  } catch (error) {
    const cached = readCache()
    if (cached && state.sessions.length === 0) {
      state.sessions = Array.isArray(cached.sessions) ? cached.sessions : []
      state.workspaces = Array.isArray(cached.workspaces) ? cached.workspaces : []
      state.offline = true
    }
    state.loading = false
    state.sessionsError = error.message || String(error)
    if (state.route === 'sessions') render()
  }
}

function applyCachedSession(sessionId, note = '') {
  const cached = readCache()
  if (!cached?.session || cached.session.id !== sessionId) return false
  const session = cached.session
  state.session = session
  state.session.todos = Array.isArray(session.todos) ? session.todos : []
  state.plan = session.plan || null
  state.queue = Array.isArray(session.queue) ? session.queue : []
  state.approvals = []
  state.hasMore = Boolean(cached.hasMore)
  state.session.workspaceName = session.workspaceName || state.session.workspaceName
  state.running = false
  state.offline = true
  state.loading = false
  state.loadError = note
  state.scrollToBottom = false
  return true
}

async function loadSession(sessionId, options = {}) {
  if (!state.client?.connected) {
    if (!applyCachedSession(sessionId)) {
      state.loading = false
      state.loadError = '与电脑的连接已断开，且这个会话还没有离线缓存。'
      render()
      return
    }
    render()
    return
  }
  state.loading = true
  if (!options.silent) render()
  try {
    const data = await state.client.request('sessions.get', {
      sessionId,
      limit: 120,
    })
    if (state.sessionId !== sessionId) {
      state.loading = false
      return
    }
    state.session = data.session
    state.session.todos = Array.isArray(data.session.todos) ? data.session.todos : []
    state.plan = data.session.plan || null
    state.queue = data.session.queue || []
    state.approvals = Array.isArray(data.pendingApprovals) ? data.pendingApprovals : []
    state.hasMore = Boolean(data.hasMore)
    state.session.workspaceName = data.workspaceName || state.session.workspaceName
    state.running = Boolean(data.session.running)
    void loadQuickCommands()
    if (state.running && !state.live) {
      state.live = {
        runId: data.activeRun?.runId || '',
        status: 'running',
        text: '',
        reasoning: '',
        tools: [],
        startedAt: data.activeRun?.startedAt || '',
      }
    }
    if (!state.running && state.live) {
      state.live.status = 'done'
      state.live.text = ''
      state.live.reasoning = ''
    }
    state.loading = false
    state.loadError = ''
    state.offline = false
    state.scrollToBottom = options.scroll !== false
    saveOfflineCache()
    render()
  } catch (error) {
    if (applyCachedSession(sessionId, '当前显示上次缓存的内容，连接恢复后会自动刷新。')) {
      render()
      return
    }
    state.loading = false
    state.loadError = error.message || String(error)
    render()
  }
}

async function loadEarlier() {
  if (!state.session || !state.hasMore || state.loadingEarlier) return
  if (!state.client?.connected) {
    showToast('连接恢复后才能加载更早的消息。', 'warn')
    return
  }
  const sessionId = state.sessionId
  const first = state.session.messages?.[0]
  if (!sessionId || !first) return
  const scroll = document.getElementById('chat-scroll')
  const anchor = scroll ? { height: scroll.scrollHeight, top: scroll.scrollTop } : null
  state.loadingEarlier = true
  render()
  try {
    const data = await state.client.request('sessions.get', {
      sessionId,
      before: first.id,
      limit: 120,
    })
    if (state.sessionId !== sessionId || !state.session) return
    const existing = new Set(state.session.messages.map((message) => message.id))
    const older = (data.session.messages || []).filter((message) => !existing.has(message.id))
    state.session = { ...state.session, messages: [...older, ...state.session.messages] }
    state.hasMore = Boolean(data.hasMore)
    state.loadingEarlier = false
    state.scrollToBottom = false
    render()
    const next = document.getElementById('chat-scroll')
    if (scroll && next && anchor) {
      next.scrollTop = anchor.top + (next.scrollHeight - anchor.height)
    }
    saveOfflineCache()
  } catch (error) {
    state.loadingEarlier = false
    render()
    showToast(error.message || String(error), 'error')
  }
}

function scheduleSessionRefresh(sessionId) {
  if (state.sessionId !== sessionId) return
  if (sessionRefreshTimer.id) clearTimeout(sessionRefreshTimer.id)
  sessionRefreshTimer.id = setTimeout(() => {
    sessionRefreshTimer.id = null
    if (state.sessionId === sessionId) void loadSession(sessionId, { silent: true, scroll: false })
  }, 260)
}

function scheduleSessionsRefresh() {
  if (sessionsRefreshTimer.id) return
  sessionsRefreshTimer.id = setTimeout(() => {
    sessionsRefreshTimer.id = null
    void loadSessions()
  }, 600)
}

/* ── Event handling ────────────────────────────────────────────────────── */

function activeEvent(event) {
  return event && event.sessionId === state.sessionId
}

function ensureLive(runId = '') {
  if (!state.live) {
    state.live = {
      runId,
      status: 'running',
      text: '',
      reasoning: '',
      tools: [],
      startedAt: new Date().toISOString(),
    }
  }
  return state.live
}

function findTool(id) {
  return state.live?.tools?.find((tool) => tool.id === id)
}

function handleAgentEvent(event) {
  if (!event || typeof event.type !== 'string') return
  switch (event.type) {
    case 'run.started': {
      if (activeEvent(event)) {
        state.running = true
        state.live = {
          runId: event.runId,
          status: 'running',
          text: '',
          reasoning: '',
          tools: [],
          startedAt: new Date().toISOString(),
        }
        state.scrollToBottom = true
        render()
      }
      state.sessions = state.sessions.map((session) =>
        session.id === event.sessionId ? { ...session, running: true } : session,
      )
      scheduleSessionsRefresh()
      return
    }
    case 'step.started':
      return
    case 'message.started': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      live.text = ''
      live.reasoning = ''
      live.status = 'running'
      state.running = true
      if (state.route === 'chat') {
        state.scrollToBottom = true
        render()
      }
      return
    }
    case 'message.delta': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      live.text += event.text || ''
      live.status = 'running'
      state.running = true
      updateStreamingDom()
      return
    }
    case 'reasoning.delta': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      live.reasoning += event.text || ''
      scheduleProcessUpdate()
      return
    }
    case 'tool.call': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      if (!findTool(event.call.id)) {
        live.tools.push({
          id: event.call.id,
          name: event.call.name,
          args: event.call.arguments || {},
          risk: event.risk,
          status: 'running',
          result: null,
        })
      }
      scheduleProcessUpdate()
      return
    }
    case 'tool.approval_required': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      const existing = findTool(event.call.id)
      if (existing) existing.status = 'waiting'
      else {
        live.tools.push({
          id: event.call.id,
          name: event.call.name,
          args: event.call.arguments || {},
          risk: event.risk,
          status: 'waiting',
          result: null,
        })
      }
      if (!state.approvals.some((entry) => entry.callId === event.call.id)) {
        state.approvals.push({
          callId: event.call.id,
          runId: event.runId,
          sessionId: event.sessionId,
          tool: event.call.name,
          risk: event.risk,
          arguments: event.call.arguments || {},
          expiresAt: event.expiresAt,
        })
      }
      renderSlots()
      showToast('有一个工具调用需要你审批。', 'warn')
      return
    }
    case 'tool.approval_resolved': {
      if (!activeEvent(event)) return
      state.approvals = state.approvals.filter((entry) => entry.callId !== event.callId)
      const tool = findTool(event.callId)
      if (tool) tool.status = event.approved ? 'running' : 'denied'
      renderSlots()
      return
    }
    case 'tool.result': {
      if (!activeEvent(event)) return
      const live = ensureLive(event.runId)
      let tool = findTool(event.callId)
      if (!tool) {
        tool = {
          id: event.callId,
          name: event.name,
          args: {},
          risk: event.result?.risk || 'read',
          status: 'running',
          result: null,
        }
        live.tools.push(tool)
      }
      tool.status = event.result?.ok ? 'ok' : 'error'
      tool.result = event.result
      scheduleProcessUpdate()
      return
    }
    case 'context.compacted': {
      if (!activeEvent(event)) return
      showToast(
        `上下文已压缩：整理 ${event.compactedResults} 条旧工具输出，移除 ${event.droppedMessages} 条早期消息。`,
      )
      return
    }
    case 'run.completed': {
      if (activeEvent(event)) {
        state.running = false
        if (state.live) {
          state.live.status = 'done'
          state.live.text = ''
          state.live.reasoning = ''
        }
        state.approvals = []
        if (event.status !== 'completed') {
          showToast(
            event.status === 'paused'
              ? '任务已暂停，可点击“继续”从中断处接着做。'
              : event.status === 'cancelled'
                ? '任务已停止。'
                : event.status === 'max_steps'
                  ? '达到步数上限，任务已暂停。'
                  : 'Token 预算已用尽，任务已停止。',
            'warn',
          )
        }
        void loadSession(event.sessionId, { silent: true, scroll: false })
      }
      state.sessions = state.sessions.map((session) =>
        session.id === event.sessionId ? { ...session, running: false } : session,
      )
      scheduleSessionsRefresh()
      return
    }
    case 'run.failed': {
      if (activeEvent(event)) {
        state.running = false
        if (state.live) {
          state.live.status = 'error'
          state.live.text = ''
          state.live.reasoning = ''
        }
        state.approvals = []
        showToast(event.message || '任务执行失败。', 'error')
        void loadSession(event.sessionId, { silent: true, scroll: false })
      }
      state.sessions = state.sessions.map((session) =>
        session.id === event.sessionId ? { ...session, running: false } : session,
      )
      scheduleSessionsRefresh()
      return
    }
    case 'queue.changed': {
      if (activeEvent(event)) {
        state.queue = event.queue || []
        renderSlots()
      }
      state.sessions = state.sessions.map((session) =>
        session.id === event.sessionId
          ? { ...session, queueCount: (event.queue || []).length }
          : session,
      )
      return
    }
    case 'todos.changed': {
      const todos = Array.isArray(event.todos) ? event.todos : []
      if (activeEvent(event)) {
        if (state.session) state.session.todos = todos
        renderSlots()
      }
      const pending = todos.filter((todo) => todo.status !== 'sent').length
      state.sessions = state.sessions.map((session) =>
        session.id === event.sessionId ? { ...session, todoCount: pending } : session,
      )
      if (state.route === 'sessions') renderSessionListOnly()
      return
    }
    case 'scheduled.changed': {
      if (activeEvent(event)) {
        if (state.sheet === 'schedules') void loadSchedules()
        void loadSession(event.sessionId, { silent: true, scroll: false })
      }
      return
    }
    case 'session.changed': {
      scheduleSessionRefresh(event.sessionId)
      scheduleSessionsRefresh()
      return
    }
    case 'update.changed': {
      state.update = event.state || null
      if (state.route === 'settings') render()
      return
    }
    case 'evolution.changed':
    case 'profile.changed': {
      // 进化轮次与评审都是电脑端异步跑的，事件到了才刷新；不抢正在进行的请求。
      if (state.sheet === 'evolution' && !state.evolution.busy) void loadEvolution()
      return
    }
    case 'notice': {
      if (event.message) showToast(event.message, event.level || 'info')
      return
    }
    default:
      return
  }
}

/* ── Actions ───────────────────────────────────────────────────────────── */

function methodError(error) {
  return error?.message || String(error)
}

async function sendMessage() {
  const text = state.composer.trim()
  if (!text || !state.client?.connected || !state.sessionId || state.sending) return
  state.sending = true
  updateSendAvailability()
  try {
    const result = await state.client.request('chat.send', {
      sessionId: state.sessionId,
      content: text,
      delivery: state.delivery,
    })
    rememberInput(text)
    state.historyIndex = -1
    state.historyDraft = ''
    if (state.composer.trim() === text) state.composer = ''
    state.delivery = 'queue'
    state.running = true
    if (!state.live) {
      state.live = {
        runId: '',
        status: 'running',
        text: '',
        reasoning: '',
        tools: [],
        startedAt: new Date().toISOString(),
      }
    }
    state.scrollToBottom = true
    render()
    if (result?.queued) showToast('已加入队列，当前任务结束后自动开始。')
  } catch (error) {
    showToast(methodError(error), 'error')
  } finally {
    state.sending = false
    updateSendAvailability()
  }
}

async function stopRun() {
  if (!state.client?.connected || !state.sessionId) return
  if (!window.confirm('停止当前任务？停止后不会自动继续，需要重新发送。')) return
  try {
    await state.client.request('chat.stop', { sessionId: state.sessionId })
    showToast('已请求停止任务。', 'warn')
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function pauseRun() {
  if (!state.client?.connected || !state.sessionId) return
  if (!window.confirm('暂停当前任务？暂停后可随时点「继续」接着执行。')) return
  try {
    await state.client.request('chat.pause', { sessionId: state.sessionId })
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function resumeRun() {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('chat.resume', { sessionId: state.sessionId })
    state.running = true
    if (state.session) {
      state.session.paused = false
      state.session.canContinue = false
    }
    state.scrollToBottom = true
    render()
    showToast('正在从中断处继续任务…')
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

function setSessionTodos(todos) {
  if (!state.session) return
  state.session.todos = Array.isArray(todos) ? todos : []
  state.session.todoCount = state.session.todos.filter((todo) => todo.status !== 'sent').length
}

async function addTodo() {
  const text = state.todoDraft.trim()
  if (!text || !state.client?.connected || !state.sessionId) return
  try {
    const result = await state.client.request('todos.add', {
      sessionId: state.sessionId,
      text,
    })
    state.todoDraft = ''
    if (result?.todo && state.session) {
      const existing = state.session.todos || []
      setSessionTodos([...existing.filter((todo) => todo.id !== result.todo.id), result.todo])
    }
    renderSlots()
    document.getElementById('todo-input')?.focus()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function updateTodo(todoId) {
  if (!state.client?.connected || !state.sessionId) return
  const todo = (state.session?.todos || []).find((entry) => entry.id === todoId)
  if (!todo) return
  const next = window.prompt('编辑待办', todo.text || '')
  if (next == null) return
  const text = next.trim()
  if (!text || text === todo.text) return
  try {
    await state.client.request('todos.update', {
      sessionId: state.sessionId,
      todoId,
      text,
    })
    if (state.session) {
      setSessionTodos(
        (state.session.todos || []).map((entry) =>
          entry.id === todoId ? { ...entry, text } : entry,
        ),
      )
    }
    renderSlots()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function removeTodo(todoId) {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('todos.remove', { sessionId: state.sessionId, todoId })
    if (state.session) {
      setSessionTodos((state.session.todos || []).filter((entry) => entry.id !== todoId))
    }
    renderSlots()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function sendTodo(todoId) {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('todos.send', { sessionId: state.sessionId, todoId })
    showToast('待办已发送给 Pilot。')
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function sendAllTodos() {
  if (!state.client?.connected || !state.sessionId) return
  try {
    const result = await state.client.request('todos.sendAll', { sessionId: state.sessionId })
    const sent = Number(result?.sent) || 0
    const failed = Number(result?.failed) || 0
    showToast(
      `已发送 ${sent} 条待办${failed > 0 ? `，${failed} 条失败` : ''}。`,
      failed > 0 ? 'warn' : 'info',
    )
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function clearSentTodos() {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('todos.clearSent', { sessionId: state.sessionId })
    if (state.session) {
      setSessionTodos((state.session.todos || []).filter((entry) => entry.status !== 'sent'))
    }
    renderSlots()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

/**
 * 手机端发起的请求统一入口：没连上就先报错，而不是让 fetch 抛一个看不懂的错误。
 */
function agentRequest(method, params = {}, timeout) {
  if (!state.client?.connected) throw new Error('与电脑的连接已断开。')
  return Number.isFinite(timeout)
    ? state.client.request(method, params, timeout)
    : state.client.request(method, params)
}

/** 快捷指令：电脑端返回 null 表示用户没改过预设，此时不展示任何 chips。 */
async function loadQuickCommands() {
  if (!state.client?.connected || state.quickCommandsLoaded) return
  state.quickCommandsLoaded = true
  try {
    const data = await agentRequest('quickCommands.get')
    state.quickCommands = Array.isArray(data?.commands) ? data.commands.slice(0, 8) : []
    const slot = document.getElementById('quick-command-slot')
    if (slot) slot.innerHTML = quickCommandsHtml()
  } catch {
    // 旧版电脑端没有这个方法：静默略过，不打断输入。
    state.quickCommandsLoaded = false
  }
}

async function openCheckpoints() {
  if (!state.sessionId) return
  state.menuOpen = false
  state.sheet = 'checkpoints'
  state.checkpoints = { loading: true, items: [], error: '', busy: '' }
  render()
  await loadCheckpoints()
}

async function loadCheckpoints() {
  const sessionId = state.sessionId
  if (!sessionId) return
  state.checkpoints.loading = true
  state.checkpoints.error = ''
  if (state.sheet === 'checkpoints') render()
  try {
    const data = await agentRequest('checkpoints.list', { sessionId })
    if (state.sheet !== 'checkpoints' || state.sessionId !== sessionId) return
    state.checkpoints.items = Array.isArray(data?.checkpoints) ? data.checkpoints : []
    state.checkpoints.loading = false
    render()
  } catch (error) {
    if (state.sessionId !== sessionId) return
    state.checkpoints.loading = false
    state.checkpoints.error = methodError(error)
    if (state.sheet === 'checkpoints') render()
  }
}

async function createCheckpoint() {
  if (!state.sessionId || state.checkpoints.busy) return
  state.checkpoints.busy = 'create'
  state.checkpoints.error = ''
  if (state.sheet === 'checkpoints') render()
  try {
    const data = await agentRequest('checkpoints.create', { sessionId: state.sessionId })
    state.checkpoints.busy = ''
    const created = data?.checkpoint
    if (created) state.checkpoints.items = [created, ...state.checkpoints.items]
    if (state.sheet === 'checkpoints') render()
    showToast('已创建回退点。', 'info')
  } catch (error) {
    state.checkpoints.busy = ''
    showToast(methodError(error), 'error')
    if (state.sheet === 'checkpoints') render()
  }
}

async function restoreCheckpoint(checkpointId, mode) {
  if (!state.sessionId || !checkpointId || state.checkpoints.busy) return
  const both = mode === 'both'
  const question = both
    ? '恢复这个快照的文件和对话？该快照之后的消息会从会话里移除。'
    : '恢复这个快照的文件？当前工作区里同名文件会被覆盖。'
  if (!window.confirm(question)) return
  state.checkpoints.busy = checkpointId
  if (state.sheet === 'checkpoints') render()
  try {
    await agentRequest('checkpoints.restore', {
      sessionId: state.sessionId,
      checkpointId,
      mode: both ? 'both' : 'code',
    })
    state.checkpoints.busy = ''
    showToast(both ? '已恢复文件和对话。' : '已恢复文件。', 'info')
    await loadSession(state.sessionId, { silent: true })
    if (state.sessionId) await loadCheckpoints()
  } catch (error) {
    state.checkpoints.busy = ''
    showToast(methodError(error), 'error')
    if (state.sheet === 'checkpoints') render()
  }
}

async function openChanges() {
  if (!state.sessionId) return
  state.menuOpen = false
  state.sheet = 'changes'
  state.changes = { loading: true, items: [], error: '', busy: '', expanded: {} }
  render()
  await loadChanges()
}

async function loadChanges() {
  const sessionId = state.sessionId
  if (!sessionId) return
  state.changes.loading = true
  state.changes.error = ''
  if (state.sheet === 'changes') render()
  try {
    const data = await agentRequest('changes.list', { sessionId })
    if (state.sheet !== 'changes' || state.sessionId !== sessionId) return
    state.changes.items = Array.isArray(data?.changes) ? data.changes : []
    state.changes.loading = false
    render()
  } catch (error) {
    if (state.sessionId !== sessionId) return
    state.changes.loading = false
    state.changes.error = methodError(error)
    if (state.sheet === 'changes') render()
  }
}

async function revertChange(path) {
  if (!state.sessionId || !path || state.changes.busy) return
  if (!window.confirm(`把「${path}」还原到这个任务开始前的状态？`)) return
  state.changes.busy = path
  if (state.sheet === 'changes') render()
  try {
    await agentRequest('changes.revert', { sessionId: state.sessionId, path })
    state.changes.busy = ''
    showToast('已还原文件。', 'info')
    await loadChanges()
  } catch (error) {
    state.changes.busy = ''
    showToast(methodError(error), 'error')
    if (state.sheet === 'changes') render()
  }
}

async function openResources(tab = 'links') {
  if (!state.sessionId) return
  state.menuOpen = false
  state.sheet = 'resources'
  state.resources = {
    loading: false,
    error: '',
    tab: state.resources?.tab || tab,
    links: [],
    tools: [],
    memory: [],
    knowledge: [],
    files: [],
    preview: null,
    loaded: {},
  }
  render()
  await loadResourceTab(state.resources.tab)
}

async function loadResourceTab(tab) {
  const sessionId = state.sessionId
  if (!sessionId) return
  const sheet = state.resources
  sheet.tab = tab
  sheet.error = ''
  if (tab !== 'files') sheet.preview = null
  if (sheet.loaded[tab]) {
    render()
    return
  }
  sheet.loading = true
  render()
  try {
    if (tab === 'links') {
      const data = await agentRequest('sessions.links', { sessionId, limit: 50 })
      sheet.links = Array.isArray(data?.links) ? data.links : []
    } else if (tab === 'tools') {
      const data = await agentRequest('sessions.tools', { sessionId, limit: 50 })
      sheet.tools = Array.isArray(data?.tools) ? data.tools : []
    } else if (tab === 'memory') {
      const data = await agentRequest('memory.session', { sessionId })
      sheet.memory = Array.isArray(data?.memory) ? data.memory : []
    } else if (tab === 'files') {
      const data = await agentRequest('files.session', { sessionId })
      sheet.files = (Array.isArray(data?.artifacts) ? data.artifacts : []).filter((file) => file && file.path)
    } else {
      const data = await agentRequest('sessions.knowledge', { sessionId, limit: 12 })
      sheet.knowledge = Array.isArray(data?.pairs) ? data.pairs : []
    }
    sheet.loaded[tab] = true
    sheet.loading = false
    if (state.sheet !== 'resources' || state.sessionId !== sessionId) return
    render()
  } catch (error) {
    if (state.sessionId !== sessionId) return
    sheet.loading = false
    sheet.error = methodError(error)
    if (state.sheet === 'resources') render()
  }
}

async function openModels() {
  if (!state.sessionId) return
  state.menuOpen = false
  state.sheet = 'models'
  state.models = {
    loading: true,
    resources: [],
    sessionModelId: state.session?.sessionModelId || '',
    approvalMode: state.session?.approvalMode || 'auto',
    error: '',
    busy: '',
  }
  render()
  try {
    const data = await agentRequest('models.get')
    if (state.sheet !== 'models') return
    state.models.loading = false
    state.models.resources = Array.isArray(data?.resources) ? data.resources : []
    state.models.sessionModelId = state.session?.sessionModelId || data?.sessionModelId || ''
    render()
  } catch (error) {
    if (state.sheet !== 'models') return
    state.models.loading = false
    state.models.error = methodError(error)
    render()
  }
}

async function setApprovalMode(mode) {
  if (!state.sessionId || state.models.busy) return
  if (mode === state.models.approvalMode) return
  state.models.busy = 'mode'
  state.models.error = ''
  render()
  try {
    const updated = await agentRequest('sessions.approvalMode', {
      sessionId: state.sessionId,
      approvalMode: mode,
    })
    state.models.busy = ''
    state.models.approvalMode = updated?.approvalMode || mode
    if (state.session) state.session.approvalMode = state.models.approvalMode
    if (state.sheet === 'models') render()
    showToast('执行模式已切换。', 'info')
  } catch (error) {
    state.models.busy = ''
    showToast(methodError(error), 'error')
    if (state.sheet === 'models') render()
  }
}

async function setSessionModel(modelId) {
  if (!state.sessionId || state.models.busy) return
  state.models.busy = 'model'
  state.models.error = ''
  render()
  try {
    const updated = await agentRequest('sessions.model', {
      sessionId: state.sessionId,
      modelId: String(modelId || ''),
    })
    state.models.busy = ''
    state.models.sessionModelId = String(updated?.sessionModelId || modelId || '')
    if (state.session) state.session.sessionModelId = state.models.sessionModelId
    if (state.sheet === 'models') render()
    showToast('已切换这个任务的模型。', 'info')
  } catch (error) {
    state.models.busy = ''
    showToast(methodError(error), 'error')
    if (state.sheet === 'models') render()
  }
}

async function openLearning() {
  if (!state.sessionId) return
  state.menuOpen = false
  state.sheet = 'learning'
  state.learning.loading = true
  state.learning.error = ''
  render()
  await loadLearning()
}

/** The ledger lives in a workspace, so the panel follows the open session. */
function learningWorkspacePath() {
  return state.session?.workspacePath || ''
}

function applyLearningState(next) {
  const value = next || {}
  const hosts = Array.isArray(value.hosts) ? value.hosts.map(String) : []
  state.learning.enabled = value.enabled === true
  state.learning.hosts = hosts
  state.learning.effectiveHosts = Array.isArray(value.effectiveHosts)
    ? value.effectiveHosts.map(String)
    : []
  state.learning.defaultHosts = Array.isArray(value.defaultHosts)
    ? value.defaultHosts.map(String)
    : []
  state.learning.ledger = String(value.ledger || '')
  state.learning.entryTotal = Number(value.entryTotal) || 0
  state.learning.summary = value.summary && typeof value.summary === 'object' ? value.summary : {}
  state.learning.entries = Array.isArray(value.entries) ? value.entries : []
  state.learning.hostsDraft = hosts.join('\n')
}

async function loadLearning() {
  const workspacePath = learningWorkspacePath()
  if (!workspacePath) {
    state.learning.loading = false
    state.learning.error = '这个会话没有关联工作区，读不到学习账本。'
    if (state.sheet === 'learning') render()
    return
  }
  state.learning.error = ''
  try {
    const data = await agentRequest('learning.state', { workspacePath })
    applyLearningState(data?.state)
    state.learning.loading = false
  } catch (error) {
    state.learning.loading = false
    state.learning.error = methodError(error)
  }
  if (state.sheet === 'learning') render()
}

/**
 * 开关和白名单写的是电脑端全局设置。两个动作共用一条通道，
 * 成功后用电脑端回传的状态覆盖本地，避免手机端自以为是。
 */
async function saveLearningSettings(settings, busyKey) {
  const workspacePath = learningWorkspacePath()
  if (!workspacePath) return
  state.learning.busy = busyKey
  state.learning.error = ''
  if (state.sheet === 'learning') render()
  try {
    const data = await agentRequest('learning.settings', { workspacePath, settings })
    applyLearningState(data?.state)
    state.learning.busy = ''
  } catch (error) {
    state.learning.busy = ''
    state.learning.error = methodError(error)
  }
  if (state.sheet === 'learning') render()
}

function toggleLearning() {
  if (state.learning.busy) return
  void saveLearningSettings({ enabled: !state.learning.enabled }, 'toggle')
}

function saveLearningHosts() {
  if (state.learning.busy) return
  const field = document.getElementById('learning-hosts')
  const raw = field ? field.value : state.learning.hostsDraft
  const hosts = String(raw)
    .split(/\n|,|\s+/)
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  const invalid = hosts.filter((host) => !/^[a-z0-9.-]+$/.test(host) || !host.includes('.'))
  if (invalid.length) {
    state.learning.hostsDraft = hosts.join('\n')
    state.learning.error = `只填主机名，不要带协议或路径：${invalid.slice(0, 3).join('、')}`
    if (state.sheet === 'learning') render()
    return
  }
  state.learning.hostsDraft = hosts.join('\n')
  void saveLearningSettings({ hosts }, 'hosts')
}

function fillDefaultLearningHosts() {
  state.learning.hostsDraft = state.learning.defaultHosts.join('\n')
  state.learning.error = ''
  if (state.sheet === 'learning') render()
}

async function openCheck() {
  state.menuOpen = false
  state.sheet = 'check'
  state.check.loading = true
  state.check.error = ''
  render()
  await loadCheck()
}

function applyCheckState(next) {
  const value = next || {}
  const settings = value.settings || {}
  state.check.enabled = settings.enabled === true
  state.check.lastRunAt = String(value.lastRunAt || '')
  state.check.nextRunAt = String(value.nextRunAt || '')
  state.check.historyCount = Number(value.historyCount) || 0
  state.check.decisions = Array.isArray(value.decisions) ? value.decisions.length : 0
  state.check.proposals = Array.isArray(value.proposals) ? value.proposals.length : 0
  state.check.report = value.lastReport || null
}

async function loadCheck() {
  try {
    const data = await agentRequest('moduleCheck.state')
    applyCheckState(data?.state)
    state.check.loading = false
  } catch (error) {
    state.check.loading = false
    state.check.error = methodError(error)
  }
  if (state.sheet === 'check') render()
}

async function toggleModuleCheck() {
  if (state.check.busy) return
  state.check.busy = 'toggle'
  state.check.error = ''
  if (state.sheet === 'check') render()
  try {
    const data = await agentRequest('moduleCheck.settings', {
      settings: { enabled: !state.check.enabled },
    })
    applyCheckState(data?.state)
  } catch (error) {
    state.check.error = methodError(error)
  }
  state.check.busy = ''
  if (state.sheet === 'check') render()
}

/** 扫描是只读的：不改文件，也不建会话，所以可以直接从手机发起。 */
async function runModuleCheck() {
  if (state.check.busy) return
  state.check.busy = 'run'
  state.check.error = ''
  if (state.sheet === 'check') render()
  try {
    const data = await agentRequest('moduleCheck.run', {})
    state.check.report = data?.report || null
  } catch (error) {
    state.check.error = methodError(error)
  }
  state.check.busy = ''
  if (state.sheet === 'check') render()
  await loadCheck()
}

async function runSelfCheck() {
  if (state.check.busy) return
  state.check.busy = 'self'
  state.check.error = ''
  if (state.sheet === 'check') render()
  try {
    const data = await agentRequest('selfCheck.run')
    state.check.selfCheck = data?.report || null
  } catch (error) {
    state.check.error = methodError(error)
  }
  state.check.busy = ''
  if (state.sheet === 'check') render()
}

function toggleRisk(key) {
  if (!key) return
  state.check.expanded[key] = !state.check.expanded[key]
  if (state.sheet === 'check') render()
}

async function openEvolution() {
  state.menuOpen = false
  state.sheet = 'evolution'
  state.evolution.loading = true
  state.evolution.error = ''
  render()
  await loadEvolution()
}

async function loadEvolution() {
  const path = evolutionWorkspacePath()
  if (!path) {
    state.evolution.loading = false
    state.evolution.state = null
    if (state.sheet === 'evolution') render()
    return
  }
  try {
    const data = await agentRequest('evolution.state', { workspacePath: path }, 60_000)
    state.evolution.state = data || null
    state.evolution.error = ''
  } catch (error) {
    state.evolution.state = null
    state.evolution.error = methodError(error)
  }
  state.evolution.loading = false
  if (state.sheet === 'evolution') render()
}

function selectEvolutionWorkspace(path) {
  if (!path || path === evolutionWorkspacePath()) return
  state.evolution.workspacePath = path
  state.evolution.loading = true
  state.evolution.state = null
  if (state.sheet === 'evolution') render()
  void loadEvolution()
}

/**
 * 进化动作统一入口。cycle / improvePolicy 由电脑端异步开跑，立刻返回 started；
 * review 要等评审模型跑完，所以给它更长超时，并且允许期间面板显示「正在跑」。
 */
async function runEvolutionAction(op, extra = {}) {
  if (!op || state.evolution.busy) return
  const path = evolutionWorkspacePath()
  if (!path) return
  state.evolution.busy = op
  state.evolution.error = ''
  if (state.sheet === 'evolution') render()
  try {
    await agentRequest(
      'evolution.action',
      { action: op, workspacePath: path, ...extra },
      op.startsWith('global') || op === 'review' || op === 'cycle' ? 120_000 : 60_000,
    )
    const labels = {
      cycle: '已开始跑一轮进化。',
      improvePolicy: '已开始改进化机制。',
      rollbackPolicy: '已回滚到上一份机制。',
      review: '评审完成。',
      activate: '已启用这个版本。',
      rollback: '已回滚到上一版。',
      delete: '已删除这份草稿。',
      globalReview: '全局版本评审完成。',
      globalActivate: '已启用全局版本。',
      globalRollback: '已回滚全局版本。',
      globalDelete: '已删除全局草稿。',
      auto: '已更新自动进化开关。',
    }
    if (labels[op]) showToast(labels[op])
  } catch (error) {
    state.evolution.error = methodError(error)
  }
  state.evolution.busy = ''
  if (state.sheet === 'evolution') render()
  await loadEvolution()
}

function toggleAutoEvolve() {
  const next = state.evolution.state?.autoEvolve !== true
  void runEvolutionAction('auto', { value: next })
}

function useQuickCommand(index) {
  const command = state.quickCommands?.[index]
  const content = String(command?.content || '')
  if (!content) return
  state.composer = state.composer ? `${state.composer}\n${content}` : content
  render()
  const input = document.getElementById('composer-input')
  if (input) {
    input.value = state.composer
    resizeComposer(input)
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
  rememberInput(content)
}

async function openArtifacts() {
  if (!state.client?.connected || !state.sessionId) return
  state.menuOpen = false
  state.sheet = 'artifacts'
  state.artifacts = { loading: true, items: [], error: '', preview: null }
  render()
  try {
    const data = await state.client.request('files.session', { sessionId: state.sessionId })
    if (state.sheet !== 'artifacts') return
    state.artifacts = {
      loading: false,
      items: Array.isArray(data.artifacts) ? data.artifacts : [],
      error: '',
      preview: null,
    }
    render()
  } catch (error) {
    state.artifacts.loading = false
    state.artifacts.error = methodError(error)
    render()
  }
}

async function previewResourceFile(path) {
  if (!state.client?.connected || !state.session || !path) return
  const sheet = state.resources
  sheet.loading = true
  sheet.error = ''
  render()
  try {
    const data = await state.client.request('files.read', {
      workspacePath: state.session.workspacePath,
      file: path,
    })
    sheet.preview = { path: data.path || path, content: data.content || '' }
    sheet.loading = false
    render()
  } catch (error) {
    sheet.loading = false
    sheet.error = methodError(error)
    render()
  }
}

/** 会话列表上的五分类快捷入口：进入会话后自动打开对应分类。 */
function openSessionResources(sessionId, tab) {
  if (!sessionId) return
  const nextTab = RESOURCE_TABS.some((entry) => entry.id === tab) ? tab : 'links'
  if (state.route === 'chat' && state.sessionId === sessionId && state.session) {
    void openResources(nextTab)
    return
  }
  navigate({
    name: 'chat',
    id: sessionId,
    after: () => {
      void openResources(nextTab)
    },
  })
}

/** 把当前预览的文本存到手机：浏览器自己就能落盘，不用再请电脑端发一遍。 */
function downloadPreviewFile(scope) {
  const store = scope === 'files' ? state.files : scope === 'artifacts' ? state.artifacts : state.resources
  const preview = store?.preview
  if (!preview) return
  const name = String(preview.path || 'pilot-file').split('/').pop() || 'pilot-file'
  const blob = new Blob([String(preview.content ?? '')], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  showToast(`已保存到手机：${name}`, 'info')
}

async function previewArtifact(path) {
  if (!state.client?.connected || !state.session) return
  state.artifacts.loading = true
  state.artifacts.error = ''
  render()
  try {
    const data = await state.client.request('files.read', {
      workspacePath: state.session.workspacePath,
      file: path,
    })
    state.artifacts.preview = { path: data.path || path, content: data.content || '' }
    state.artifacts.loading = false
    render()
  } catch (error) {
    state.artifacts.loading = false
    state.artifacts.error = methodError(error)
    render()
  }
}

async function openSchedules() {
  state.menuOpen = false
  state.sheet = 'schedules'
  state.schedules.error = ''
  state.schedules.loading = true
  render()
  await loadSchedules()
}

async function loadSchedules() {
  if (!state.sessionId) return
  if (!state.client?.connected) {
    state.schedules.loading = false
    state.schedules.error = '与电脑的连接已断开，暂时无法读取定时任务。'
    if (state.sheet === 'schedules') render()
    return
  }
  state.schedules.loading = true
  if (state.sheet === 'schedules') render()
  try {
    const data = await state.client.request('schedules.list', { sessionId: state.sessionId })
    state.schedules.items = Array.isArray(data.tasks) ? data.tasks : []
    state.schedules.error = ''
  } catch (error) {
    state.schedules.error = methodError(error)
  } finally {
    state.schedules.loading = false
    if (state.sheet === 'schedules') render()
  }
}

async function addSchedule() {
  const schedules = state.schedules
  const content = schedules.content.trim()
  if (!content) {
    schedules.error = '先写清楚要定时执行的内容。'
    render()
    return
  }
  if (!state.client?.connected) {
    schedules.error = '与电脑的连接已断开，无法添加定时任务。'
    render()
    return
  }
  const params = { sessionId: state.sessionId, content, kind: schedules.kind }
  if (schedules.kind === 'once') {
    const delay = Number(schedules.delay)
    if (!Number.isFinite(delay) || delay < 1 || delay > 10_080) {
      schedules.error = '延迟时间需要在 1 到 10,080 分钟之间。'
      render()
      return
    }
    params.delayMinutes = delay
  } else if (schedules.kind === 'interval') {
    const interval = Number(schedules.interval)
    if (!Number.isFinite(interval) || interval < 1 || interval > 10_080) {
      schedules.error = '间隔需要在 1 到 10,080 分钟之间。'
      render()
      return
    }
    params.intervalMinutes = interval
  } else {
    params.timeOfDay = schedules.time
  }
  schedules.busy = true
  schedules.error = ''
  render()
  try {
    const data = await state.client.request('schedules.add', params)
    if (data?.task) {
      state.schedules.items = [...state.schedules.items, data.task].sort((a, b) =>
        String(a.nextRunAt).localeCompare(String(b.nextRunAt)),
      )
    }
    state.schedules.content = ''
    showToast('定时任务已添加。')
  } catch (error) {
    state.schedules.error = methodError(error)
  } finally {
    state.schedules.busy = false
    if (state.sheet === 'schedules') render()
  }
}

async function toggleSchedule(taskId) {
  const task = state.schedules.items.find((entry) => entry.id === taskId)
  if (!task || !state.client?.connected) return
  state.schedules.busy = taskId
  render()
  try {
    const data = await state.client.request('schedules.update', {
      sessionId: state.sessionId,
      taskId,
      enabled: !task.enabled,
    })
    if (data?.task) {
      state.schedules.items = state.schedules.items.map((entry) =>
        entry.id === taskId ? data.task : entry,
      )
    }
  } catch (error) {
    state.schedules.error = methodError(error)
    showToast(state.schedules.error, 'error')
  } finally {
    state.schedules.busy = false
    if (state.sheet === 'schedules') render()
  }
}

async function removeSchedule(taskId) {
  const task = state.schedules.items.find((entry) => entry.id === taskId)
  if (!task || !state.client?.connected) return
  if (!window.confirm(`删除定时任务「${task.content.slice(0, 40)}」？`)) return
  state.schedules.busy = taskId
  render()
  try {
    await state.client.request('schedules.remove', { sessionId: state.sessionId, taskId })
    state.schedules.items = state.schedules.items.filter((entry) => entry.id !== taskId)
  } catch (error) {
    state.schedules.error = methodError(error)
    showToast(state.schedules.error, 'error')
  } finally {
    state.schedules.busy = false
    if (state.sheet === 'schedules') render()
  }
}

function transcriptText() {
  const messages = state.session?.messages || []
  const parts = []
  for (const message of messages) {
    const content = String(message.content || '')
    if (message.role === 'user') {
      if (message.control) continue
      if (content.trim()) parts.push(`## 我\n${content.trim()}`)
      continue
    }
    if (message.role === 'assistant') {
      if (content.trim()) parts.push(`## Pilot\n${content.trim()}`)
      for (const call of message.toolCalls || []) {
        const args = JSON.stringify(call.arguments || {})
        parts.push(`> 调用 ${call.name} ${args.length > 400 ? `${args.slice(0, 400)}…` : args}`)
      }
      continue
    }
    if (message.role === 'tool' && content.trim()) {
      const body = content.trim()
      parts.push(
        `> ${message.name || 'tool'} ${message.isError ? '失败' : '完成'}\n${
          body.length > 4000 ? `${body.slice(0, 4000)}…` : body
        }`,
      )
    }
  }
  return parts.join('\n\n')
}

async function copyTranscript() {
  state.menuOpen = false
  const text = transcriptText()
  if (!text.trim()) {
    showToast('没有可复制的对话内容。', 'warn')
    render()
    return
  }
  const ok = await copyText(text)
  showToast(ok ? '已复制全部对话。' : '复制失败，请手动选择文本。', ok ? 'info' : 'error')
  render()
}

async function forkSession() {
  if (!state.client?.connected || !state.sessionId) return
  state.menuOpen = false
  try {
    const session = await state.client.request('sessions.fork', { sessionId: state.sessionId })
    showToast('已创建会话副本。')
    state.sessionId = session.id
    navigate({ name: 'chat', id: session.id })
    void loadSessions()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function deleteSession() {
  if (!state.client?.connected || !state.sessionId) return
  state.menuOpen = false
  if (!window.confirm('删除这个会话？对话记录与检查点都会被删掉，无法恢复。')) {
    render()
    return
  }
  try {
    await state.client.request('sessions.delete', { sessionId: state.sessionId })
    showToast('会话已删除。')
    state.sessionId = null
    state.session = null
    navigate({ name: 'sessions' })
    void loadSessions()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

/** Re-run the last turn without retyping it, for a run that failed or was stopped. */
async function retryRun() {
  if (!state.client?.connected || !state.sessionId) return
  state.menuOpen = false
  try {
    await state.client.request('run.retry', { sessionId: state.sessionId })
    showToast('已重新开始上一轮。')
    void loadSession(state.sessionId)
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function decideApproval(callId, approved, always = false) {
  if (!state.client?.connected) return
  try {
    if (always) {
      await state.client.request('approval.allowSession', {
        callId,
        sessionId: state.sessionId,
      })
      state.approvals = state.approvals.filter((entry) => entry.callId !== callId)
      renderSlots()
      showToast('已允许，并将会话切换为全部自动；后续工具会直接执行，受保护路径与拒绝规则仍然生效。')
    } else {
      await state.client.request('approval.decide', { callId, approved })
      state.approvals = state.approvals.filter((entry) => entry.callId !== callId)
      renderSlots()
    }
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function removeQueue(taskId) {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('queue.remove', { sessionId: state.sessionId, taskId })
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function insertQueue(taskId) {
  if (!state.client?.connected || !state.sessionId) return
  try {
    await state.client.request('queue.insert', { sessionId: state.sessionId, taskId })
    showToast('已插入当前任务。')
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

function resetWorkspaceBrowser() {
  state.workspacePath = ''
  state.workspaceParent = ''
  state.workspaceEntries = []
  state.workspaceBrowseError = ''
  state.workspaceBrowseBusy = false
  state.workspaceTruncated = false
  state.workspaceBrowseSeq += 1
}

function openWorkspaceSheet() {
  state.workspaceRoot = selectedWorkspaceRoot()
  state.workspaceDraft = ''
  resetWorkspaceBrowser()
  state.sheet = 'workspace'
  render()
  void browseWorkspace('')
}

async function browseWorkspace(path) {
  if (!state.client?.connected) return
  const root = selectedWorkspaceRoot()
  if (!root) return
  const seq = ++state.workspaceBrowseSeq
  state.workspacePath = String(path || '')
  state.workspaceBrowseBusy = true
  state.workspaceBrowseError = ''
  render()
  try {
    const data = await state.client.request('workspaces.browse', {
      root,
      path: state.workspacePath,
    })
    if (seq !== state.workspaceBrowseSeq) return
    state.workspaceEntries = Array.isArray(data?.entries)
      ? data.entries.filter((entry) => entry && typeof entry.name === 'string')
      : []
    state.workspaceParent = typeof data?.parent === 'string' ? data.parent : ''
    state.workspaceTruncated = Boolean(data?.truncated)
  } catch (error) {
    if (seq !== state.workspaceBrowseSeq) return
    state.workspaceEntries = []
    state.workspaceTruncated = false
    const message = methodError(error)
    state.workspaceBrowseError = String(message).includes('不支持该操作')
      ? '电脑端版本较旧，暂时不能浏览子文件夹。升级后可选任意层级，也可以直接新建。'
      : message
  } finally {
    if (seq === state.workspaceBrowseSeq) {
      state.workspaceBrowseBusy = false
      render()
    }
  }
}

async function openWorkspaceFromSheet() {
  if (!state.client?.connected || state.workspaceBusy || state.workspaceBrowseBusy) return
  const root = selectedWorkspaceRoot()
  if (!root) return
  state.workspaceBusy = true
  render()
  try {
    const workspace = await state.client.request('workspaces.open', {
      root,
      path: state.workspacePath,
    })
    if (!workspace?.path) throw new Error('电脑端没有返回工作区路径')
    await createSession(workspace.path)
  } catch (error) {
    showToast(methodError(error), 'error')
  } finally {
    state.workspaceBusy = false
  }
}

/**
 * Drop a workspace from the shared list. The folder and its sessions stay on
 * the server's disk; this only stops the workspace from appearing everywhere.
 */
async function removeWorkspaceFromSheet(path) {
  if (!state.client?.connected || !path || state.workspaceBusy) return
  if (!window.confirm(`从列表移除工作区？\n${path}\n\n文件夹与已保存的会话不会被删除。`)) return
  state.workspaceBusy = true
  render()
  try {
    await state.client.request('workspaces.remove', { workspacePath: path })
    showToast('已从列表移除。')
    await loadWorkspaces()
  } catch (error) {
    showToast(methodError(error), 'error')
  } finally {
    state.workspaceBusy = false
    render()
  }
}

/**
 * Drive the host's updater. The host may answer with a state snapshot, and it
 * also streams `update.changed`, so a long download keeps reporting progress.
 */
async function runUpdateAction(method) {
  if (!state.client?.connected) return
  try {
    const result = await state.client.request(method)
    if (result?.state) state.update = result.state
    if (method === 'update.install') {
      showToast('已安装更新。重启 pilot serve 后新版本生效。', 'warn')
    }
    if (state.route === 'settings') render()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

/** Refresh only the workspace lists, without touching the session list. */
async function loadWorkspaces() {
  if (!state.client?.connected) return
  try {
    const data = await state.client.request('workspaces.list')
    state.workspaces = Array.isArray(data.workspaces) ? data.workspaces : []
    state.workspaceRoots = Array.isArray(data.roots) ? data.roots.filter(Boolean) : []
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function createWorkspaceFromSheet() {
  if (!state.client?.connected || state.workspaceBusy) return
  const root = selectedWorkspaceRoot()
  const name = String(state.workspaceDraft || '').trim()
  if (!root || !name) return
  state.workspaceBusy = true
  try {
    const workspace = await state.client.request('workspaces.create', {
      root,
      name,
      path: state.workspacePath,
    })
    state.workspaceDraft = ''
    state.sheet = null
    await createSession(workspace.path)
  } catch (error) {
    showToast(methodError(error), 'error')
  } finally {
    state.workspaceBusy = false
  }
}

async function createSession(workspacePath) {
  if (!state.client?.connected) return
  try {
    const session = await state.client.request('sessions.create', { workspacePath })
    state.sheet = null
    state.sessionId = session.id
    state.session = session
    state.plan = session.plan || null
    state.queue = []
    state.approvals = []
    state.live = null
    state.composer = ''
    state.historyIndex = -1
    state.historyDraft = ''
    state.todoDraft = ''
    state.todosOpen = false
    state.delivery = 'queue'
    state.route = 'chat'
    location.hash = `#/chat/${encodeURIComponent(session.id)}`
    state.scrollToBottom = true
    render()
    void loadSessions()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

async function openFiles(dir = '.') {
  if (!state.client?.connected || !state.session) return
  state.files = {
    open: true,
    dir,
    nodes: state.files.nodes,
    loading: true,
    error: '',
    preview: null,
  }
  state.sheet = 'files'
  render()
  try {
    const data = await state.client.request('files.list', {
      workspacePath: state.session.workspacePath,
      directory: dir,
    })
    state.files = {
      open: true,
      dir: data.directory || dir,
      nodes: data.nodes || [],
      loading: false,
      error: '',
      preview: null,
    }
    render()
  } catch (error) {
    state.files.loading = false
    state.files.error = methodError(error)
    render()
  }
}

async function previewFile(path) {
  if (!state.client?.connected || !state.session) return
  state.files.loading = true
  state.files.error = ''
  render()
  try {
    const data = await state.client.request('files.read', {
      workspacePath: state.session.workspacePath,
      file: path,
    })
    state.files.preview = { path: data.path || path, content: data.content || '' }
    state.files.loading = false
    render()
  } catch (error) {
    state.files.loading = false
    state.files.error = methodError(error)
    render()
  }
}

async function renameSession() {
  if (!state.client?.connected || !state.sessionId || !state.session) return
  state.menuOpen = false
  const title = window.prompt('重命名会话', state.session.title || '')
  if (title == null) return
  const next = title.trim()
  if (!next) return
  try {
    await state.client.request('sessions.rename', { sessionId: state.sessionId, title: next })
    state.session.title = next
    state.sessions = state.sessions.map((entry) =>
      entry.id === state.sessionId ? { ...entry, title: next } : entry,
    )
    render()
  } catch (error) {
    showToast(methodError(error), 'error')
  }
}

/* ── 浏览器直连：当场向这台电脑申请访问 ────────────────────────────────── */

/**
 * 别人把地址发给同事时，对方不用扫码：页面向同一个进程申请一份一次性接入凭据。
 *
 * 返回的结构和扫码用的一样（`validatePayload` 归一化），所以后面走完全相同的
 * 加密握手与审批通道；区别只在服务端如何定身份：
 * 回环地址直接是主机用户，其他地址要等电脑前的人选定「主机 / 客户机」。
 */
async function fetchAccessGrant(role) {
  const params = new URLSearchParams()
  if (role) params.set('role', role)
  const query = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`/access${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const type = String(response.headers.get('content-type') || '')
  // 手机上装着同一份页面的 H5 站点没有这个端点：拿到 HTML 就说明当前地址
  // 不是 `pilot serve` 直接提供的，退回「扫码 / 粘贴配对链接」。
  if (!type.includes('application/json')) throw new Error('not-served')
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const reason = body && typeof body.error === 'string' ? body.error : ''
    throw new Error(reason === 'local_only' ? '请在这台电脑上打开这个页面' : `电脑拒绝了这次申请（${response.status}）`)
  }
  if (!body || body.ok !== true) throw new Error('电脑没有返回接入凭据')
  const local = body.local === true
  const requestedRole = body.requestedRole === 'host' ? 'host' : 'client'
  if (body.dry === true) return { payload: null, local, requestedRole }
  if (!body.payload) throw new Error('电脑没有返回接入凭据')
  return {
    payload: validatePayload(body.payload),
    local,
    requestedRole,
  }
}

async function beginAccess() {
  state.access.status = 'checking'
  state.access.error = ''
  render()
  let probe
  try {
    probe = await fetchAccessGrant('')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.access.status = message === 'not-served' ? 'unavailable' : 'error'
    state.access.error = message === 'not-served' ? '' : message
    render()
    return
  }
  if (!probe.local) {
    // 远端页面：先让使用者选定身份，再带着期望值去申请（审批页可改成另一种）。
    state.access.local = false
    state.access.requestedRole = probe.requestedRole
    state.access.status = 'choose'
    render()
    return
  }
  // 本机浏览器：服务端会直接放行，就是坐在电脑前的人，不必再多一步点击。
  state.access.local = true
  state.access.requestedRole = 'host'
  state.access.status = 'idle'
  await chooseAccessRole('host', { probe: true })
}

/** 页面选定身份后正式申请：期望值会带进审批页作默认选项。 */
async function chooseAccessRole(role, options) {
  if (state.access.busy) return
  state.access.busy = true
  state.access.error = ''
  state.access.requestedRole = role
  render()
  let grant
  try {
    grant = await fetchAccessGrant(role)
    if (!grant.payload) throw new Error('电脑没有返回接入凭据')
  } catch (error) {
    state.access.busy = false
    state.access.status = 'error'
    state.access.error = error instanceof Error ? error.message : String(error)
    render()
    return
  }
  state.access.local = grant.local
  state.access.requestedRole = grant.requestedRole
  state.access.status = 'idle'
  state.access.busy = false
  await startPairing(
    grant.payload,
    options?.probe ? '正在连接…' : role === 'host' ? '正在申请主机权限…' : '正在申请访问…',
  )
}

async function startPairing(payload, busyLabel) {
  if (!payload) return
  state.fatal = ''
  state.pairing = null
  state.route = 'pair'
  state.pendingPayload = payload
  render()
  setPairBusy(true, busyLabel)
  try {
    const pairing = await joinPairing(payload)
    savePairing(pairing)
    state.pairing = pairing
    state.pendingPayload = null
    state.manualEntry = false
    state.manualPair = ''
    state.fatal = ''
    state.access.status = 'idle'
    state.access.error = ''
    history.replaceState(null, '', `${location.pathname}${location.search}`)
    state.route = 'sessions'
    connectClient()
    render()
    showToast(`已连接到 ${pairing.deviceName}。`)
  } catch (error) {
    state.fatal = methodError(error)
    state.pairing = loadPairing()
    render()
  } finally {
    setPairBusy(false)
  }
}

function setPairBusy(busy, label) {
  const button = document.getElementById('pair-button')
  if (!button) return
  button.disabled = busy
  if (busy) button.innerHTML = `<span class="spinner small"></span>${label || '正在配对…'}`
}

function readManualPayload() {
  const input = document.getElementById('manual-pair-input')
  if (input) state.manualPair = input.value
  try {
    return payloadFromText(state.manualPair)
  } catch (error) {
    state.fatal = methodError(error)
    render()
    return null
  }
}

/* ── Routing / connection ──────────────────────────────────────────────── */

function parseRoute() {
  const hash = String(location.hash || '')
  if (hash.startsWith('#/chat/')) {
    const id = decodeURIComponent(hash.slice(7))
    if (id) return { name: 'chat', id }
  }
  if (hash === '#/settings') return { name: 'settings' }
  return { name: 'sessions' }
}

function connectClient() {
  if (!state.pairing) return
  state.client?.stop()
  state.client = new RelayClient(state.pairing, {
    onState({ state: connection, message }) {
      state.connection = connection
      state.connectionMessage = message || ''
      if (state.route === 'settings' || state.route === 'sessions') {
        render()
      } else if (state.route === 'chat') {
        const pill = document.querySelector('.conn-pill')
        if (pill) {
          pill.className = `conn-pill ${connection}`
          pill.innerHTML = `<i class="dot"></i>${connectionLabel()}`
        }
        const bar = document.querySelector('.disconnected-bar')
        if (bar && connection === 'connected') bar.remove()
        else if (bar) {
          const text = bar.querySelector('span')
          if (text) text.textContent = state.connectionMessage || '与电脑的连接已断开'
        } else if (connection !== 'connecting') {
          const slot = document.querySelector('.composer-inner')
          if (slot) slot.insertAdjacentHTML('afterbegin', disconnectedBar())
        }
      }
    },
    onReady() {
      void (async () => {
        try {
          state.deviceInfo = await state.client.request('device.info')
        } catch {
          // Best-effort metadata.
        }
        if (state.route === 'sessions') void loadSessions()
        else if (state.route === 'chat' && state.sessionId) {
          state.live = null
          void loadSession(state.sessionId, { silent: true, scroll: false })
        }
        if (state.route === 'settings') render()
      })()
    },
    onEvent(event) {
      handleAgentEvent(event)
    },
    onFatal({ message }) {
      state.fatal = message
      state.connection = 'error'
      state.connectionMessage = message
      if (state.route !== 'pair') {
        render()
        showToast(message, 'error')
      }
    },
  })
  state.client.connect()
}

async function boot() {
  applyTheme()
  const payload = extractPairingHash()
  if (payload) {
    state.pendingPayload = payload
    state.manualEntry = false
    state.route = 'pair'
    render()
    return
  }
  const route = parseRoute()
  if (!state.pairing) {
    state.route = 'pair'
    // 直接打开这台电脑的服务地址：先当场申请访问。本机（回环）由服务端直接
    // 放行并作为主机用户进入；其他机器进「主机 / 客户机」选择页。手机上的
    // H5 站点没有这个端点，beginAccess 会判定 not-served 并回到扫码页。
    if (/^https?:$/.test(location.protocol)) {
      void beginAccess()
      return
    }
    render()
    return
  }
  state.route = route.name
  if (route.name === 'chat') state.sessionId = route.id
  const cached = readCache()
  if (cached) {
    state.sessions = Array.isArray(cached.sessions) ? cached.sessions : []
    state.workspaces = Array.isArray(cached.workspaces) ? cached.workspaces : []
    state.deviceInfo = cached.deviceInfo || null
    if (route.name === 'chat' && route.id) applyCachedSession(route.id)
  }
  connectClient()
  render()
  if (route.name === 'chat') {
    if (!state.session) state.scrollToBottom = true
    void loadSession(route.id)
  } else if (route.name === 'sessions') {
    void loadSessions()
  }
}

function navigate(route) {
  if (route.name === 'sessions') {
    state.route = 'sessions'
    state.menuOpen = false
    state.sheet = null
    if (location.hash !== '#/sessions') history.pushState(null, '', '#/sessions')
    render()
    void loadSessions()
    return
  }
  if (route.name === 'settings') {
    state.route = 'settings'
    state.menuOpen = false
    state.sheet = null
    if (location.hash !== '#/settings') history.pushState(null, '', '#/settings')
    render()
    // Sandbox and tool state is only meaningful from the host, so it is read
    // when the page opens instead of on every render.
    void loadRuntime()
    // 余额取电脑端缓存，首次进入顺带取一次，不强制刷新模型服务。
    if (!state.billing.report && !state.billing.loading) void loadBilling(false)
    return
  }
  if (route.name === 'chat' && route.id) {
    state.route = 'chat'
    state.sessionId = route.id
    state.session = null
    state.plan = null
    state.queue = []
    state.approvals = []
    state.live = null
    state.running = false
    state.loadError = ''
    state.menuOpen = false
    state.sheet = null
    state.historyIndex = -1
    state.historyDraft = ''
    state.todoDraft = ''
    state.todosOpen = false
    state.artifacts = { loading: false, items: [], error: '', preview: null }
    state.scrollToBottom = true
    if (location.hash !== `#/chat/${encodeURIComponent(route.id)}`) {
      history.pushState(null, '', `#/chat/${encodeURIComponent(route.id)}`)
    }
    render()
    // `after` 让快捷入口等到会话本体（含工作区路径）就绪后再拉资源。
    void loadSession(route.id).then(() => {
      if (typeof route.after === 'function' && state.sessionId === route.id && state.route === 'chat') {
        route.after()
      }
    })
  }
}

/* ── DOM events ────────────────────────────────────────────────────────── */

document.addEventListener('click', (event) => {
  const stopZone = event.target.closest('[data-stop="true"]')
  const target = event.target.closest('[data-action]')
  if (!target) {
    if (state.menuOpen) {
      state.menuOpen = false
      render()
    }
    return
  }
  if (stopZone && !target.closest('[data-stop="true"]')) return
  const action = target.dataset.action
  if (!action) return
  switch (action) {
    case 'open-session':
      if (target.dataset.id) navigate({ name: 'chat', id: target.dataset.id })
      return
    case 'back-sessions':
      navigate({ name: 'sessions' })
      return
    case 'open-settings':
      navigate({ name: 'settings' })
      return
    case 'retry-connect':
      state.client?.reconnect()
      showToast('正在重新连接…')
      return
    case 'refresh-runtime':
      void loadRuntime()
      return
    case 'refresh-billing':
      void loadBilling(true)
      return
    case 'update-check':
      void runUpdateAction('update.check')
      return
    case 'update-download':
      void runUpdateAction('update.download')
      return
    case 'update-install':
      void runUpdateAction('update.install')
      return
    case 'retry-sessions':
      state.sessionsError = ''
      void loadSessions()
      return
    case 'toggle-running-filter':
      state.runningOnly = !state.runningOnly
      render()
      return
    case 'new-session':
      if (state.workspaces.length === 1) {
        void createSession(state.workspaces[0].path)
      } else if (state.workspaces.length === 0) {
        if (state.workspaceRoots.length > 0) {
          openWorkspaceSheet()
        } else {
          showToast('电脑上还没有打开工作区。', 'warn')
        }
      } else {
        openWorkspaceSheet()
      }
      return
    case 'create-workspace':
      void createWorkspaceFromSheet()
      return
    case 'open-workspace':
      void openWorkspaceFromSheet()
      return
    case 'remove-workspace':
      void removeWorkspaceFromSheet(target.dataset.path)
      return
    case 'workspace-enter':
      if (target.dataset.path) void browseWorkspace(target.dataset.path)
      return
    case 'workspace-up':
      void browseWorkspace(state.workspaceParent)
      return
    case 'select-workspace':
      if (target.dataset.path) void createSession(target.dataset.path)
      return
    case 'close-sheet':
      state.sheet = null
      if (state.files.open) state.files.open = false
      render()
      return
    case 'toggle-menu':
      state.menuOpen = !state.menuOpen
      render()
      return
    case 'close-menu':
      state.menuOpen = false
      render()
      return
    case 'rename-session':
      void renameSession()
      return
    case 'copy-transcript':
      void copyTranscript()
      return
    case 'fork-session':
      void forkSession()
      return
    case 'retry-run':
      void retryRun()
      return
    case 'delete-session':
      void deleteSession()
      return
    case 'open-artifacts':
      void openArtifacts()
      return
    case 'artifact-open':
      if (target.dataset.path) void previewArtifact(target.dataset.path)
      return
    case 'artifact-back':
      state.artifacts.preview = null
      render()
      return
    case 'open-session-resources':
      openSessionResources(target.dataset.id, target.dataset.tab)
      return
    case 'resource-file-open':
      if (target.dataset.path) void previewResourceFile(target.dataset.path)
      return
    case 'resource-file-back':
      state.resources.preview = null
      render()
      return
    case 'download-file':
      downloadPreviewFile(target.dataset.scope || 'resources')
      return
    case 'open-files':
      state.menuOpen = false
      void openFiles('.')
      return
    case 'open-schedules':
      void openSchedules()
      return
    case 'open-learning':
      void openLearning()
      return
    case 'open-check':
      void openCheck()
      return
    case 'open-evolution':
      void openEvolution()
      return
    case 'evolution-workspace':
      selectEvolutionWorkspace(target.dataset.path || '')
      return
    case 'evolution-auto':
      toggleAutoEvolve()
      return
    case 'evolution-do':
      void runEvolutionAction(target.dataset.op || '', {
        ...(target.dataset.id ? { profileId: target.dataset.id } : {}),
      })
      return
    case 'toggle-module-check':
      void toggleModuleCheck()
      return
    case 'run-module-check':
      void runModuleCheck()
      return
    case 'run-self-check':
      void runSelfCheck()
      return
    case 'toggle-risk':
      toggleRisk(target.dataset.key || '')
      return
    case 'toggle-learning':
      toggleLearning()
      return
    case 'save-learning-hosts':
      saveLearningHosts()
      return
    case 'fill-learning-hosts':
      fillDefaultLearningHosts()
      return
    case 'open-checkpoints':
      void openCheckpoints()
      return
    case 'load-checkpoints':
      void loadCheckpoints()
      return
    case 'create-checkpoint':
      void createCheckpoint()
      return
    case 'restore-checkpoint':
      void restoreCheckpoint(target.dataset.id, target.dataset.mode)
      return
    case 'open-changes':
      void openChanges()
      return
    case 'load-changes':
      void loadChanges()
      return
    case 'toggle-change': {
      const key = target.dataset.key || ''
      if (key) {
        state.changes.expanded[key] = !state.changes.expanded[key]
        render()
      }
      return
    }
    case 'revert-change':
      void revertChange(target.dataset.path)
      return
    case 'open-resources':
      void openResources('links')
      return
    case 'resource-tab':
      if (target.dataset.tab) void loadResourceTab(target.dataset.tab)
      return
    case 'open-models':
      void openModels()
      return
    case 'set-approval-mode':
      void setApprovalMode(target.dataset.mode)
      return
    case 'set-session-model':
      void setSessionModel(target.dataset.model || '')
      return
    case 'use-quick-command':
      useQuickCommand(Number(target.dataset.index))
      return
    case 'schedule-add':
      void addSchedule()
      return
    case 'schedule-toggle':
      if (target.dataset.id) void toggleSchedule(target.dataset.id)
      return
    case 'schedule-remove':
      if (target.dataset.id) void removeSchedule(target.dataset.id)
      return
    case 'load-earlier':
      void loadEarlier()
      return
    case 'file-dir':
      if (target.dataset.path) void openFiles(target.dataset.path)
      return
    case 'file-open':
      if (target.dataset.path) void previewFile(target.dataset.path)
      return
    case 'file-back':
      state.files.preview = null
      render()
      return
    case 'copy-message': {
      const id = target.dataset.id
      const message = state.session?.messages?.find((entry) => entry.id === id)
      if (message) {
        void copyText(message.content || '').then((ok) => {
          showToast(ok ? '已复制消息。' : '复制失败，请手动选择文本。', ok ? 'info' : 'error')
        })
      }
      return
    }
    case 'toggle-process':
      state.expandedProcess = !state.expandedProcess
      renderSlots()
      return
    case 'toggle-process-item': {
      const kind = target.dataset.kind
      const id = target.dataset.id
      if (kind === 'reasoning') {
        state.expandedReasoning.reasoning = !state.expandedReasoning.reasoning
      } else if (id) {
        state.expandedItems[id] = !state.expandedItems[id]
      }
      renderSlots()
      return
    }
    case 'queue-remove':
      if (target.dataset.id) void removeQueue(target.dataset.id)
      return
    case 'queue-insert':
      if (target.dataset.id) void insertQueue(target.dataset.id)
      return
    case 'approval-allow':
      if (target.dataset.call) void decideApproval(target.dataset.call, true)
      return
    case 'approval-deny':
      if (target.dataset.call) void decideApproval(target.dataset.call, false)
      return
    case 'approval-always':
      if (target.dataset.call) void decideApproval(target.dataset.call, true, true)
      return
    case 'pause-run':
      void pauseRun()
      return
    case 'resume-run':
      void resumeRun()
      return
    case 'stop-run':
      void stopRun()
      return
    case 'toggle-todos':
      state.todosOpen = !state.todosOpen
      renderSlots()
      return
    case 'todo-send':
      if (target.dataset.id) void sendTodo(target.dataset.id)
      return
    case 'todo-edit':
      if (target.dataset.id) void updateTodo(target.dataset.id)
      return
    case 'todo-remove':
      if (target.dataset.id) void removeTodo(target.dataset.id)
      return
    case 'todo-send-all':
      void sendAllTodos()
      return
    case 'todo-clear-sent':
      void clearSentTodos()
      return
    case 'send':
      event.preventDefault()
      void sendMessage()
      return
    case 'toggle-delivery':
      state.delivery = state.delivery === 'insert' ? 'queue' : 'insert'
      target.className = `delivery-toggle${state.delivery === 'insert' ? ' insert' : ''}`
      target.innerHTML = `${icon(state.delivery === 'insert' ? 'insert' : 'clock', 11)}${
        state.delivery === 'insert' ? '插入当前任务' : '排队'
      }`
      return
    case 'set-theme':
      if (target.dataset.theme) setTheme(target.dataset.theme)
      return
    case 'unpair':
      if (window.confirm('解除这台手机的配对？之后需要重新扫描电脑上的二维码。')) {
        state.client?.stop()
        state.client = null
        clearPairing()
        clearOfflineCache()
        state.pairing = null
        state.hasMore = false
        state.offline = false
        state.cachedSession = null
        state.schedules = {
          loading: false,
          items: [],
          error: '',
          content: '',
          kind: 'once',
          delay: '10',
          interval: '60',
          time: '09:00',
          busy: false,
        }
        state.pendingPayload = null
        state.manualEntry = false
        state.session = null
        state.sessionId = null
        state.sessions = []
        state.route = 'pair'
        state.fatal = ''
        history.replaceState(null, '', `${location.pathname}${location.search}`)
        render()
      }
      return
    case 'confirm-pair': {
      if (!state.pendingPayload) return
      void startPairing(state.pendingPayload)
      return
    }
    case 'access-host':
      void chooseAccessRole('host')
      return
    case 'access-client':
      void chooseAccessRole('client')
      return
    case 'access-skip':
      // 显式放弃自助接入，回到扫码 / 粘贴配对链接。
      state.access.status = 'unavailable'
      state.manualEntry = false
      state.fatal = ''
      render()
      return
    case 'manual-pair': {
      const payload = readManualPayload()
      if (payload) void startPairing(payload)
      return
    }
    case 'manual-pair-cancel':
      state.pendingPayload = null
      state.manualEntry = false
      state.fatal = ''
      history.replaceState(null, '', `${location.pathname}${location.search}`)
      render()
      return
    case 'continue-paired':
      state.manualEntry = false
      state.route = 'sessions'
      connectClient()
      navigate({ name: 'sessions' })
      return
    case 'show-manual-pair':
      state.pendingPayload = null
      state.manualEntry = true
      state.fatal = ''
      render()
      return
    case 'cancel-manual-pair':
      state.manualEntry = false
      state.fatal = ''
      render()
      return
    default:
      return
  }
})

document.addEventListener('submit', (event) => {
  if (event.target?.id === 'composer') {
    event.preventDefault()
    void sendMessage()
    return
  }
  if (event.target?.id === 'todo-form') {
    event.preventDefault()
    void addTodo()
    return
  }
  if (event.target?.dataset?.scheduleForm === 'true') {
    event.preventDefault()
    void addSchedule()
  }
})

document.addEventListener('input', (event) => {
  const target = event.target
  if (target?.id === 'composer-input') {
    state.composer = target.value
    state.historyIndex = -1
    resizeComposer(target)
    updateSendAvailability()
    return
  }
  if (target?.id === 'session-search') {
    state.search = target.value
    renderSessionListOnly()
    return
  }
  if (target?.id === 'workspace-name-input') {
    state.workspaceDraft = target.value
    const button = document.querySelector('[data-action="create-workspace"]')
    if (button) button.disabled = !state.workspaceDraft.trim()
    return
  }
  if (target?.id === 'todo-input') {
    state.todoDraft = target.value
    const button = document.getElementById('todo-submit')
    if (button) button.disabled = !state.todoDraft.trim()
    return
  }
  if (target?.id === 'manual-pair-input') {
    state.manualPair = target.value
    return
  }
  if (target?.id === 'learning-hosts') {
    state.learning.hostsDraft = target.value
    return
  }
  if (target?.id === 'schedule-content') {
    state.schedules.content = target.value
    return
  }
  if (target?.id === 'schedule-delay') {
    state.schedules.delay = target.value
    return
  }
  if (target?.id === 'schedule-interval') {
    state.schedules.interval = target.value
    return
  }
  if (target?.id === 'schedule-time') {
    state.schedules.time = target.value
  }
})

document.addEventListener('change', (event) => {
  const target = event.target
  if (target?.id === 'workspace-root') {
    state.workspaceRoot = target.value
    resetWorkspaceBrowser()
    void browseWorkspace('')
    return
  }
  if (target?.id !== 'schedule-kind') return
  const value = target.value
  state.schedules.kind = value === 'interval' || value === 'daily' ? value : 'once'
  state.schedules.error = ''
  render()
})

document.addEventListener('keydown', (event) => {
  if (event.target?.id !== 'composer-input') return
  if (event.key === 'Enter' && !event.shiftKey) {
    if (event.isComposing) return
    event.preventDefault()
    void sendMessage()
    return
  }
  if (
    (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
    event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing
  ) {
    return
  }
  const history = readInputHistory()
  if (history.length === 0) return
  const input = event.target
  if (event.key === 'ArrowUp') {
    if (input.selectionStart !== 0 || input.selectionEnd !== 0) return
    event.preventDefault()
    if (state.historyIndex < 0) state.historyDraft = state.composer
    state.historyIndex = Math.min(state.historyIndex + 1, history.length - 1)
    state.composer = history[state.historyIndex] || ''
  } else {
    if (state.historyIndex < 0) return
    event.preventDefault()
    state.historyIndex -= 1
    state.composer =
      state.historyIndex < 0 ? state.historyDraft : history[state.historyIndex] || ''
  }
  input.value = state.composer
  resizeComposer(input)
  updateSendAvailability()
})

let lastHandledHref = ''
let lastHandledAt = 0

function handleLocation() {
  const href = location.href
  if (href === lastHandledHref && Date.now() - lastHandledAt < 200) return
  lastHandledHref = href
  lastHandledAt = Date.now()
  const payload = extractPairingHash()
  if (payload) {
    state.pendingPayload = payload
    state.manualEntry = false
    state.route = 'pair'
    render()
    return
  }
  if (!state.pairing) return
  const route = parseRoute()
  if (route.name === 'chat' && route.id) {
    navigate({ name: 'chat', id: route.id })
  } else if (route.name === 'settings') {
    navigate({ name: 'settings' })
  } else {
    navigate({ name: 'sessions' })
  }
}

window.addEventListener('hashchange', handleLocation)
window.addEventListener('popstate', handleLocation)

/* ── Service worker ────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // The app remains fully usable without offline caching.
  })
}

setInterval(updateApprovalCountdowns, 1000)

boot()
