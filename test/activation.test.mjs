/**
 * Activation smoke test.
 *
 * The unit test fakes the context, so it cannot reproduce what cordis does at
 * activation. Two distinct failures were hit during development, and this file
 * reproduces both:
 *
 *   1. undeclared service  -> throws   "cannot get property X without inject"
 *   2. declared but absent -> hangs    "waiting for service: X"
 *
 * It also pins the lesson behind failure 2: `console` is a Node global, not a
 * harness service, so it must never appear in `inject`.
 *
 * Run: node test/activation.test.mjs
 */
import * as plugin from '../plugin/index.mjs'

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
 * A context that mimics cordis service access.
 *
 * `provided` lists services that exist; `injected` lists what the plugin
 * declared. Reading something provided but not injected throws; reading
 * something injected but not provided is reported as pending, which is what
 * makes a real entry hang forever.
 */
function gatedContext(injected, { withSection = true, provided = ['systemPrompt'] } = {}) {
  const calls = []
  const pending = []
  const services = {
    systemPrompt: withSection
      ? { section: (arg) => (calls.push(arg), () => {}) }
      : { getSectionOrder: () => 650 },
  }
  const allowed = new Set(injected)
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop in services) {
          if (!allowed.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
          return services[prop]
        }
        if (allowed.has(prop) && !provided.includes(prop)) {
          pending.push(prop)
          return undefined
        }
        return undefined
      },
    },
  )
  return { ctx, calls, pending }
}

/** Capture warnings without touching the real console. */
function captureWarnings(fn) {
  const original = globalThis.console.warn
  const seen = []
  globalThis.console.warn = (m) => seen.push(String(m))
  try {
    return { result: fn(), warnings: seen }
  } finally {
    globalThis.console.warn = original
  }
}

console.log('think-watch activation')

// 1. Activate exactly as the harness does.
{
  const injected = Array.isArray(plugin.inject) ? plugin.inject : []
  const { ctx, calls } = gatedContext(injected)
  let threw = null
  try {
    plugin.apply(ctx, {})
  } catch (e) {
    threw = e
  }
  check('activates with its own declared inject', threw === null, threw?.message)
  check('registers the rule on activation', calls.length === 1, `got ${calls.length}`)
}

// 2. The injection list itself. Every name here must be a real harness service;
//    a wrong name does not fail loudly, it hangs activation silently.
{
  const injected = Array.isArray(plugin.inject) ? plugin.inject : []
  check('declares systemPrompt', injected.includes('systemPrompt'), JSON.stringify(injected))
  check('does NOT declare console (a Node global, not a service)', !injected.includes('console'), JSON.stringify(injected))
  check('declares nothing extra', injected.length === 1, JSON.stringify(injected))
}

// 3. Failure mode 1: reading an undeclared service throws. The plugin guards
//    its reads, so simulate the raw access the guard protects against.
{
  const { ctx } = gatedContext([])
  let threw = null
  try {
    void ctx.systemPrompt
  } catch (e) {
    threw = e
  }
  check('undeclared access throws (gate is real)', threw !== null, 'gate did not fire - test is not trustworthy')
  check(
    'gate message matches the cordis wording',
    /cannot get property "systemPrompt" without inject/.test(String(threw?.message ?? '')),
    threw?.message,
  )
}

// 4. Degradation: no section() must warn via the global console, never throw.
{
  const injected = Array.isArray(plugin.inject) ? plugin.inject : []
  const { ctx } = gatedContext(injected, { withSection: false })
  let threw = null
  let warnings = []
  try {
    ;({ warnings } = captureWarnings(() => plugin.apply(ctx, {})))
  } catch (e) {
    threw = e
  }
  check('missing section() degrades without throwing', threw === null, threw?.message)
  check('missing section() warns exactly once', warnings.length === 1, `got ${warnings.length}`)
  check('warning mentions the plugin', String(warnings[0] ?? '').includes('think-watch'))
}

// 5. Nothing provided at all: quiet, no throw, nothing registered.
{
  const { ctx, calls } = gatedContext([], { provided: [] })
  let threw = null
  let warnings = []
  try {
    ;({ warnings } = captureWarnings(() => plugin.apply(ctx, {})))
  } catch (e) {
    threw = e
  }
  check('no services: degrades without throwing', threw === null, threw?.message)
  check('no services: registers nothing', calls.length === 0, `got ${calls.length}`)
  check('no services: still reports why', warnings.length === 1, `got ${warnings.length}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
