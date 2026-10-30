/**
 * Handoff packaging for dsh-context-keeper v3.
 *
 * Turns one session's decoded detail into a portable "handoff" the user can
 * paste into a fresh session, plus a full faithful archive on disk so nothing
 * is truly lost.
 *
 * Design choices that matter (see docs/distill-design-v3.md, section 6):
 *
 * - **Verbatim-first, zero model calls.** This mechanical pack quotes the user
 *   and surfaces real paths/errors instead of asking a model to summarize. It
 *   cannot hallucinate, costs nothing, and is faster than a summary call. An
 *   optional LLM-distilled pack is a later toggle, not the default.
 * - **Reuse DSH's own distillation.** If the session already has
 *   `compaction/summary` checkpoints, their text is DSH's own 8-section summary;
 *   we lift it as the "early context" instead of recompressing it. That is free
 *   multi-level distillation (T2 summary reused, recent tail kept verbatim).
 * - **Never lose the tail.** The most recent assistant answer and the recent
 *   user intents are quoted, matching the billion-context rule that the last
 *   user message and the current working set must survive compaction.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Clip a long string, marking the cut so a reader knows it is truncated. */
export function clip(text, n) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (s.length <= n) return s
  return s.slice(0, n) + `\n…[已截断，原文 ${s.length} 字，见归档]`
}

/** One-line summary of a string (first non-empty line, clipped). */
function firstLine(text, n = 160) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
  const line = s.split('\n').find((l) => l.trim() !== '') ?? ''
  return clip(line.trim(), n).replace(/\n/g, ' ')
}

const PATH_WIN = /[A-Za-z]:\\[^\s"'`<>|*?\r\n,;]+/g
const PATH_FILE = /(?<![\w.])((?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|py|yml|yaml|conf|toml|aedt|aedtz|pth|csv|txt|zstd|ps1|cmd|sh|html|css))\b/g

/**
 * Is this user message actually an injected scaffold (runtime memory, recalled
 * chat history, system reminder) rather than something the human typed?
 *
 * These blobs can be hundreds of kilobytes; quoting one into the "what to do"
 * section buries the real ask. The archive still keeps them verbatim - only the
 * handoff *summary* filters them out.
 * @param {string} text
 * @returns {boolean}
 */
export function isInjectedUserText(text) {
  const t = String(text ?? '').trim()
  if (t.length > 1600) return true // pasted logs / memory dumps, never a one-line ask
  const markers = [
    'MNEMON RUNTIME MEMORY SNAPSHOT',
    '<runtime-memory-file',
    'Contents of USER.md',
    'Contents of MEMORY.md',
    '这是我们最近的聊天记录',
    '【会话令牌】',
    '<system-reminder>',
    'Current runtime context',
    'Time sampled while preparing',
    'Browser time zone for this request',
    'Current DSH file policy',
    'Approval policy:',
    'You are the Team Lead',
    'Use list_agents(',
  ]
  return markers.some((m) => t.startsWith(m) || (t.length > 600 && t.includes(m)))
}

/** Pull candidate file paths out of a tool call's raw arguments. */
export function extractPaths(args) {
  const out = new Set()
  const s = String(args ?? '')
  const add = (p) => {
    // Cut at the first CJK/fullwidth punctuation: paths with a trailing Chinese
    // sentence ("...\.ssh，该目录在工作区之外") are a common tool-arg artifact.
    let v = String(p).trim().split(/[\u3000-\u303f\uff00-\uffef]/)[0].trim()
    v = v.replace(/\\\\/g, '\\').replace(/[\\/]+$/, '')
    if (v.length < 4) return // drive-only / noise
    if (/^[A-Za-z]:\\?[A-Za-z]?$/.test(v)) return // "s:\n" style junk
    out.add(v)
  }
  // Prefer explicit JSON path fields when the args are JSON.
  try {
    const obj = JSON.parse(s)
    if (obj && typeof obj === 'object') {
      for (const key of ['path', 'file_path', 'filePath', 'file', 'target', 'filename']) {
        if (typeof obj[key] === 'string' && obj[key].trim() !== '') add(obj[key])
      }
    }
  } catch {
    // not JSON - fall through to regex
  }
  let m
  const reWin = new RegExp(PATH_WIN.source, 'g')
  while ((m = reWin.exec(s))) add(m[0])
  PATH_FILE.lastIndex = 0
  while ((m = PATH_FILE.exec(s))) add(m[1])
  return [...out]
}

/**
 * @typedef {object} HandoffMaterials
 * @property {string} title
 * @property {string} generatedAt
 * @property {object} source
 * @property {string} intent
 * @property {{path:string,count:number}[]} files
 * @property {{cmd:string}[]} commands
 * @property {{tool:string,text:string}[]} errors
 * @property {string} earlyContext
 * @property {string} current
 * @property {string} next
 * @property {string} archivePath
 * @property {object} stats
 */

/**
 * Build handoff materials from a `readSessionDetail()` result.
 * @param {object} detail
 * @param {object} [opts]
 * @param {number} [opts.maxRecentIntents]  recent user messages to quote
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxErrors]
 * @param {number} [opts.maxCurrentChars]
 * @param {string} [opts.now]  ISO timestamp override (for tests)
 * @returns {HandoffMaterials}
 */
export function buildMaterials(detail, opts = {}) {
  const {
    maxRecentIntents = 4,
    maxFiles = 40,
    maxErrors = 15,
    maxCurrentChars = 1800,
    now = new Date().toISOString(),
  } = opts

  const users = Array.isArray(detail.users) ? detail.users : []
  const toolCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : []
  const toolResults = Array.isArray(detail.toolResults) ? detail.toolResults : []
  const assistantTexts = Array.isArray(detail.assistantTexts) ? detail.assistantTexts : []
  const compactions = Array.isArray(detail.compactions) ? detail.compactions : []

  const title = (detail.title || detail.session?.id || detail.name || '未命名会话').trim()

  // ---- intent: the first real ask plus the most recent real asks -----------
  // Injected scaffolds (memory snapshots, recalled history) are filtered out:
  // they are data, not the human's request, and one of them can be 400K chars.
  const intentUsers = users.filter((u) => !isInjectedUserText(u.text))
  const intentParts = []
  const first = intentUsers[0] ?? users[0]
  if (first) intentParts.push(`【最初】${clip(first.text, 700)}`)
  const seen = new Set([first?.text])
  const recent = (intentUsers.length > 0 ? intentUsers : users).slice(-maxRecentIntents)
  for (const u of recent) {
    if (seen.has(u.text)) continue
    seen.add(u.text)
    intentParts.push(`【最近】${clip(u.text, 500)}`)
  }
  const intent = intentParts.length > 0 ? intentParts.join('\n\n') : '(没有用户消息)'

  // ---- files / commands from tool calls -------------------------------------
  const fileCount = new Map()
  const commands = []
  for (const call of toolCalls) {
    for (const p of extractPaths(call.args)) fileCount.set(p, (fileCount.get(p) ?? 0) + 1)
    if (call.name === 'pwsh' || call.name === 'bash' || call.name === 'shell') {
      let cmd = ''
      try {
        const obj = JSON.parse(call.args)
        cmd = typeof obj.command === 'string' ? obj.command : ''
      } catch {
        cmd = call.args
      }
      if (cmd.trim() !== '') {
        const desc = call.description ? firstLine(call.description, 120) : ''
        const label = desc || firstLine(cmd, 160)
        // Skip bare fragments like "try {" or "$cands = @(" when no description.
        if (label !== '' && !/[{(\[]$/.test(label)) commands.push({ cmd: label })
      }
    }
  }
  const files = [...fileCount.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxFiles)

  // ---- errors: tool results flagged as errors, mapped back to their call ----
  const nameByCall = new Map(toolCalls.map((c) => [c.callId, c.name]))
  const errors = toolResults
    .filter((r) => r.isError)
    .slice(-maxErrors)
    .map((r) => ({ tool: nameByCall.get(r.callId) ?? '(unknown)', text: firstLine(r.text, 300) }))

  // ---- early context: reuse DSH's own latest checkpoint ---------------------
  const earlyContext = compactions.length > 0 ? compactions[compactions.length - 1].summary : ''

  // ---- current work: the most recent answer ---------------------------------
  const current = assistantTexts.length > 0 ? clip(assistantTexts[assistantTexts.length - 1].text, maxCurrentChars) : '(还没有助手回复)'

  // ---- next step: mechanical can only point at the last real ask ------------
  const lastAsk = intentUsers[intentUsers.length - 1] ?? users[users.length - 1]
  const lastUser = lastAsk ? firstLine(lastAsk.text, 240) : ''
  const next = lastUser !== '' ? `从最近一条用户消息继续：「${lastUser}」` : '(无明确下一步)'

  const rc = detail.requestContext ?? {}

  return {
    title,
    generatedAt: now,
    source: {
      sessionId: detail.session?.id ?? '',
      cwd: detail.session?.cwd ?? '',
      agentPreset: detail.session?.agentPreset ?? '',
      model: rc.model ?? '',
      provider: rc.provider ?? '',
      contextWindow: rc.contextWindow ?? null,
      path: detail.path ?? '',
      frames: detail.frames ?? 0,
      failedFrames: detail.failedFrames ?? 0,
    },
    intent,
    files,
    commands,
    errors,
    earlyContext,
    current,
    next,
    packagePath: '',
    archivePath: '',
    stats: {
      users: users.length,
      assistantTexts: assistantTexts.length,
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
      errors: errors.length,
      compactions: compactions.length,
      turns: detail.turns ?? 0,
      steps: detail.steps ?? 0,
    },
  }
}

/**
 * Render the handoff package (the thing the user reads and pastes).
 * @param {HandoffMaterials} m
 * @returns {string}
 */
export function renderPackage(m) {
  // The paste target is THIS numbered package, never the verbatim archive.
  // writeHandoff fills m.packagePath; render-only callers may pass it or leave it.
  const pkg = m.packagePath || '<交接包路径>'
  const lines = []
  lines.push(`# 交接包 · ${m.title}`)
  lines.push('')
  lines.push(`> 生成：${m.generatedAt}`)
  lines.push(
    `> 来源会话：\`${m.source.sessionId || '(未知)'}\` · 模型：${m.source.model || '(未记录)'} · 窗口：${
      m.source.contextWindow ?? '?'
    } tokens`,
  )
  lines.push(`> 原始归档：\`${m.archivePath || '(见落盘)'}\``)
  lines.push(
    `> 规模：${m.stats.turns} 轮 / ${m.stats.users} 条用户消息 / ${m.stats.toolCalls} 次工具调用 / ${m.stats.errors} 次报错`,
  )
  lines.push('')

  lines.push('## 1. 要做的事')
  lines.push(m.intent || '(无)')
  lines.push('')

  lines.push('## 2. 涉及的文件（按出现次数）')
  if (m.files.length === 0) lines.push('(none)')
  for (const f of m.files) lines.push(`- \`${f.path}\` (×${f.count})`)
  lines.push('')

  lines.push('## 3. 跑过的命令')
  if (m.commands.length === 0) lines.push('(none)')
  for (const c of m.commands.slice(0, 20)) lines.push(`- ${c.cmd}`)
  if (m.commands.length > 20) lines.push(`- …共 ${m.commands.length} 条，其余见归档`)
  lines.push('')

  lines.push('## 4. 错误与修复（工具报错原串）')
  if (m.errors.length === 0) lines.push('(none)')
  for (const e of m.errors) lines.push(`- [${e.tool}] ${e.text}`)
  lines.push('')

  lines.push('## 5. 早期上下文（DSH 已蒸馏的摘要，若有）')
  lines.push(m.earlyContext ? clip(m.earlyContext, 6000) : '(本会话此前没有压缩摘要，早期内容见归档)')
  lines.push('')

  lines.push('## 6. 当前进行到哪（最近一段回复）')
  lines.push(m.current || '(无)')
  lines.push('')

  lines.push('## 7. 下一步')
  lines.push(m.next || '(无)')
  lines.push('')

  lines.push('## 8. 全文归档')
  lines.push(`\`${m.archivePath || '(见落盘)'}\``)
  lines.push('需要查细节：`grep -n "<关键词>" <归档路径>`')
  lines.push('')

  lines.push('## 用法')
  lines.push(`开新会话后第一条粘贴：\`接着上次继续；详细交接见 ${pkg}，先读第 1、6 节。\``)
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the full archive (faithful, so nothing is truly lost).
 * @param {object} detail
 * @param {object} meta
 * @returns {string}
 */
export function renderArchive(detail, meta) {
  const lines = []
  lines.push(`# 归档 · ${detail.title || detail.session?.id || detail.name || '会话'}`)
  lines.push('')
  lines.push(`> 生成：${meta.generatedAt ?? ''}`)
  lines.push(`> 会话：${detail.session?.id ?? ''} · cwd：${detail.session?.cwd ?? ''}`)
  lines.push(`> 帧：${detail.frames ?? 0}（失败 ${detail.failedFrames ?? 0}）`)
  if (meta.outputPath) {
    lines.push(
      `> 这是「逐字归档」，按事件分节，**没有**编号的第 1–8 节。编号交接包在同目录：\`${meta.packagePath ?? '(同名前缀的 .md)'}\``,
    )
  }
  lines.push('')

  lines.push('## 用户消息（逐字）')
  if (!detail.users?.length) lines.push('(none)')
  for (const u of detail.users ?? []) {
    lines.push(`### [seq ${u.seq}]`)
    lines.push(u.text)
    lines.push('')
  }

  lines.push('## 工具调用')
  if (!detail.toolCalls?.length) lines.push('(none)')
  for (const c of detail.toolCalls ?? []) {
    lines.push(`- [seq ${c.seq}] ${c.name}${c.description ? ` — ${c.description}` : ''}`)
    lines.push('  ```')
    lines.push('  ' + clip(c.args, 2000).replace(/\n/g, '\n  '))
    lines.push('  ```')
  }
  lines.push('')

  lines.push('## 工具结果')
  if (!detail.toolResults?.length) lines.push('(none)')
  for (const r of detail.toolResults ?? []) {
    lines.push(`### [seq ${r.seq}] ${r.isError ? 'ERROR' : 'ok'} (call ${r.callId})`)
    lines.push(clip(r.text, 4000))
    lines.push('')
  }

  lines.push('## 助手回复（逐字）')
  if (!detail.assistantTexts?.length) lines.push('(none)')
  for (const a of detail.assistantTexts ?? []) {
    lines.push(`### [seq ${a.seq} · turn ${a.turn} step ${a.step}]`)
    lines.push(clip(a.text, 4000))
    lines.push('')
  }

  lines.push('## 压缩摘要（逐字）')
  if (!detail.compactions?.length) lines.push('(none)')
  for (const c of detail.compactions ?? []) {
    lines.push(`### [seq ${c.seq}]`)
    lines.push(c.summary)
    lines.push('')
  }

  return lines.join('\n')
}

/** Filesystem-safe short id for filenames. */
export function slugFor(detail, title) {
  const id = String(detail.session?.id ?? '').replace(/[^A-Za-z0-9]/g, '')
  const shortId = id.slice(-8) || 'session'
  const t = String(title ?? '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return t ? `${t}-${shortId}` : shortId
}

/** Format an epoch-ms or Date as YYYYMMDD-HHmmss (local). */
export function stamp(now = Date.now()) {
  const d = now instanceof Date ? now : new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * Write package + archive to `dir`. Returns the absolute paths and the
 * materials (with `archivePath` filled in).
 * @param {object} detail
 * @param {object} [opts]
 * @param {string} [opts.dir]  target directory
 * @param {number|Date} [opts.now]
 * @param {object} [opts.build]  options passed to buildMaterials
 */
export function writeHandoff(detail, opts = {}) {
  const { dir, now = Date.now(), build = {} } = opts
  if (!dir) throw new Error('writeHandoff: dir is required')
  mkdirSync(dir, { recursive: true })
  const materials = buildMaterials(detail, { ...build, now: new Date(now).toISOString() })
  const base = `${stamp(now)}-${slugFor(detail, materials.title)}`
  const packagePath = join(dir, `${base}.md`)
  const archivePath = join(dir, `${base}.archive.md`)
  materials.packagePath = packagePath
  materials.archivePath = archivePath
  writeFileSync(packagePath, renderPackage(materials), 'utf8')
  writeFileSync(
    archivePath,
    renderArchive(detail, { generatedAt: materials.generatedAt, outputPath: archivePath, packagePath }),
    'utf8',
  )
  return { packagePath, archivePath, materials }
}
