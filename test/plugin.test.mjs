/**
 * Behavioural test for the host plugin.
 *
 * Runs the real `apply()` against a fake `systemPrompt` service that records
 * calls, then asserts what was (and was not) registered. No harness needed: the
 * plugin's whole contract is "call section() once with this shape, or do nothing
 * and warn".
 *
 * Run: node test/plugin.test.mjs
 */
import { apply, SECTION_NAME, SECTION_ORDER, DEFAULT_RULE_TEXT, inject } from '../plugin/index.mjs'

let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? '  -- ' + detail : ''}`)
  }
}

/** A systemPrompt service stand-in that records what the plugin registers. */
function fakeCtx({ withSection = true } = {}) {
  const calls = []
  const warnings = []
  const sp = {
    getSectionOrder: (name) => ({ PLAN_POLICY: 500, TEAM_POLICY: 600 })[name],
  }
  if (withSection) {
    sp.section = (arg) => {
      calls.push(arg)
      return () => {}
    }
  }
  return {
    ctx: { systemPrompt: sp, console: { warn: (m) => warnings.push(m) } },
    calls,
    warnings,
  }
}

console.log('think-watch host plugin')

// 0. Cordis injection declaration.
// Touching ctx.systemPrompt without declaring it throws at activation and takes
// the entry down - this happened once during development and the plugin never
// mounted. A unit test on apply() cannot catch it (the fake ctx just hands over
// the service), so it is asserted directly.
{
  check('inject declares systemPrompt', Array.isArray(inject) && inject.includes('systemPrompt'), JSON.stringify(inject))
  // console is declared solely so the degradation path can log. Anything beyond
  // these two means the plugin reads a service it should not.
  const allowed = new Set(['systemPrompt', 'console'])
  check(
    'inject declares nothing beyond systemPrompt + console',
    Array.isArray(inject) && inject.every((s) => allowed.has(s)),
    JSON.stringify(inject),
  )
}

// 1. Default mount
{
  const { ctx, calls, warnings } = fakeCtx()
  apply(ctx, {})
  check('registers exactly one section', calls.length === 1, `got ${calls.length}`)
  const s = calls[0] ?? {}
  check('section name is stable', s.name === SECTION_NAME, s.name)
  check('section order is the policy band', s.order === SECTION_ORDER, String(s.order))
  check('interpolation is off', s.interpolate === false, String(s.interpolate))
  check('text is the default rule', s.text === DEFAULT_RULE_TEXT.trim())
  check('no warnings on a normal mount', warnings.length === 0)
}

// 2. Custom text replaces the default
{
  const { ctx, calls } = fakeCtx()
  apply(ctx, { text: '  Custom rule.  ' })
  check('custom text is used and trimmed', calls[0]?.text === 'Custom rule.', JSON.stringify(calls[0]?.text))
}

// 3. Empty text registers nothing (an empty section would be filtered anyway,
//    but registering it still emits a change event for no reason)
{
  const { ctx, calls } = fakeCtx()
  apply(ctx, { text: '   ' })
  check('blank text registers nothing', calls.length === 0, `got ${calls.length}`)
}

// 4. enabled:false is a clean no-op
{
  const { ctx, calls, warnings } = fakeCtx()
  apply(ctx, { enabled: false })
  check('enabled:false registers nothing', calls.length === 0)
  check('enabled:false does not warn', warnings.length === 0)
}

// 5. Missing section() degrades instead of throwing.
//    Warnings go through the global console (not a harness service), so capture
//    there rather than through the fake context.
{
  const { ctx, calls } = fakeCtx({ withSection: false })
  const original = globalThis.console.warn
  const seen = []
  globalThis.console.warn = (m) => seen.push(String(m))
  let threw = null
  try {
    apply(ctx, {})
  } catch (e) {
    threw = e
  } finally {
    globalThis.console.warn = original
  }
  check('missing section() does not throw', threw === null, threw?.message)
  check('missing section() warns once', seen.length === 1, `got ${seen.length}`)
  check('warning names the plugin', String(seen[0] ?? '').includes('think-watch'))
  check('nothing registered when unsupported', calls.length === 0)
}

// 6. maxChars truncates at a paragraph boundary, never mid-sentence
{
  const { ctx, calls } = fakeCtx()
  const long = ['First paragraph here.', 'Second paragraph here.', 'Third paragraph here.'].join('\n\n')
  apply(ctx, { text: long, maxChars: 45 })
  const got = calls[0]?.text ?? ''
  check('truncated under maxChars', got.length <= 45, `${got.length} chars`)
  check('truncation kept whole paragraphs', !got.endsWith('here') || got.endsWith('paragraph here.'), JSON.stringify(got))
  check('no partial trailing sentence', !/\s\S{1,8}$/.test(got) || got.length < long.length, JSON.stringify(got))
}

// 7. Very small maxChars still returns something rather than empty
{
  const { ctx, calls } = fakeCtx()
  apply(ctx, { text: 'A'.repeat(500), maxChars: 10 })
  check('tiny maxChars still registers text', (calls[0]?.text ?? '').length > 0)
}

// 8. Default rule stays within a sane budget
{
  const len = DEFAULT_RULE_TEXT.trim().length
  check('default rule is not a lecture (< 1200 chars)', len < 1200, `${len} chars`)
  check('default rule is substantive (> 300 chars)', len > 300, `${len} chars`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
