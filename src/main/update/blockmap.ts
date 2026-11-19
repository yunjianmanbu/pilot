/**
 * electron-builder writes a `.blockmap` next to every NSIS installer. The
 * blockmap lists SHA-256-derived checksums for fixed ranges of the installer
 * file, which lets an update download only the ranges that changed since the
 * previous installer instead of the full ~120 MB payload.
 *
 * The blockmap is untrusted metadata: the assembled installer is always
 * verified against the SHA-256 in latest.json before it is offered for install.
 */

export const MAX_BLOCKMAP_BLOCKS = 200_000
export const MAX_BLOCKMAP_BLOCK_BYTES = 1024 * 1024

export interface BlockMapBlock {
  /** Byte offset in the installer file. */
  offset: number
  size: number
  checksum: string
}

export interface BlockMap {
  blocks: BlockMapBlock[]
  totalSize: number
}

const CHECKSUM_PATTERN = /^[A-Za-z0-9+/]{20,64}={0,2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Validate an untrusted blockmap JSON payload against the expected file size. */
export function parseBlockMap(raw: unknown, expectedSize: number): BlockMap {
  if (!isRecord(raw) || raw['version'] !== '2' || !Array.isArray(raw['files'])) {
    throw new Error('blockmap 格式不正确')
  }
  if (raw['files'].length !== 1) throw new Error('blockmap 文件条目数量不正确')
  const file = raw['files'][0]
  if (!isRecord(file) || file['offset'] !== 0) throw new Error('blockmap 文件偏移不正确')
  const checksums = file['checksums']
  const sizes = file['sizes']
  if (!Array.isArray(checksums) || !Array.isArray(sizes)) {
    throw new Error('blockmap 缺少分块信息')
  }
  if (checksums.length === 0 || checksums.length !== sizes.length) {
    throw new Error('blockmap 分块数量不一致')
  }
  if (checksums.length > MAX_BLOCKMAP_BLOCKS) throw new Error('blockmap 分块过多')

  let offset = 0
  const blocks: BlockMapBlock[] = []
  for (let index = 0; index < checksums.length; index += 1) {
    const checksum = checksums[index]
    const size = sizes[index]
    if (typeof checksum !== 'string' || !CHECKSUM_PATTERN.test(checksum)) {
      throw new Error('blockmap 分块校验值不正确')
    }
    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > MAX_BLOCKMAP_BLOCK_BYTES
    ) {
      throw new Error('blockmap 分块大小不正确')
    }
    blocks.push({ offset, size, checksum })
    offset += size
  }
  if (offset !== expectedSize) throw new Error('blockmap 与安装包大小不一致')
  return { blocks, totalSize: offset }
}

export type DeltaSegmentKind = 'copy' | 'download'

export interface DeltaSegment {
  kind: DeltaSegmentKind
  /** Offset of this segment in the new installer. */
  targetOffset: number
  /** Offset in the old installer; 0 for downloaded segments. */
  sourceOffset: number
  size: number
}

export interface DeltaPlan {
  segments: DeltaSegment[]
  /** Bytes fetched from the server (excluding the blockmap itself). */
  downloadBytes: number
  /** Bytes reused from the previously downloaded installer. */
  copyBytes: number
}

/**
 * Match new blocks against the old installer by checksum. Unmatched blocks are
 * downloaded; matched blocks are copied from their old offset. Adjacent
 * segments of the same kind are coalesced so a plan is usually a handful of
 * HTTP Range requests.
 */
export function planDelta(next: BlockMap, old: BlockMap): DeltaPlan {
  const oldByChecksum = new Map<string, BlockMapBlock>()
  for (const block of old.blocks) {
    if (!oldByChecksum.has(block.checksum)) oldByChecksum.set(block.checksum, block)
  }

  const segments: DeltaSegment[] = []
  let downloadBytes = 0
  let copyBytes = 0

  for (const block of next.blocks) {
    const match = oldByChecksum.get(block.checksum)
    const kind: DeltaSegmentKind = match && match.size === block.size ? 'copy' : 'download'
    if (kind === 'download') downloadBytes += block.size
    else copyBytes += block.size

    const previous = segments[segments.length - 1]
    if (
      previous &&
      previous.kind === kind &&
      previous.targetOffset + previous.size === block.offset &&
      (kind === 'download' || previous.sourceOffset + previous.size === (match?.offset ?? 0))
    ) {
      previous.size += block.size
      continue
    }
    segments.push({
      kind,
      targetOffset: block.offset,
      sourceOffset: kind === 'copy' ? (match?.offset ?? 0) : 0,
      size: block.size,
    })
  }

  const covered = segments.reduce((total, segment) => total + segment.size, 0)
  if (covered !== next.totalSize) throw new Error('blockmap 差分计划不完整')
  return { segments, downloadBytes, copyBytes }
}
