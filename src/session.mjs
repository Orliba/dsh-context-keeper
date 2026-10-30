/**
 * Session reader: turn a DSH `session.v*.jsonl.zstd` file into structured
 * reasoning records.
 *
 * The single most important rule in this module: read reasoning text from
 * `data.message.content[]` ONLY.
 *
 * A single reasoning block is stored four times in the same event:
 *
 *   data.message.content[]                    the assembled content blocks
 *   data.message.source.replayState.blocks[]  adapter replay envelope
 *   data.stream[].chunk.block                 per-chunk block-end payload
 *   data.stream[].chunk.replayState.blocks[]  per-chunk replay envelope
 *
 * Measured on a real session: 235 blocks at each of those four paths, and the
 * naive "walk everything with type === 'reasoning'" counter reports 940 —
 * exactly 4x. Any tool that counts reasoning by walking the event tree
 * inflates every metric by 4, silently. Walking `content[]` is the only
 * path that yields one record per model attempt.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { decodeSession } from './zstd.mjs'

/**
 * @typedef {object} ReasoningRecord
 * @property {number} seq        Event sequence number.
 * @property {number} turn       Turn index within the session.
 * @property {number} step       Step index within the turn.
 * @property {string} text       The full reasoning text of this attempt.
 * @property {string} model      Model id that produced it, when recorded.
 * @property {string} provider   Provider id that produced it, when recorded.
 * @property {number} [outputTokens]  Output tokens reported for the attempt.
 * @property {number} [thinkingMs]    Wall time from first to last reasoning delta.
 * @property {number} toolCalls  Number of tool calls emitted in the same attempt.
 * @property {number} textChars  Chars of user-visible answer text in the attempt.
 */

/**
 * Read one session file.
 * @param {string} path
 * @returns {{ path: string, records: ReasoningRecord[], turns: number, steps: number, failedFrames: number, frames: number }}
 */
export function readSession(path) {
  const buf = readFileSync(path)
  const { text, frames, failed } = decodeSession(buf)
  const lines = text.split('\n').filter((l) => l.trim() !== '')

  /** @type {ReasoningRecord[]} */
  const records = []
  let maxTurn = 0
  let steps = 0

  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue // a truncated tail line is expected while a session is live
    }
    if (event?.type !== 'assistant/message') continue

    const data = event.data
    if (!data) continue
    const turn = typeof data.turn === 'number' ? data.turn : 0
    const step = typeof data.step === 'number' ? data.step : 0
    maxTurn = Math.max(maxTurn, turn)
    steps++

    const content = data.message?.content
    if (!Array.isArray(content)) continue

    let reasoning = ''
    let textChars = 0
    let toolCalls = 0
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'reasoning' && typeof block.text === 'string') {
        // Concatenate: a single attempt can carry more than one reasoning block.
        reasoning += block.text
      } else if (block.type === 'text' && typeof block.text === 'string') {
        textChars += block.text.length
      } else if (block.type === 'tool-call') {
        toolCalls++
      }
    }
    if (reasoning === '') continue

    const source = data.message?.source ?? {}
    records.push({
      seq: typeof event.seq === 'number' ? event.seq : 0,
      turn,
      step,
      text: reasoning,
      model: typeof source.model === 'string' ? source.model : '',
      provider: typeof source.provider === 'string' ? source.provider : '',
      outputTokens: typeof data.usage?.outputTokens === 'number' ? data.usage.outputTokens : undefined,
      thinkingMs: thinkingDuration(data.stream),
      toolCalls,
      textChars,
    })
  }

  return {
    path,
    name: basename(path),
    frames,
    failedFrames: failed,
    records,
    turns: maxTurn,
    steps,
  }
}

/**
 * Wall time spent emitting reasoning deltas, from the recorded chunk timings.
 *
 * `data.stream[]` carries one `reasoning-chunks` entry per reasoning block with
 * `time0` (epoch ms of the first delta) and `dt[]` (ms gaps between deltas).
 * Summing `dt` gives the time the model spent producing thinking tokens,
 * excluding the gap between thinking and answering.
 *
 * @param {unknown} stream
 * @returns {number | undefined}
 */
function thinkingDuration(stream) {
  if (!Array.isArray(stream)) return undefined
  let total = 0
  let seen = false
  for (const entry of stream) {
    if (entry?.type !== 'reasoning-chunks') continue
    if (!Array.isArray(entry.dt)) continue
    seen = true
    for (const d of entry.dt) if (typeof d === 'number' && d > 0) total += d
  }
  return seen ? total : undefined
}

/**
 * Enumerate DSH session files under a sessions root.
 * Layout: <root>/<workspace-slug>/<session-id>/session.v*.jsonl.zstd
 *
 * @param {string} root
 * @returns {string[]}
 */
export function listSessions(root, { readdirSync, statSync, join } = {}) {
  const fs = { readdirSync, statSync, join }
  if (!fs.readdirSync) return []
  const out = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root)
  } catch {
    return []
  }
  for (const ws of workspaces) {
    const wsPath = fs.join(root, ws)
    let entries = []
    try {
      entries = fs.readdirSync(wsPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const sessionDir = fs.join(wsPath, entry)
      let files = []
      try {
        files = fs.readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.startsWith('session.v') || !f.endsWith('.zstd')) continue
        out.push(fs.join(sessionDir, f))
      }
    }
  }
  return out
}

/**
 * Richer, single-pass read of a session file for context budget and handoff.
 *
 * `readSession()` only extracts reasoning records (it was built for the trace
 * analyzer). A handoff needs the *whole* conversation shape: what the user
 * asked, which files/commands were touched, which tool calls failed, what the
 * last answer said, and any checkpoint that DSH already produced. This function
 * folds the same decoded event stream once and returns all of it.
 *
 * Extraction rules that matter:
 * - `user/message` carries only text blocks that matter to a handoff; media
 *   blocks are ignored (their bytes live elsewhere, the handle is noise here).
 * - Tool calls come from `tool/call` events, not from `assistant/message`
 *   `tool-call` blocks: the same call appears in both, and counting both would
 *   double every file/command.
 * - `compaction/summary` already holds DSH's own 8-section distilled checkpoint;
 *   reusing it is free multi-level distillation - we never recompute it.
 *
 * @param {string} path
 * @returns {{
 *   path: string, name: string, frames: number, failedFrames: number,
 *   session: {id:string,cwd:string,agentPreset:string,createdAt:number}|null,
 *   title: string,
 *   requestContext: {provider:string,model:string,contextWindow:number}|null,
 *   users: {seq:number,text:string}[],
 *   assistantTexts: {seq:number,turn:number,step:number,text:string}[],
 *   toolCalls: {seq:number,turn:number,step:number,callId:string,name:string,args:string,description:string}[],
 *   toolResults: {seq:number,turn:number,step:number,callId:string,isError:boolean,text:string}[],
 *   compactions: {seq:number,summary:string,shadowedSeqs:number[]}[],
 *   records: import('./session.mjs').ReasoningRecord[],
 *   turns: number, steps: number
 * }}
 */
export function readSessionDetail(path) {
  const buf = readFileSync(path)
  const { text, frames, failed } = decodeSession(buf)
  const lines = text.split('\n').filter((l) => l.trim() !== '')

  const detail = {
    path,
    name: basename(path),
    frames,
    failedFrames: failed,
    session: null,
    title: '',
    requestContext: null,
    users: [],
    assistantTexts: [],
    toolCalls: [],
    toolResults: [],
    compactions: [],
    records: [],
    turns: 0,
    steps: 0,
  }

  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const data = event.data

    switch (event.type) {
      case 'session': {
        // The session header is flat (fields on the event, not under data).
        const s = data ?? event
        detail.session = {
          id: typeof s?.id === 'string' ? s.id : '',
          cwd: typeof s?.cwd === 'string' ? s.cwd : '',
          agentPreset: typeof s?.agentPreset === 'string' ? s.agentPreset : '',
          createdAt: typeof s?.createdAt === 'number' ? s.createdAt : 0,
        }
        break
      }
      case 'session/title':
        if (typeof data?.title === 'string' && data.title.trim() !== '') detail.title = data.title.trim()
        break
      case 'request/context':
        if (data && typeof data.contextWindow === 'number') {
          detail.requestContext = {
            provider: typeof data.provider === 'string' ? data.provider : '',
            model: typeof data.model === 'string' ? data.model : '',
            contextWindow: data.contextWindow,
          }
        }
        break
      case 'user/message': {
        const t = textOf(data?.content)
        if (t !== '') detail.users.push({ seq, text: t })
        break
      }
      case 'assistant/message': {
        const turn = typeof data?.turn === 'number' ? data.turn : 0
        const step = typeof data?.step === 'number' ? data.step : 0
        detail.turns = Math.max(detail.turns, turn)
        detail.steps++
        const content = data?.message?.content
        if (!Array.isArray(content)) break
        let reasoning = ''
        let answer = ''
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text
          else if (block.type === 'text' && typeof block.text === 'string') answer += block.text
        }
        if (answer !== '') detail.assistantTexts.push({ seq, turn, step, text: answer })
        if (reasoning !== '') {
          const source = data?.message?.source ?? {}
          detail.records.push({
            seq,
            turn,
            step,
            text: reasoning,
            model: typeof source.model === 'string' ? source.model : '',
            provider: typeof source.provider === 'string' ? source.provider : '',
            outputTokens: typeof data?.usage?.outputTokens === 'number' ? data.usage.outputTokens : undefined,
            thinkingMs: thinkingDuration(data?.stream),
            toolCalls: 0,
            textChars: answer.length,
          })
        }
        break
      }
      case 'tool/call':
        detail.toolCalls.push({
          seq,
          turn: typeof data?.turn === 'number' ? data.turn : 0,
          step: typeof data?.step === 'number' ? data.step : 0,
          callId: typeof data?.callId === 'string' ? data.callId : '',
          name: typeof data?.name === 'string' ? data.name : '',
          args: typeof data?.arguments === 'string' ? data.arguments : '',
          description: typeof data?.description === 'string' ? data.description : '',
        })
        break
      case 'tool/result':
        detail.toolResults.push({
          seq,
          turn: typeof data?.turn === 'number' ? data.turn : 0,
          step: typeof data?.step === 'number' ? data.step : 0,
          callId: typeof data?.toolCallId === 'string' ? data.toolCallId : (typeof data?.message?.toolCallId === 'string' ? data.message.toolCallId : ''),
          isError: data?.isError === true || data?.message?.isError === true,
          text: textOf(data?.message?.content),
        })
        break
      case 'compaction/summary':
        detail.compactions.push({
          seq,
          summary: textOf(data?.summary),
          shadowedSeqs: Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs : [],
        })
        break
      default:
        break
    }
  }

  return detail
}

/**
 * Join the text blocks of a content array. Non-text blocks (images, files,
 * reasoning) contribute nothing: a handoff cites text and handles, not bytes.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text
    }
  }
  return out
}
