/**
 * Context-budget math for dsh-context-keeper v3.
 *
 * Pure functions only: they take numbers already measured elsewhere and decide
 * how full the window is and which alert band that lands in. They never read a
 * session, call a model, or touch a clock, so they are unit-testable and cannot
 * be the reason a request is slow.
 *
 * Why this exists instead of "just show a percent": the useful question is not
 * only "how full" but "how fast" and "where did the last drop come from". A
 * single number says a lot less than the band plus the headroom plus the last
 * reclaim. See docs/distill-design-v3.md, section 5.
 */

/** Occupancy bands, tuned to fire *before* DSH's own auto-compaction. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  yellow: 0.5,
  orange: 0.65,
  red: 0.8,
})

/**
 * Which band an occupancy lands in.
 * @param {number} occupancy - 0..1 (or higher if provider usage overshoots).
 * @param {{yellow:number,orange:number,red:number}} [thresholds]
 * @returns {'green'|'yellow'|'orange'|'red'|'unknown'}
 */
export function levelFor(occupancy, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(occupancy)) return 'unknown'
  if (occupancy >= thresholds.red) return 'red'
  if (occupancy >= thresholds.orange) return 'orange'
  if (occupancy >= thresholds.yellow) return 'yellow'
  return 'green'
}

/**
 * @typedef {object} Budget
 * @property {number} used            Tokens the next request is expected to carry.
 * @property {number|null} contextWindow  Model capacity, when known.
 * @property {number|null} occupancy   used / contextWindow, 0..1+, null when unknown.
 * @property {number|null} headroomTokens Remaining tokens before the window is full.
 * @property {string} level            green | yellow | orange | red | unknown
 * @property {string} source           Which measurement fed `used`.
 */

/**
 * Compute a budget from whatever measurements are available.
 *
 * Priority for `used`: `projectedTokens` (what the next request would cost) ->
 * `pressureTokens` (newest provider-reported prompt size) -> `heuristicTokens`
 * (our own estimate). The first two come from DSH's own projections; the third
 * is the offline CLI fallback and is explicitly approximate.
 *
 * @param {object} input
 * @param {number} [input.projectedTokens]
 * @param {number} [input.pressureTokens]
 * @param {number} [input.heuristicTokens]
 * @param {number} [input.contextWindow]
 * @param {{yellow:number,orange:number,red:number}} [input.thresholds]
 * @returns {Budget}
 */
export function computeBudget(input = {}) {
  const { projectedTokens, pressureTokens, heuristicTokens, contextWindow, thresholds } = input

  let used = 0
  let source = 'none'
  if (Number.isFinite(projectedTokens)) {
    used = projectedTokens
    source = 'projected'
  } else if (Number.isFinite(pressureTokens)) {
    used = pressureTokens
    source = 'pressure'
  } else if (Number.isFinite(heuristicTokens)) {
    used = heuristicTokens
    source = 'heuristic'
  }

  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null
  const occupancy = window === null ? null : used / window
  const headroomTokens = window === null ? null : Math.max(0, window - used)

  return {
    used,
    contextWindow: window,
    occupancy,
    headroomTokens,
    level: levelFor(occupancy, thresholds),
    source,
  }
}

/**
 * Rough token estimate for onboarding a session file with no provider numbers.
 * Mirrors src/metrics.mjs: CJK ~1 char/token, Latin ~4 chars/token. Fine for a
 * band decision, never for billing.
 * @param {string} text
 * @returns {number}
 */
export function roughTokens(text) {
  if (!text) return 0
  const cjk = (text.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g) ?? []).length
  const latin = text.length - cjk
  return Math.round(cjk + latin / 4)
}

/** How much of the window has to fill before the next K requests would overflow. */
export function turnsToFull(occupancy, perTurnGrowth, thresholds = DEFAULT_THRESHOLDS) {
  if (!Number.isFinite(occupancy) || !Number.isFinite(perTurnGrowth) || perTurnGrowth <= 0) return null
  const remaining = Math.max(0, thresholds.red - occupancy)
  return Math.ceil(remaining / perTurnGrowth)
}

const BAND_LABEL = {
  green: '绿',
  yellow: '黄',
  orange: '橙',
  red: '红',
  unknown: '未知',
}

/**
 * Band -> colour for the client badge. Chosen for the light/dark chat surface:
 * a dot, not a word, so the band reads at a glance without adding text.
 * @type {Readonly<Record<string,string>>}
 */
export const BAND_COLOR = Object.freeze({
  green: '#22c55e',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
  unknown: '#9ca3af',
})

/** One-line hint per band, kept tiny: the badge lives in every turn's footer. */
const BAND_HINT = {
  green: '',
  yellow: '渐满',
  orange: '建议交接',
  red: '该交接了',
  unknown: '',
}

/**
 * The compact badge model — pure, so it can be unit-tested without React.
 *
 * The badge shows a colour dot (band) plus the occupancy percent; the action
 * hint only appears from yellow up, so a healthy session stays quiet. `title`
 * is the full sentence for hover. Nothing here touches a clock or a session.
 *
 * @param {Budget} budget
 * @param {object} [extra]
 * @param {number|null} [extra.turnsToRed] - Optional ETA to the red band.
 * @returns {{ level: string, color: string, pct: number|null, text: string, title: string }}
 */
export function formatBadge(budget, extra = {}) {
  const level = budget.level ?? 'unknown'
  const color = BAND_COLOR[level] ?? BAND_COLOR.unknown
  const pct = budget.occupancy === null || budget.occupancy === undefined ? null : Math.round(budget.occupancy * 100)
  const hint = BAND_HINT[level] ?? ''
  const parts = [pct === null ? '—' : `${pct}%`]
  if (hint !== '') parts.push(`· ${hint}`)
  const text = parts.join(' ')

  const detail = []
  if (pct !== null) detail.push(`上下文约 ${pct}%`)
  else detail.push('上下文占用未知')
  detail.push(`档位：${BAND_LABEL[level] ?? level}`)
  if (budget.headroomTokens !== null && budget.headroomTokens !== undefined) {
    detail.push(`剩余约 ${budget.headroomTokens} tokens`)
  }
  if (Number.isFinite(extra.turnsToRed)) detail.push(`约 ${extra.turnsToRed} 轮后到红档`)
  if (level === 'orange' || level === 'red') detail.push('用 /handoff 打包后再开新会话')

  return { level, color, pct, text, title: detail.join(' · ') }
}

/**
 * Human-readable budget summary lines (used by `/context-watch` and the CLI).
 * @param {Budget} budget
 * @param {object} [extra]
 * @param {number} [extra.perTurnGrowth]
 * @param {{seq:number,summary:string,shadowedSeqs:number[]}[]} [extra.compactions]
 * @param {number} [extra.now] - epoch ms, injected for testability; omit for none.
 * @returns {string[]}
 */
export function formatBudget(budget, extra = {}) {
  const lines = []
  const pct = budget.occupancy === null ? '未知' : `${Math.round(budget.occupancy * 100)}% (${budget.used} / ${budget.contextWindow})`
  lines.push(`上下文占用：${pct}   档位：${BAND_LABEL[budget.level] ?? budget.level}   数据来源：${budget.source}`)
  if (budget.headroomTokens !== null) {
    lines.push(`剩余空间：约 ${budget.headroomTokens} tokens`)
  }
  if (Number.isFinite(extra.perTurnGrowth) && budget.headroomTokens !== null) {
    if (budget.contextWindow) {
      // perTurnGrowth is in tokens; convert to a share of the window for the ETA.
      const frac = extra.perTurnGrowth / budget.contextWindow
      const t = turnsToFull(budget.occupancy, frac)
      lines.push(`增长速度：约 +${extra.perTurnGrowth} tokens/轮${t === null ? '' : `，约 ${t} 轮后到红档`}`)
    } else {
      lines.push(`增长速度：约 +${extra.perTurnGrowth} tokens/轮`)
    }
  }
  if (Array.isArray(extra.compactions) && extra.compactions.length > 0) {
    const last = extra.compactions[extra.compactions.length - 1]
    const reclaimed = last.shadowedSeqs.length > 0 ? `，回收 ${last.shadowedSeqs.length} 条历史` : ''
    lines.push(`上次压缩：seq ${last.seq}${reclaimed}`)
  }
  if (budget.level === 'orange' || budget.level === 'red') {
    lines.push('建议：用 /handoff 先把当前进度打包，再开新会话继续。')
  }
  return lines
}
