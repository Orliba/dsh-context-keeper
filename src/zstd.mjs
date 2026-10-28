/**
 * Multi-frame zstd decoder for DSH session files.
 *
 * DSH writes `session.v*.jsonl.zstd` as a sequence of independently framed
 * zstd blocks (one per append batch), not a single continuous stream. Node's
 * `zstdDecompressSync` only reads the first frame, so every caller must split
 * on the magic number and decode each frame separately.
 *
 * Skippable frames (0x184D2A50..0x184D2A5F) are ignored: they carry metadata,
 * not content, and decoding them as normal frames throws.
 */
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** True when `buf` starts with a skippable-frame magic number at `at`. */
function isSkippableFrame(buf, at) {
  if (at + 4 > buf.length) return false
  const v = buf.readUInt32LE(at)
  return v >= 0x184d2a50 && v <= 0x184d2a5f
}

/**
 * Find the start offsets of every zstd frame in `buf`.
 * @param {Buffer} buf
 * @returns {number[]}
 */
export function findFrames(buf) {
  const starts = []
  let at = buf.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + 4)
  }
  return starts
}

/**
 * Decode every zstd frame in `buf` and concatenate the results.
 *
 * A frame that fails to decode is skipped rather than aborting the whole
 * file: one damaged append batch must not hide the rest of a session.
 *
 * @param {Buffer} buf
 * @returns {{ text: string, frames: number, failed: number }}
 */
export function decodeSession(buf) {
  const starts = findFrames(buf)
  if (starts.length === 0) {
    // Not compressed, or an unknown layout: treat as plain text.
    return { text: buf.toString('utf8'), frames: 0, failed: 0 }
  }
  const parts = []
  let failed = 0
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    if (isSkippableFrame(buf, from)) continue
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'))
    } catch {
      failed++
    }
  }
  return { text: parts.join(''), frames: starts.length, failed }
}
