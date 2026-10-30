/**
 * Client badge: pure model + component-degradation tests.
 *
 * The client bundle (`plugin/client.js`) is a self-contained combo script that
 * talks to `window.__ModuleLoader__`. To test it without a browser we provide a
 * fake loader + fake `react`, load the file, and use the module it hands back.
 * We also assert the badge model it builds matches the host `formatBadge`, so
 * the two copies of the band math can never silently drift.
 *
 * Run: node test/client-badge.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { computeBudget, formatBadge, levelFor, BAND_COLOR } from '../src/budget.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'plugin', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks++
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`)
  }
}

/**
 * Load plugin/client.js under a fake module loader.
 * @returns {{ mod: any, registered: {def:any,comp:any}|null }}
 */
function loadClient() {
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      // A tiny hook: returns [value, setter] where setter records into a box.
      const box = { value: typeof initial === 'function' ? initial() : initial }
      const setter = (v) => {
        box.value = typeof v === 'function' ? v(box.value) : v
      }
      return [box.value, setter, box]
    },
  }
  let mod = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          mod = entry.factory((id) => {
            if (id === 'react') return react
            throw new Error('unexpected require: ' + id)
          })
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'plugin/client.js' })
  if (!mod) throw new Error('loader did not run')
  return { mod, react }
}

console.log('context-keeper client badge')

const { mod } = loadClient()
const badge = mod.__budgetBadge

// --- module shape ---
check('module name is context-keeper', mod.name === 'dsh-context-keeper')
check('injects slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))
check('injects remote (for the new-session button)', Array.isArray(mod.inject) && mod.inject.includes('remote'))
check('exposes apply()', typeof mod.apply === 'function')
check('exposes __budgetBadge for parity', typeof badge === 'function')

// --- core banding ---
check('null pressure -> null badge', badge(undefined) === null)
check('no numbers -> null badge', badge({ contextWindow: 1000 }) === null)
check('no window -> null badge', badge({ projectedTokens: 500 }) === null)

const green = badge({ projectedTokens: 1000, contextWindow: 10000 })
check('green at 10%', green && green.level === 'green', JSON.stringify(green))
check('green dot colour', green && green.color === BAND_COLOR.green)
check('green text is just the pct', green && green.text === '10%')
check('green has no action hint in title', green && !green.title.includes('/handoff'))

const yellow = badge({ projectedTokens: 5500, contextWindow: 10000 })
check('yellow at 55%', yellow && yellow.level === 'yellow')
check('yellow shows the 渐满 hint', yellow && yellow.text.includes('渐满'))

const orange = badge({ projectedTokens: 7000, contextWindow: 10000 })
check('orange at 70%', orange && orange.level === 'orange')
check('orange title recommends /handoff', orange && orange.title.includes('/handoff'))

const red = badge({ projectedTokens: 8500, contextWindow: 10000 })
check('red at 85%', red && red.level === 'red')
check('red dot colour', red && red.color === BAND_COLOR.red)

// --- projectedTokens wins over pressureTokens ---
const preferProjected = badge({ projectedTokens: 9000, pressureTokens: 100, contextWindow: 10000 })
check('projectedTokens wins', preferProjected && preferProjected.level === 'red')

const usePressure = badge({ pressureTokens: 7000, contextWindow: 10000 })
check('pressureTokens fallback', usePressure && usePressure.level === 'orange')

// --- parity with the host formatBadge across a grid (spans all bands) ---
const grid = [0, 100, 1000, 4999, 5000, 6000, 6499, 6500, 7500, 7999, 8000, 9500, 12000]
let parityFail = null
for (const used of grid) {
  const b = computeBudget({ projectedTokens: used, contextWindow: 10000 })
  const host = formatBadge(b)
  const client = badge({ projectedTokens: used, contextWindow: 10000 })
  if (!client) {
    parityFail = `null at ${used}`
    break
  }
  if (client.level !== host.level) parityFail = `level ${client.level} != ${host.level} @${used}`
  else if (client.pct !== host.pct) parityFail = `pct ${client.pct} != ${host.pct} @${used}`
  else if (client.text !== host.text) parityFail = `text "${client.text}" != "${host.text}" @${used}`
  else if (client.color !== host.color) parityFail = `color @${used}`
  if (parityFail) break
}
check('client badge matches host formatBadge on a 13-point grid', parityFail === null, parityFail || '')

// --- level parity across threshold edges (0.5 / 0.65 / 0.8) ---
let levelFail = null
for (const occ of [0, 0.49, 0.5, 0.64, 0.65, 0.79, 0.8, 1.2]) {
  const b = computeBudget({ projectedTokens: occ * 10000, contextWindow: 10000 })
  const hostLevel = levelFor(b.occupancy)
  const client = badge({ projectedTokens: occ * 10000, contextWindow: 10000 })
  if (!client || client.level !== hostLevel) {
    levelFail = `occ=${occ} client=${client && client.level} expected=${hostLevel}`
    break
  }
}
check('level parity across threshold edges', levelFail === null, levelFail || '')

// --- component mounting via apply: both seats register ---
const registered = new Map()
const ctx = {
  slots: {
    inject: (name, cb) => cb(),
    register: (def, comp) => {
      registered.set(def.name, { def, comp })
      return () => {}
    },
  },
  remote: undefined,
}
mod.apply(ctx)
const turnTail = registered.get('conversation.chat.turnTail')
const composerDock = registered.get('conversation.composer.dock')
check('apply registers the turnTail badge', turnTail?.def?.id === 'context-keeper-badge')
check('apply registers the composer.dock reminder', composerDock?.def?.id === 'context-keeper-reminder')

const Badge = turnTail.comp
check('no useProjection -> renders null', Badge({}) === null)
check('useProjection throws -> renders null', Badge({ useProjection: () => { throw new Error('boom') } }) === null)
check('unknown occupancy -> renders null', Badge({ useProjection: () => ({}) }) === null)

const node = Badge({ useProjection: () => ({ projectedTokens: 7000, contextWindow: 10000 }) })
check('renders a node when occupancy known', node && node.type === 'span')
check('node carries the band as data attr', node && node.props['data-context-keeper-badge'] === 'orange')
const dot = node?.children?.[0]
check('dot uses the band colour', dot && dot.props.style.background === BAND_COLOR.orange)

// --- reminder helpers ---
const shouldRemind = mod.__shouldRemind
check('shouldRemind false below orange', shouldRemind(0.6) === false)
check('shouldRemind true at orange boundary', shouldRemind(0.65) === true)
check('shouldRemind true at red', shouldRemind(0.9) === true)
check('shouldRemind false for null', shouldRemind(null) === false)

const folder = mod.__handoffFolder
check('handoffFolder joins cwd', folder('H:\\Proj').endsWith('.context-keeper\\handoff'), folder('H:\\Proj'))
check('handoffFolder strips trailing slash', folder('H:\\Proj\\').endsWith('Proj\\.context-keeper\\handoff'), folder('H:\\Proj\\'))
check('handoffFolder default when empty', folder('') === '.context-keeper/handoff')

const promptText = mod.__continuationPrompt
check('continuationPrompt mentions folder', promptText('H:\\Proj\\.context-keeper\\handoff').includes('\.context-keeper\\handoff'))
check('continuationPrompt forbids archive', promptText('X').includes('.archive.md'))

// --- ReminderPanel: gating + new-session flow ---
const Panel = composerDock.comp
// Below orange -> hidden
check('panel hidden at green', Panel({ useProjection: () => ({ projectedTokens: 1000, contextWindow: 10000 }), sessionId: 's' }) === null)
// Orange but no remote -> renders panel (button will error on click, not throw)
const panelNode = Panel({ useProjection: () => ({ projectedTokens: 7000, contextWindow: 10000 }), sessionId: 's', remote: undefined })
check('panel shown at orange', panelNode && panelNode.type === 'div')
check('panel carries the band attr', panelNode && panelNode.props['data-context-keeper-reminder'] === 'orange')
check('panel explains the band', String(panelNode.children[1].children).includes('70%'))

// Full flow: click the button, ensure create+prompt are called with the folder.
{
  const calls = []
  const remote = {
    session: {
      async create(opts) {
        calls.push(['create', opts])
        return { ok: true, value: { sessionId: 'new-1' } }
      },
      async prompt(payload) {
        calls.push(['prompt', payload])
        return { ok: true }
      },
    },
  }
  const p = Panel({
    useProjection: () => ({ projectedTokens: 8000, contextWindow: 10000 }),
    sessionId: 's',
    cwd: 'H:\\Proj',
    remote,
  })
  // children: [dot, span(message), button]
  const button = p.children.find((c) => c && c.type === 'button')
  check('panel renders a button', !!button)
  button.props.onClick()
  // Give the fire-and-forget microtask a tick.
  await new Promise((r) => setTimeout(r, 5))
  check('click calls session.create with cwd', calls[0] && calls[0][0] === 'create' && calls[0][1].cwd === 'H:\\Proj')
  check('click calls session.prompt on the new id', calls[1] && calls[1][0] === 'prompt' && calls[1][1].sessionId === 'new-1')
  const text = calls[1] && calls[1][1].content[0].text
  check('prompt points at the handoff folder', typeof text === 'string' && text.includes('.context-keeper\\handoff'))
}

// No remote -> clicking sets error state, never throws
{
  const p = Panel({ useProjection: () => ({ projectedTokens: 8000, contextWindow: 10000 }), sessionId: 's' })
  const button = p.children.find((c) => c && c.type === 'button')
  let threwClick = false
  try {
    button.props.onClick()
  } catch {
    threwClick = true
  }
  check('click without remote does not throw', threwClick === false)
}

// --- apply with no slots service never throws ---
let threw = false
try {
  mod.apply({})
  mod.apply(null)
  mod.apply({ slots: {} })
} catch {
  threw = true
}
check('apply degrades without slots (no throw)', threw === false)

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
