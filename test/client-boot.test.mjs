/**
 * Boot-level smoke for the CLIENT bundle: simulate the real module loader and a
 * strict React, mount both seats, and drive the reminder's new-session flow.
 *
 * This is stronger than the unit test: it uses a React whose `useState` setter
 * triggers a synchronous re-render (like the real dispatcher), so a render that
 * sets state unconditionally would loop. A hard time budget turns any such loop
 * into a failure instead of a hang.
 *
 * Run: node test/client-boot.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'plugin', 'client.js'), 'utf8')

let failures = 0
let checks = 0
function check(label, cond, detail = '') {
  checks++
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`)
  }
}

/**
 * A minimal React that renders a component function by calling it and, for
 * `useState`, returns a live cell whose setter re-invokes the component once
 * (bounded) — emulating a re-render without a scheduler.
 */
function makeReact() {
  const hooks = []
  let cursor = 0
  let rerender = null

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = hooks[i]
      const set = (v) => {
        cell.value = typeof v === 'function' ? v(cell.value) : v
        if (rerender) rerender()
      }
      return [cell.value, set]
    },
  }
  return {
    react,
    reset() {
      cursor = 0
    },
    onRerender(fn) {
      rerender = fn
    },
  }
}

/** Load the client bundle under the fake loader. */
function load() {
  const h = makeReact()
  let mod = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (e) => { mod = e.factory((id) => (id === 'react' ? h.react : (() => { throw new Error('require ' + id) })())) } } },
    console,
    setTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'plugin/client.js' })
  if (!mod) throw new Error('loader did not run')
  return { mod, h }
}

console.log('context-keeper client boot')

const { mod, h } = load()

// ---- register both seats through a fake ctx ----
const seats = new Map()
mod.apply({
  slots: {
    inject: (_n, cb) => cb(),
    register: (def, comp) => {
      seats.set(def.name + ':' + def.id, { def, comp })
      return () => {}
    },
  },
  remote: { session: { create: async () => ({ ok: true, value: { sessionId: 'new-9' } }), prompt: async () => ({ ok: true }) } },
})

check('badge seat registered', [...seats.keys()].some((k) => k.startsWith('conversation.chat.turnTail')))
check('reminder seat registered', [...seats.keys()].some((k) => k.startsWith('conversation.composer.dock')))

const badgeSeat = [...seats.values()].find((s) => s.def.name === 'conversation.chat.turnTail')
const dockSeat = [...seats.values()].find((s) => s.def.name === 'conversation.composer.dock')

function render(comp, props, budgetMs = 400) {
  // Guard against a runaway re-render: cap total render invocations.
  let renders = 0
  let out = null
  h.reset()
  h.onRerender(() => {
    renders++
    if (renders > 50) throw new Error('render loop (state set every render)')
    h.reset()
    out = comp(props)
  })
  const start = Date.now()
  out = comp(props)
  return { out, renders, ms: Date.now() - start }
}

// ---- badge renders at orange, degrades cleanly ----
{
  const { out } = render(badgeSeat.comp, { useProjection: () => ({ projectedTokens: 7000, contextWindow: 10000 }) })
  check('badge renders a span', out && out.type === 'span')
  check('badge orange attr', out && out.props['data-context-keeper-badge'] === 'orange')
}
{
  const { out } = render(badgeSeat.comp, {})
  check('badge null without seat props', out === null)
}

// ---- reminder hidden below orange, shown at orange, click drives flow ----
{
  const { out } = render(dockSeat.comp, { useProjection: () => ({ projectedTokens: 1000, contextWindow: 10000 }), sessionId: 's' })
  check('reminder hidden at green', out === null)
}
{
  const calls = []
  const remote = {
    session: {
      create: async (o) => { calls.push(['create', o]); return { ok: true, value: { sessionId: 'new-9' } } },
      prompt: async (p) => { calls.push(['prompt', p]); return { ok: true } },
    },
  }
  const { out } = render(dockSeat.comp, {
    useProjection: () => ({ projectedTokens: 7000, contextWindow: 10000 }),
    sessionId: 's',
    cwd: 'H:\\Proj',
    useSessions: (fn) => fn({ byId: { s: { cwd: 'H:\\Proj' } } }),
    remote,
  })
  check('reminder shown at orange', out && out.type === 'div')
  check('reminder explains 70%', String(out.children[1].children).includes('70%'))
  const button = out.children.find((c) => c && c.type === 'button')
  check('reminder has a button', !!button)
  button.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
  check('create called with cwd', calls[0] && calls[0][1].cwd === 'H:\\Proj', JSON.stringify(calls[0]))
  check('prompt called on new id', calls[1] && calls[1][1].sessionId === 'new-9', JSON.stringify(calls[1] && calls[1][1]))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
