/**
 * dsh-context-keeper — host plugin.
 *
 * v2 shipped one persistent system-prompt section (how to reason well) and an
 * offline analyzer. v3 adds context-budget awareness without ever putting a
 * changing number into the prompt (that would invalidate the provider's prefix
 * cache on every request — the opposite of saving tokens). Everything dynamic
 * goes through two human commands instead:
 *
 *   /context-watch   read the current session's occupancy and band
 *   /handoff         pack the current progress into a portable file + archive
 *
 * Both commands read the session file DSH already writes to disk and call a
 * model zero times, so they are cheap and cannot hallucinate. See
 * docs/distill-design-v3.md.
 *
 * ## Failure behaviour
 *
 * Every service is read through a guarded accessor. A harness build without
 * `systemPrompt`, `commands`, or a discoverable session file degrades to "that
 * feature is off" with one warning — it never takes the host down.
 */
import { readdirSync, statSync, accessSync, constants, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_RULE_TEXT } from './rule.mjs'
import { readSessionDetail } from '../src/session.mjs'
import { computeBudget, formatBudget, roughTokens } from '../src/budget.mjs'
import { writeHandoff } from '../src/handoff.mjs'

/** Stable section name: used for dedupe, config targeting, and log lines. */
export const SECTION_NAME = 'context-keeper:how-to-reason'
/** The short, static context-budget nudge section name. */
export const SECTION_NAME_BUDGET = 'context-keeper:context-budget'

/**
 * Where the reasoning section sits in the assembled prompt.
 * `PLAN_POLICY` is 500 and `TEAM_POLICY` 600, tool instructions start at 1000.
 */
export const SECTION_ORDER = 650
/** The budget nudge sits just after the reasoning rule, still before tools. */
export const SECTION_ORDER_BUDGET = 660

/**
 * Services this plugin reads. `commands` is required for the two v3 commands;
 * `systemPrompt` for the rule sections. Both are provided by the shipped base.
 * Logging is NOT a service (`console` is a Node global).
 */
export const inject = ['systemPrompt', 'commands']

/**
 * The static context-budget nudge. Deliberately static: no numbers, so it never
 * invalidates the prefix cache. Kept short because it is paid on every request.
 */
export const DEFAULT_BUDGET_NUDGE = `## Context budget
When a conversation gets long or close to the context limit, say so plainly and suggest handing off: \`/handoff\` packs the current progress so a new session can continue without re-deriving it. Do not quietly push a long session until it is auto-compacted.`

/**
 * Mount the plugin.
 * @param {any} ctx - Cordis context carrying the injected services.
 * @param {object} [config]
 * @param {string} [config.text] - Replace the default rule text.
 * @param {number} [config.order] - Override the reasoning section order.
 * @param {boolean} [config.enabled] - Set false to register nothing.
 * @param {number} [config.maxChars] - Truncate the rendered rule at this length.
 * @param {boolean} [config.contextNudge] - Register the static budget nudge (default true).
 * @param {boolean} [config.commands] - Register /context-watch and /handoff (default true).
 * @param {string} [config.sessionsRoot] - Override the DSH sessions root for command lookups.
 * @param {string} [config.handoffDir] - Override the handoff output directory.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  registerSections(ctx, config)
  registerCommands(ctx, config)
}

/** Register the static prompt sections, degrading if systemPrompt is absent. */
function registerSections(ctx, config) {
  const systemPrompt = service(ctx, 'systemPrompt')
  if (typeof systemPrompt?.section !== 'function') {
    warn('[context-keeper] systemPrompt.section() is unavailable in this harness build; prompt rules were not installed.')
    return
  }

  const text = resolveText(config)
  if (text !== '') {
    const order = Number.isFinite(config.order) ? config.order : SECTION_ORDER
    systemPrompt.section({ name: SECTION_NAME, order, interpolate: false, text })
  }

  if (config.contextNudge !== false) {
    systemPrompt.section({
      name: SECTION_NAME_BUDGET,
      order: SECTION_ORDER_BUDGET,
      interpolate: false,
      text: DEFAULT_BUDGET_NUDGE,
    })
  }
}

/** 注册两个人工命令；命令注册表缺失时降级、不抛错。 */
function registerCommands(ctx, config) {
  const commands = service(ctx, 'commands')
  if (typeof commands?.register !== 'function') {
    if (config.commands !== false) {
      warn('[context-keeper] ctx.commands.register() is unavailable; /context-watch and /handoff are off.')
    }
    return
  }
  if (config.commands === false) return

  // description 显示在 / 菜单那一行；命令名只能小写，可读性放这里。
  commands.register({
    name: 'context-watch',
    description: '查看上下文预算：占用比例、剩余空间、增长速度与上次压缩',
    handler: (invocation) => runContextWatch(ctx, config, invocation),
  })
  commands.register({
    name: 'handoff',
    description: '把当前进度打包成交接包（含逐字归档），便于开新会话接着做',
    handler: (invocation) => runHandoff(ctx, config, invocation),
  })
}

/**
 * `/context-watch`: resolve the current session file, estimate occupancy from
 * its content, and report the band. No model call.
 */
async function runContextWatch(ctx, config, invocation) {
  const located = locateSession(ctx, config, invocation)
  if (located.error) return { kind: 'error', text: located.error }
  let detail
  try {
    detail = readSessionDetail(located.file)
  } catch (error) {
    return { kind: 'error', text: `读取会话失败：${messageOf(error)}` }
  }
  const heuristicTokens = detailTokens(detail)
  const rc = detail.requestContext ?? {}
  const budget = computeBudget({ heuristicTokens, contextWindow: rc.contextWindow })
  const turns = Math.max(1, detail.turns || detail.assistantTexts.length || 1)
  const perTurnGrowth = Math.round(heuristicTokens / turns)
  const lines = formatBudget(budget, { perTurnGrowth, compactions: detail.compactions })
  lines.push('（数字为按字符的估算加上官方窗口；精确值以 DSH 的上下文环为准）')
  return { kind: 'success', text: lines.join('\n') }
}

/** `/handoff`: write the package + archive for the current session. No model call. */
async function runHandoff(ctx, config, invocation) {
  const located = locateSession(ctx, config, invocation)
  if (located.error) return { kind: 'error', text: located.error }
  let detail
  try {
    detail = readSessionDetail(located.file)
  } catch (error) {
    return { kind: 'error', text: `读取会话失败：${messageOf(error)}` }
  }
  const dir = resolveHandoffDir(config, detail)
  let result
  let fellBack = false
  try {
    result = writeHandoff(detail, { dir })
  } catch (error) {
    // Never fail the whole command on a directory problem (e.g. the workspace
    // sits outside the host's write permission and mkdir throws EPERM). Retry at
    // the package fallback so the user still gets a package, and say where.
    try {
      const fallback = packageHandoffDir()
      result = writeHandoff(detail, { dir: fallback })
      fellBack = true
    } catch (error2) {
      return {
        kind: 'error',
        text:
          `写入交接包失败：${messageOf(error)}\n` +
          `备用位置也失败：${messageOf(error2)}\n` +
          `提示：把会话切到一个可写的工作区（或设置 config.handoffDir）再试。`,
      }
    }
  }
  const s = result.materials.stats
  const text = [
    fellBack ? '注意：当前工作区不可写，已退到插件目录保存。' : '',
    '交接包已生成：',
    `  交接包（读这份，含编号第 1–8 节）：${result.packagePath}`,
    `  逐字归档（备查）：${result.archivePath}`,
    `  规模：${s.turns} 轮 / ${s.users} 条用户消息 / ${s.toolCalls} 次工具调用 / ${s.errors} 次报错 / 复用 ${s.compactions} 段已有摘要`,
    '',
    `开新会话粘贴：接着上次继续；详细交接见 ${result.packagePath}，先读第 1、6 节。`,
  ]
    .filter((l) => l !== '')
    .join('\n')
  return { kind: 'success', text }
}

/**
 * Resolve the current session's on-disk file.
 * Layered: agent.session.id -> DSH_SESSION_ID; sessions root from config -> DSH_HOME.
 * @returns {{ file: string } | { error: string }}
 */
function locateSession(ctx, config, invocation) {
  const id =
    invocation?.agent?.session?.id ||
    (typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID : '')
  const root = resolveSessionsRoot(config)
  if (!root) {
    return { error: '找不到会话目录（请设置 config.sessionsRoot 或环境变量 DSH_HOME）。' }
  }
  if (!id) return { error: '无法确定当前会话 id（agent.session.id 与 DSH_SESSION_ID 都为空）。' }
  const file = findSessionFile(root, id)
  if (!file) return { error: `在 ${root} 下找不到会话 ${id} 的 session.v*.jsonl.zstd 文件。` }
  return { file }
}

/** Walk the sessions root for a session dir matching `id`; return its newest log. */
export function findSessionFile(root, id) {
  let dirs = []
  try {
    for (const ws of readdirSync(root)) {
      const wsPath = join(root, ws)
      let entries = []
      try {
        entries = readdirSync(wsPath)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry === id || entry.includes(id.replace(/^session-/, ''))) dirs.push(join(wsPath, entry))
      }
    }
  } catch {
    return null
  }
  let best = null
  let bestVer = -1
  for (const dir of dirs) {
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(f)
      if (!m) continue
      const ver = Number(m[1])
      if (ver > bestVer) {
        bestVer = ver
        best = join(dir, f)
      }
    }
  }
  return best
}

function resolveSessionsRoot(config) {
  if (typeof config.sessionsRoot === 'string' && config.sessionsRoot.trim() !== '') return config.sessionsRoot.trim()
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), 'sessions')
  return ''
}

function resolveHandoffDir(config, detail) {
  if (typeof config.handoffDir === 'string' && config.handoffDir.trim() !== '') return config.handoffDir.trim()
  // Preferred: INSIDE the current session's workspace (<cwd>/.context-keeper/handoff),
  // so a new session on the same workspace can read it without permission prompts.
  // Only use it when its nearest existing parent is writable; otherwise fall back.
  const cwd = detail?.session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const inWorkspace = join(cwd.trim(), '.context-keeper', 'handoff')
    if (isWritableTarget(inWorkspace)) return inWorkspace
  }
  return packageHandoffDir()
}

/** <package>/handoff — always inside our own (writable) project tree. */
function packageHandoffDir() {
  try {
    return fileURLToPath(new URL('../handoff', import.meta.url))
  } catch {
    return 'handoff'
  }
}

/**
 * Can we create `dir`? Walk up to the nearest existing ancestor and probe it
 * without writing. This avoids trying mkdir on a directory the host process may
 * not write (e.g. a workspace whose ACL rejects grantWrite -> mkdir EPERM).
 * @param {string} dir
 * @returns {boolean}
 */
function isWritableTarget(dir) {
  try {
    let p = dir
    for (let i = 0; i < 40 && p; i++) {
      try {
        if (statSync(p).isDirectory()) {
          accessSync(p, constants.W_OK)
          return true
        }
      } catch {
        // not existing at this level; keep walking up
      }
      const parent = join(p, '..')
      if (parent === p) break
      p = parent
    }
  } catch {
    // ignore, treat as not writable
  }
  return false
}

/** Rough token estimate of everything a request would carry from this session. */
function detailTokens(detail) {
  let total = 0
  for (const u of detail.users) total += roughTokens(u.text)
  for (const a of detail.assistantTexts) total += roughTokens(a.text)
  for (const r of detail.toolResults) total += roughTokens(r.text)
  return total
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function warn(message) {
  const w = globalThis.console?.warn
  if (typeof w === 'function') w.call(globalThis.console, message)
}

/**
 * Read a declared service without letting an undeclared or absent one throw.
 * @param {any} ctx
 * @param {string} prop
 * @returns {any}
 */
function service(ctx, prop) {
  try {
    return ctx?.[prop]
  } catch {
    return undefined
  }
}

/**
 * Pick the rule text and clamp it to a sane length.
 * @param {object} config
 * @returns {string}
 */
function resolveText(config) {
  const raw = typeof config.text === 'string' ? config.text : DEFAULT_RULE_TEXT
  const max = Number.isFinite(config.maxChars) ? config.maxChars : 2000
  const trimmed = String(raw).trim()
  if (trimmed === '') return ''
  if (trimmed.length <= max) return trimmed
  const head = trimmed.slice(0, max)
  const cut = head.lastIndexOf('\n\n')
  return cut > max * 0.5 ? head.slice(0, cut) : head
}

export { DEFAULT_RULE_TEXT }
