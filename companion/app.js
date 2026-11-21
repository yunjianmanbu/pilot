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
      <button type="button" data-action="open-schedules">${icon('clock', 15)}定时任务</button>
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
  const manual = !pending && (!paired || state.manualEntry)
  const device = pending?.deviceName || paired?.deviceName || '电脑'
  const address = pending?.relayUrl?.replace(/^ws/, 'http')?.replace(/\/ws$/, '') || ''
  return `<div class="pair-page">
    <div class="pair-hero">
      <span class="pair-logo">${brandMark(44)}</span>
      <h1>${pending ? '连接 Pilot' : 'Pilot 手机端'}</h1>
      <p>${pending ? '确认连接后，你可以在手机上继续电脑上的任务、查看执行过程并审批工具调用。' : paired && !manual ? '已保存这台电脑的配对，可以继续使用，也可以扫描新的二维码重新配对。' : '在电脑上打开 Pilot，点击顶栏的手机图标生成二维码，然后用手机扫描；也可以粘贴电脑上复制的配对链接。'}</p>
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

function renderSessions() {
  return `<div class="sessions-page">
    ${sessionsHeader()}
    <div class="page">
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
        ${renderWorkspaceCreate()}
        ${
          state.workspaces.length === 0
            ? `<div class="empty-state"><strong>电脑上还没有打开工作区</strong><p>${
                state.workspaceRoots.length > 0
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
        <div class="approval-actions">
          <button type="button" class="deny" data-action="approval-deny" data-call="${escapeHtml(approval.callId)}">拒绝</button>
          <button type="button" data-action="approval-always" data-call="${escapeHtml(approval.callId)}" data-session="${escapeHtml(approval.sessionId)}">本会话改为全部自动</button>
          <button type="button" class="allow" data-action="approval-allow" data-call="${escapeHtml(approval.callId)}">允许</button>
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
        ${composerHtml()}
      </div>
    </div>
    ${state.sheet === 'files' ? renderFilesSheet() : ''}
    ${state.sheet === 'artifacts' ? renderArtifactsSheet() : ''}
    ${state.sheet === 'schedules' ? renderSchedulesSheet() : ''}
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
             <div class="file-preview">${escapeHtml(files.preview.content)}</div>`
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
             <div class="file-preview">${escapeHtml(artifacts.preview.content)}</div>`
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
      <form class="schedule-form" data-schedule-form="true">
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
      </form>
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
                        <button type="button" class="schedule-toggle" data-action="schedule-toggle" data-id="${escapeHtml(task.id)}"${schedules.busy === task.id ? ' disabled' : ''}>${task.enabled ? '暂停' : '启用'}</button>
                        <button type="button" class="schedule-remove" data-action="schedule-remove" data-id="${escapeHtml(task.id)}" aria-label="删除定时任务"${schedules.busy === task.id ? ' disabled' : ''}>${icon('trash', 13)}</button>
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

/* ── Rendering: settings ───────────────────────────────────────────────── */

function renderSettings() {
  const info = state.deviceInfo || {}
  const themes = [
    { id: 'dark', label: '深色', icon: 'moon' },
    { id: 'light', label: '浅色', icon: 'sun' },
  ]
  return `<div class="settings-page">
    ${settingsHeader()}
    <div class="page">
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

      <div class="page-heading" style="margin-top:24px"><div><h2>升级</h2><p>只下载有变化的文件，重启后生效</p></div></div>
      <div class="card">
        <div class="setting-row">
          <span class="setting-icon">${icon('refresh', 18)}</span>
          <div class="setting-body">
            <strong>${updateVersionLabel()}</strong>
            <span>${escapeHtml(updateDetailLabel())}</span>
          </div>
        </div>
        <div class="setting-actions">${updateActionsHtml()}</div>
      </div>

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
      <div class="danger-zone">
        <button type="button" class="button danger" data-action="unpair">${icon('trash', 15)}解除配对</button>
      </div>
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

async function startPairing(payload) {
  if (!payload) return
  state.fatal = ''
  state.pairing = null
  state.route = 'pair'
  state.pendingPayload = payload
  render()
  setPairBusy(true)
  try {
    const pairing = await joinPairing(payload)
    savePairing(pairing)
    state.pairing = pairing
    state.pendingPayload = null
    state.manualEntry = false
    state.manualPair = ''
    state.fatal = ''
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
    void loadSession(route.id)
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
    case 'open-files':
      state.menuOpen = false
      void openFiles('.')
      return
    case 'open-schedules':
      void openSchedules()
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
