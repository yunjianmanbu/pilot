// `/bridge` 的参数线上格式。
//
// 浏览器里的桌面界面和主进程之间只有 JSON：`JSON.stringify` 把 `undefined`
// 变成 `null`，而 IPC 的 `options` 位置收到 `null` 会直接抛
// `Cannot read properties of null (reading 'images')` —— 桌面端同样的调用因为
// 传的是 `undefined` 反而正常。这组用例就守这条边界。
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_BYTES_MARK,
  BRIDGE_UNDEFINED_MARK,
  decodeBridgeArgs,
  encodeBridgeArgs,
} from '../src/shared/bridge'

/** 走一遍真实的线上往返：编码 → JSON → 解析 → 解码。 */
function roundTrip(args: unknown[]): unknown[] {
  return decodeBridgeArgs(JSON.parse(JSON.stringify(encodeBridgeArgs(args))) as unknown[])
}

describe('encodeBridgeArgs / decodeBridgeArgs', () => {
  it('保留中间的 undefined，而不是让它变成 null', () => {
    const args = ['session-1', 'hello', 'queue', undefined]
    const decoded = roundTrip(args)
    expect(decoded[3]).toBeUndefined()
    expect(decoded[3]).not.toBeNull()
    expect(decoded.slice(0, 3)).toEqual(['session-1', 'hello', 'queue'])
  })

  it('中间的 undefined 在 JSON 里以哨兵对象出现', () => {
    const encoded = encodeBridgeArgs(['a', undefined, 'c'])
    expect(encoded[1]).toEqual({ [BRIDGE_UNDEFINED_MARK]: true })
    expect(JSON.parse(JSON.stringify(encoded))[1]).toEqual({ [BRIDGE_UNDEFINED_MARK]: true })
  })

  it('尾部的 undefined 直接裁掉，载荷不因可选参数变长', () => {
    expect(encodeBridgeArgs(['a', 'b', undefined, undefined])).toEqual(['a', 'b'])
    expect(roundTrip(['a', 'b', undefined, undefined])).toEqual(['a', 'b'])
  })

  it('普通值原样通过', () => {
    const args = ['s', 'text', 'queue', { images: ['data:x'] }, 0, false, null, '']
    expect(roundTrip(args)).toEqual(args)
  })

  it('真值对象里带同名键时不会被误判', () => {
    const value = { [BRIDGE_UNDEFINED_MARK]: 'yes', images: [] }
    expect(roundTrip([value])[0]).toEqual(value)
  })

  // 浏览器里「上传文件」「粘贴图片」只能传字节。JSON 把 ArrayBuffer 变成 `{}`，
  // 不做处理时主进程会收到空内容，报「没有要上传的文件」。
  it('ArrayBuffer 经过 JSON 往返后仍然是同一段字节', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 250, 255])
    const batch = { paths: [], blobs: [{ name: 'a.txt', data: bytes.buffer }] }
    const decoded = roundTrip([batch])[0] as { blobs: Array<{ data: ArrayBuffer }> }
    expect(new Uint8Array(decoded.blobs[0]!.data)).toEqual(bytes)
  })

  it('Uint8Array 视图只带走自己那一段，不把整个底层缓冲发出去', () => {
    const view = new Uint8Array(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)
    const decoded = roundTrip([view])[0] as ArrayBuffer
    expect(new Uint8Array(decoded)).toEqual(new Uint8Array([2, 3]))
  })

  it('带字节哨兵键但还有别的键时原样通过', () => {
    const value = { [BRIDGE_BYTES_MARK]: 'AA==', name: 'keep' }
    expect(roundTrip([value])[0]).toEqual(value)
  })
})
