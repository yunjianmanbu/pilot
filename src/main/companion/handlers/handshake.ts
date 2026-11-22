// 配对握手与加密通道：pair.join、hello/challenge/proof、会话接管，以及加密帧的收发。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import { WebSocket } from 'ws'
import {
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  fromBase64url,
  hashToken,
  randomSecret,
  randomToken,
  safeEqualHex,
  safeEqualText,
  tokenProof,
} from '../crypto'
import {
  CHALLENGE_TTL_MS,
  ID_RE,
  LOOKUP_RE,
  PAIRING_MAX_ATTEMPTS,
  PAIR_EXPIRY_MS,
  PROTOCOL_VERSION,
  PUBLIC_KEY_RE,
} from '../constants'
import { asRecord, cleanText, nowIso, seal, unseal } from '../helpers'
import type { ClientConnection, StoredPhone } from '../types'
import type { CompanionServer } from '../server'

export async function handlePairJoin(
  host: CompanionServer,
  connection: ClientConnection,
  frame: Record<string, unknown>,
): Promise<void> {
  connection.pairAttempts += 1
  if (connection.pairAttempts > PAIRING_MAX_ATTEMPTS) {
    connection.socket.close(4008, 'too many attempts')
    return
  }
  const lookup = frame['lookup']
  const phoneId = frame['phoneId']
  const name = cleanText(frame['name'], '手机', 80)
  const phonePub = frame['phonePub']
  if (typeof lookup !== 'string' || !LOOKUP_RE.test(lookup)) {
    host.sendRaw(connection.socket, { type: 'pair.rejected', reason: '配对二维码已失效' })
    return
  }
  if (typeof phoneId !== 'string' || !ID_RE.test(phoneId)) {
    host.sendRaw(connection.socket, { type: 'pair.rejected', reason: '手机标识不正确' })
    return
  }
  if (typeof phonePub !== 'string' || !PUBLIC_KEY_RE.test(phonePub)) {
    host.sendRaw(connection.socket, { type: 'pair.rejected', reason: '手机公钥不正确' })
    return
  }
  const offer = host.activeOffer()
  if (!offer || offer.lookup !== lookup) {
    host.sendRaw(connection.socket, {
      type: 'pair.rejected',
      reason: '配对二维码已失效，请在电脑上重新生成',
    })
    return
  }
  const platform = cleanText(frame['platform'], 'mobile', 40)
  let keys
  try {
    keys = derivePairKeys(offer.keys.privateKey, phonePub, offer.secret)
  } catch {
    host.sendRaw(connection.socket, { type: 'pair.rejected', reason: '配对密钥不正确' })
    return
  }
  // 普通配对二维码只发起请求，必须等电脑前的人确认；换机二维码由已配对
  // 手机经认证通道申请，扫码本身已经证明持有一次性密钥，直接放行。
  // 两条路径都受 TTL 和「一次使用后清空 offer」约束。
  if (!offer.autoApprove) {
    const busy = Boolean(host.pendingPair)
    if (!busy) host.sendRaw(connection.socket, { type: 'pair.pending' })
    const decision = await host.requestPairApproval(connection, { phoneId, name, platform })
    if (!decision.approved) {
      host.sendRaw(connection.socket, {
        type: 'pair.rejected',
        reason: decision.reason ?? '电脑端拒绝了本次配对',
      })
      return
    }
  }
  // The answer can arrive after the QR code was replaced or the socket died.
  if (host.activeOffer() !== offer) {
    host.sendRaw(connection.socket, {
      type: 'pair.rejected',
      reason: '配对二维码已失效，请在电脑上重新生成',
    })
    return
  }
  if (connection.socket.readyState !== WebSocket.OPEN) return
  const token = randomToken()
  const pairedAt = nowIso()
  const protocol = frame['protocol'] === 2 ? 2 : 1
  const relayUrl = host.relayUrl()
  const relayEnabled = Boolean(relayUrl)
  host.state.phones[phoneId] = {
    phoneId,
    name,
    platform,
    tokenHash: hashToken(token),
    tokenSealed: seal(token),
    pcToPhone: seal(keys.pcToPhone.toString('base64url')),
    phoneToPc: seal(keys.phoneToPc.toString('base64url')),
    outSeq: 1,
    inSeq: 0,
    pairedAt,
    lastSeen: pairedAt,
    ...(relayEnabled
      ? { relayRoom: offer.room, relayKey: offer.roomKey, relayUrl }
      : {}),
  }
  host.clearOffer()
  await host.saveNow()
  const confirmationValue: Record<string, unknown> = {
    type: 'pair.accept',
    deviceId: host.state.deviceId,
    deviceName: host.options.deviceName,
  }
  // New clients receive the pairing token inside the E2E-encrypted payload,
  // so the cloud connector never sees the credential. Legacy clients still
  // need it in the clear and are supported during migration.
  if (protocol >= 2) confirmationValue['token'] = token
  const confirmation = encryptPayload(keys.pcToPhone, confirmationValue, 1)
  const accepted: Record<string, unknown> = {
    type: 'pair.accepted',
    payload: confirmation,
    protocol,
  }
  if (protocol < 2) accepted['token'] = token
  host.sendRaw(connection.socket, accepted)
  host.emitStatus()
}

export async function handleHello(
  host: CompanionServer,
  connection: ClientConnection,
  frame: Record<string, unknown>,
): Promise<void> {
  if (connection.authed) return
  if (frame['role'] !== 'phone') {
    host.sendError(connection, 'auth_failed', '配对身份不正确')
    return
  }
  if (frame['deviceId'] !== host.state.deviceId) {
    host.sendError(connection, 'auth_failed', '电脑身份不一致，请重新扫码配对')
    return
  }
  const phoneId = frame['phoneId']
  if (typeof phoneId !== 'string' || !ID_RE.test(phoneId)) {
    host.sendError(connection, 'auth_failed', '配对信息不完整')
    return
  }
  const phone = host.state.phones[phoneId]
  if (!phone) {
    host.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
    return
  }
  const protocol = frame['protocol'] === 2 ? 2 : 1
  if (protocol >= 2) {
    // A challenge keeps the token out of the cloud relay entirely.
    if (!phone.tokenSealed) {
      host.sendRaw(connection.socket, { type: 'hello.legacy' })
      return
    }
    const challenge = randomSecret(24)
    connection.pendingPhoneId = phoneId
    connection.challenge = challenge
    connection.challengeAt = Date.now()
    connection.protocol = 2
    host.sendRaw(connection.socket, { type: 'hello.challenge', challenge, protocol: 2 })
    return
  }

  // Legacy path for phones paired before protocol 2. The token is accepted
  // once, then sealed so subsequent reconnects can use the challenge flow.
  const token = frame['token']
  if (typeof token !== 'string' || !safeEqualHex(phone.tokenHash, hashToken(token))) {
    host.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
    return
  }
  if (!phone.tokenSealed) phone.tokenSealed = seal(token)
  await host.completeHello(connection, phone, phoneId)
}

export async function handleHelloProof(
  host: CompanionServer,
  connection: ClientConnection,
  frame: Record<string, unknown>,
): Promise<void> {
  if (connection.authed) return
  if (
    connection.protocol !== 2 ||
    !connection.challenge ||
    !connection.challengeAt ||
    Date.now() - connection.challengeAt > CHALLENGE_TTL_MS
  ) {
    connection.challenge = undefined
    connection.challengeAt = undefined
    host.sendError(connection, 'auth_failed', '配对验证已过期，请重新连接')
    return
  }
  const phoneId = frame['phoneId']
  const proof = frame['proof']
  if (
    typeof phoneId !== 'string' ||
    phoneId !== connection.pendingPhoneId ||
    typeof proof !== 'string'
  ) {
    connection.challenge = undefined
    connection.challengeAt = undefined
    host.sendError(connection, 'auth_failed', '配对验证不完整')
    return
  }
  const phone = host.state.phones[phoneId]
  if (!phone?.tokenSealed) {
    connection.challenge = undefined
    connection.challengeAt = undefined
    host.sendError(connection, 'auth_failed', '配对已失效，请在电脑上重新生成二维码')
    return
  }
  let token: string
  try {
    token = unseal(phone.tokenSealed)
  } catch {
    connection.challenge = undefined
    connection.challengeAt = undefined
    host.sendError(connection, 'auth_failed', '配对凭证无法读取，请重新扫码')
    return
  }
  const expected = tokenProof(token, connection.challenge)
  connection.challenge = undefined
  connection.challengeAt = undefined
  if (!safeEqualText(proof, expected)) {
    host.sendError(connection, 'auth_failed', '配对验证失败，请重新扫码')
    return
  }
  await host.completeHello(connection, phone, phoneId)
}

export async function completeHello(
  host: CompanionServer,
  connection: ClientConnection,
  phone: StoredPhone,
  phoneId: string,
): Promise<void> {
  const lastActive = phone.lastSeen ?? phone.pairedAt
  if (Date.now() - new Date(lastActive).getTime() > PAIR_EXPIRY_MS) {
    delete host.state.phones[phoneId]
    await host.saveNow()
    host.sendRaw(connection.socket, {
      type: 'error',
      code: 'pair_expired',
      message: '已超过 7 天未使用，请在电脑上重新生成配对二维码',
    })
    connection.socket.close(4003, 'expired')
    return
  }
  const previous = host.byPhone.get(phoneId)
  if (previous && previous !== connection) {
    host.sendError(previous, 'replaced', '这个配对正在另一处使用')
    try {
      previous.socket.close(4001, 'replaced')
    } catch {
      // ignore
    }
  }
  connection.authed = true
  connection.phoneId = phoneId
  connection.pendingPhoneId = undefined
  connection.challenge = undefined
  connection.challengeAt = undefined
  host.byPhone.set(phoneId, connection)
  host.phoneSockets.add(phoneId)
  phone.lastSeen = nowIso()
  host.blankSave()
  host.sendRaw(connection.socket, {
    type: 'welcome',
    deviceId: host.state.deviceId,
    phoneId,
    deviceName: host.options.deviceName,
    protocolVersion: PROTOCOL_VERSION,
    // Current direct endpoints, so a phone connected through the relay can
    // upgrade to LAN when it is on the same network (and refresh stale IPs).
    lan: host.lanUrls(),
  })
  host.emitStatus()
}

export function phoneKey(
  host: CompanionServer,
  phone: StoredPhone,
  direction: 'pcToPhone' | 'phoneToPc',
): Buffer {
  const sealed = direction === 'pcToPhone' ? phone.pcToPhone : phone.phoneToPc
  const value = unseal(sealed)
  const key = fromBase64url(value, '加密密钥')
  if (key.length !== 32) throw new Error('加密密钥长度不正确')
  return key
}

export async function handleEncrypted(
  host: CompanionServer,
  phoneId: string,
  payload: unknown,
): Promise<void> {
  const phone = host.state.phones[phoneId]
  if (!phone) return
  let decoded: { seq: number; value: unknown }
  try {
    decoded = decryptPayload(host.phoneKey(phone, 'phoneToPc'), payload)
  } catch {
    return
  }
  if (decoded.seq <= phone.inSeq) return
  phone.inSeq = decoded.seq
  phone.lastSeen = nowIso()
  host.blankSave()
  const value = asRecord(decoded.value)
  if (value['type'] === 'ping') {
    await host.sendEncrypted(phoneId, { type: 'pong', t: Date.now() })
    return
  }
  if (value['type'] !== 'request') return
  const id = typeof value['id'] === 'string' ? value['id'].slice(0, 80) : ''
  if (!id) return
  const method = typeof value['method'] === 'string' ? value['method'] : ''
  const params = asRecord(value['params'])
  try {
    const data = await host.handleRequest(method, params, phone)
    await host.sendEncrypted(phoneId, { type: 'response', id, ok: true, data })
  } catch (error) {
    await host.sendEncrypted(phoneId, {
      type: 'response',
      id,
      ok: false,
      error: String(error instanceof Error ? error.message : error).slice(0, 4_000),
    })
  }
}

export async function sendEncrypted(
  host: CompanionServer,
  phoneId: string,
  value: unknown,
): Promise<void> {
  const phone = host.state.phones[phoneId]
  const connection = host.byPhone.get(phoneId)
  if (!phone || !connection || connection.socket.readyState !== WebSocket.OPEN) return
  let envelope
  try {
    const next = phone.outSeq + 1
    envelope = encryptPayload(host.phoneKey(phone, 'pcToPhone'), value, next)
    phone.outSeq = next
    host.blankSave()
  } catch {
    return
  }
  host.sendRaw(connection.socket, { type: 'message', payload: envelope })
}
