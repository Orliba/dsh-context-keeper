/**
 * dsh-context-keeper — 客户端半（P3：上下文徽章 + 提醒）。
 *
 * 两个座位：
 *   ① conversation.chat.turnTail —— 每轮回复末尾的色块徽章，读官方
 *      contextPressure 投影，按绿/黄/橙/红显示占用百分比，不进模型输入。
 *   ② conversation.composer.dock —— 仅橙/红档出现的提醒气泡，带「开新会话」
 *      按钮：走客户端 Remote session.create + session.prompt，在同一工作区
 *      新建会话并投喂"读最新交接包接着做"的指令（不内联正文，省 token）。
 *
 * 已知边界：思考块上方无扩展座位（徽章落在回复末尾）；插槽无导航，新建后需
 * 自己点开新会话；命令名只能小写。
 *
 * 客户端插件经 window.__ModuleLoader__.load({id, factory}) 加载，只依赖 react；
 * 所有数据读取都做了防御，无投影时静默不渲染。
 */

// 档位常量（阈值与宿主 src/budget.mjs 一致）
const BAND_LABEL = { green: '绿', yellow: '黄', orange: '橙', red: '红', unknown: '未知' }
const BAND_COLOR = { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444', unknown: '#9ca3af' }
const BAND_HINT = { green: '', yellow: '渐满', orange: '建议交接', red: '该交接了', unknown: '' }
const THRESHOLDS = { yellow: 0.5, orange: 0.65, red: 0.8 }

/** 占用率落在哪一档；非数字返回 unknown。 */
function levelFor(occupancy) {
  if (!Number.isFinite(occupancy)) return 'unknown'
  if (occupancy >= THRESHOLDS.red) return 'red'
  if (occupancy >= THRESHOLDS.orange) return 'orange'
  if (occupancy >= THRESHOLDS.yellow) return 'yellow'
  return 'green'
}

/**
 * contextPressure → 徽章模型；无可用占用返回 null。
 * 取值优先级 projected > pressure，等价宿主 computeBudget + formatBadge。
 * @param {{pressureTokens?:number, projectedTokens?:number, contextWindow?:number}} [pressure]
 * @returns {{level:string,color:string,pct:number|null,text:string,title:string}|null}
 */
function budgetBadge(pressure) {
  const p = pressure && typeof pressure === 'object' ? pressure : {}
  let used = 0
  if (Number.isFinite(p.projectedTokens)) used = p.projectedTokens
  else if (Number.isFinite(p.pressureTokens)) used = p.pressureTokens
  else return null
  const window = Number.isFinite(p.contextWindow) && p.contextWindow > 0 ? p.contextWindow : null
  if (window === null) return null
  const occupancy = used / window
  const level = levelFor(occupancy)
  const headroom = Math.max(0, window - used)
  const pct = Math.round(occupancy * 100)
  const hint = BAND_HINT[level] ?? ''
  const text = hint === '' ? `${pct}%` : `${pct}% · ${hint}`
  const detail = [`上下文约 ${pct}%`, `档位：${BAND_LABEL[level] ?? level}`, `剩余约 ${headroom} tokens`]
  if (level === 'orange' || level === 'red') detail.push('用 /handoff 打包后再开新会话')
  return { level, color: BAND_COLOR[level] ?? BAND_COLOR.unknown, pct, text, title: detail.join(' · ') }
}

/** 到橙档才提醒（气泡 + 按钮仅在橙/红出现）。 */
function shouldRemind(occupancy) {
  return typeof occupancy === 'number' && Number.isFinite(occupancy) && occupancy >= THRESHOLDS.orange
}

/**
 * 新会话的续接指令。不内联交接包正文（省 token），只指向目录让新会话自读。
 * @param {string} folder - 交接包目录
 * @returns {string}
 */
function continuationPrompt(folder) {
  const dir = typeof folder === 'string' && folder.trim() !== '' ? folder.trim() : '.context-keeper/handoff'
  return `接着上次的工作继续。交接包在 ${dir}，请先读其中最新的一份（按文件名时间戳排序取最后一个 .md，不要读 .archive.md），按第 1 节和第 6 节接上进度，再继续。`
}

const DOT = {
  width: '8px',
  height: '8px',
  borderRadius: '9999px',
  display: 'inline-block',
  flex: '0 0 auto',
}
const ROOT = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '12px',
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
  whiteSpace: 'nowrap',
}
const PANEL = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  fontSize: '12px',
  lineHeight: '18px',
  padding: '4px 10px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #3a3a3a)',
  color: 'var(--dsw-alias-label-secondary, #b8bcc4)',
}
const BTN = {
  fontSize: '12px',
  lineHeight: '18px',
  padding: '1px 10px',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l3, #4a4a4a)',
  background: 'var(--dsw-alias-button-elevated-fill, transparent)',
  color: 'var(--dsw-alias-label-primary, #e6e8eb)',
  cursor: 'pointer',
}

window.__ModuleLoader__.load({
  id: 'dsh-context-keeper',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')

    /** 徽章：无投影座位或占用未知则不渲染，读取异常一律吞掉。 */
    function StewardBadge(props) {
      const useProjection = props && props.useProjection
      if (typeof useProjection !== 'function') return null
      let pressure
      try {
        pressure = useProjection('contextPressure')
      } catch {
        return null
      }
      const badge = budgetBadge(pressure)
      if (badge === null) return null
      return react.createElement(
        'span',
        { style: ROOT, title: badge.title, 'data-context-keeper-badge': badge.level },
        react.createElement('span', { style: { ...DOT, background: badge.color }, 'aria-hidden': 'true' }),
        react.createElement('span', null, badge.text),
      )
    }

    /** 提醒气泡：仅橙/红档出现，含「开新会话」按钮；切换需用户自己点。 */
    function ReminderPanel(props) {
      const useProjection = props && props.useProjection
      const reactUseState = react.useState
      // 无座位/无 hook 时一个 hook 都不调，直接不渲染。
      if (typeof useProjection !== 'function' || typeof reactUseState !== 'function') return null

      // 先把 hook 按固定顺序调完，再做判断。
      let pressure
      try {
        pressure = useProjection('contextPressure')
      } catch {
        pressure = undefined
      }
      // 尽力取 cwd，用于新建到同一个工作区（hook 有无在座位上稳定）。
      let cwd = props.cwd
      if (typeof props.useSessions === 'function') {
        try {
          cwd = cwd || props.useSessions((s) => (s && s.byId ? s.byId[props.sessionId]?.cwd : undefined))
        } catch {
          /* 拿不到就退回 props.cwd */
        }
      }
      const state = reactUseState('idle') // idle | busy | done | error
      const status = state[0]
      const setStatus = state[1]

      // hook 调完后判断是否显示。
      const badge = budgetBadge(pressure)
      if (badge === null || !shouldRemind(badge.pct === null ? null : badge.pct / 100)) return null

      const onNewSession = () => {
        const sessionId = props.sessionId
        const remote = props.remote
        if (typeof sessionId !== 'string' || sessionId === '') {
          setStatus('error')
          return
        }
        if (!remote || !remote.session || typeof remote.session.create !== 'function' || typeof remote.session.prompt !== 'function') {
          setStatus('error')
          return
        }
        setStatus('busy')
        // 异步发送，异常不外泄到渲染树。
        ;(async () => {
          try {
            const created = await remote.session.create(cwd ? { cwd } : {})
            const newId = created && created.ok && created.value ? created.value.sessionId : undefined
            if (typeof newId !== 'string' || newId === '') {
              setStatus('error')
              return
            }
            const folder = handoffFolder(cwd)
            await remote.session.prompt({
              requestId: (globalThis.crypto && globalThis.crypto.randomUUID && globalThis.crypto.randomUUID()) || String(Date.now()),
              sessionId: newId,
              mode: 'transcript',
              content: [{ type: 'text', text: continuationPrompt(folder) }],
            })
            setStatus('done')
          } catch {
            setStatus('error')
          }
        })()
      }

      const message =
        status === 'done'
          ? '已新建会话并放好交接指令；在左侧点开那条新会话即可继续。'
          : status === 'error'
            ? '没能自动新建，可手动开新会话，再粘一句「读 .context-keeper/handoff 最新包接着做」。'
            : `上下文 ${badge.pct}% · ${BAND_LABEL[badge.level] ?? badge.level}，建议先 /handoff 打包，再开新会话继续。`

      return react.createElement(
        'div',
        { style: PANEL, 'data-context-keeper-reminder': badge.level },
        react.createElement('span', { style: { ...DOT, background: badge.color }, 'aria-hidden': 'true' }),
        react.createElement('span', null, message),
        status === 'idle' || status === 'busy'
          ? react.createElement(
              'button',
              { type: 'button', style: BTN, disabled: status === 'busy', onClick: onNewSession },
              status === 'busy' ? '新建中…' : '开新会话',
            )
          : null,
      )
    }

    /** 交接包目录，与宿主 /handoff 落点一致：<cwd>/.context-keeper/handoff。 */
    function handoffFolder(cwd) {
      const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim().replace(/[\\/]+$/, '') : ''
      if (base === '') return '.context-keeper/handoff'
      return `${base}\\.context-keeper\\handoff`
    }

    /** 挂载：徽章挂回复末尾，提醒气泡挂输入框下沿；无 slots 服务时静默降级。 */
    function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
      // remote 可选，拿不到只影响按钮（退化为手动开新会话）。
      let remote
      try {
        remote = ctx.remote
      } catch {
        remote = undefined
      }
      // ① 回复末尾：色块徽章。
      slots.inject('conversation.chat.turnTail', () =>
        slots.register(
          { name: 'conversation.chat.turnTail', id: 'context-keeper-badge', order: 20 },
          StewardBadge,
        ),
      )
      // ② 输入框下沿：橙/红档提醒 +「开新会话」按钮。
      slots.inject('conversation.composer.dock', () =>
        slots.register(
          { name: 'conversation.composer.dock', id: 'context-keeper-reminder', order: 20, inject: () => ({ remote }) },
          ReminderPanel,
        ),
      )
    }

    module.exports = { name: 'dsh-context-keeper', inject: ['slots', 'remote'], apply }
    // 仅供测试引用，加载器会忽略。
    module.exports.__budgetBadge = budgetBadge
    module.exports.__shouldRemind = shouldRemind
    module.exports.__continuationPrompt = continuationPrompt
    module.exports.__handoffFolder = handoffFolder
    module.exports.__ReminderPanel = ReminderPanel
    return module.exports
  },
})
