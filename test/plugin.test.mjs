/**
 * Behavioural test for the host plugin (v3).
 *
 * Runs the real `apply()` against fake `systemPrompt` + `commands` services that
 * record calls, then asserts what was (and was not) registered. No harness
 * needed.
 *
 * Run: node test/plugin.test.mjs
 */
import {
  apply,
  SECTION_NAME,
  SECTION_NAME_BUDGET,
  SECTION_ORDER,
  SECTION_ORDER_BUDGET,
  DEFAULT_RULE_TEXT,
  DEFAULT_BUDGET_NUDGE,
  inject,
} from '../plugin/index.mjs'

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

/** A fake ctx recording section registrations and command registrations. */
function fakeCtx({ withSection = true, withCommands = true } = {}) {
  const sections = []
  const commands = []
  const warnings = []
  const sp = {}
  if (withSection) {
    sp.section = (arg) => {
      sections.push(arg)
      return () => {}
    }
  }
  const cmd = withCommands
    ? {
        register: (def) => {
          commands.push(def)
          return () => {}
        },
      }
    : undefined
  return {
    ctx: { systemPrompt: sp, commands: cmd, console: { warn: (m) => warnings.push(m) } },
    sections,
    commands,
    warnings,
  }
}

/** Run apply while capturing global console.warn (for the degradation paths). */
function withCapturedWarnings(fn) {
  const original = globalThis.console.warn
  const seen = []
  globalThis.console.warn = (m) => seen.push(String(m))
  try {
    fn()
  } finally {
    globalThis.console.warn = original
  }
  return seen
}

console.log('context-keeper host plugin (v3)')

// 0. Injection declaration.
{
  check('inject declares systemPrompt', inject.includes('systemPrompt'), JSON.stringify(inject))
  check('inject declares commands', inject.includes('commands'), JSON.stringify(inject))
  const allowed = new Set(['systemPrompt', 'commands'])
  check('inject declares nothing beyond systemPrompt + commands', inject.every((s) => allowed.has(s)), JSON.stringify(inject))
}

// 1. Default mount registers two static sections and two commands.
{
  const { ctx, sections, commands, warnings } = fakeCtx()
  apply(ctx, {})
  check('registers two sections', sections.length === 2, `got ${sections.length}`)
  const reason = sections.find((s) => s.name === SECTION_NAME)
  const budget = sections.find((s) => s.name === SECTION_NAME_BUDGET)
  check('reason section present', !!reason)
  check('reason order is the policy band', reason?.order === SECTION_ORDER, String(reason?.order))
  check('reason interpolation off', reason?.interpolate === false)
  check('reason text is the default rule', reason?.text === DEFAULT_RULE_TEXT.trim())
  check('budget nudge present', !!budget)
  check('budget order sits just after reason', budget?.order === SECTION_ORDER_BUDGET, String(budget?.order))
  check('budget nudge is static text', budget?.text === DEFAULT_BUDGET_NUDGE)
  check('no numbers in the nudge (cache safety)', !/\d/.test(DEFAULT_BUDGET_NUDGE), DEFAULT_BUDGET_NUDGE)

  const names = commands.map((c) => c.name).sort()
  check('registers context-watch command', names.includes('context-watch'), JSON.stringify(names))
  check('registers handoff command', names.includes('handoff'), JSON.stringify(names))
  check('command handlers are functions', commands.every((c) => typeof c.handler === 'function'))
  // 说明行显示在 `/` 菜单里，改成中文，且命令名保持小写（DSH 限制）。
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]))
  const hasCJK = (s) => /[\u4e00-\u9fff]/.test(String(s))
  check('context-watch description is Chinese', hasCJK(byName['context-watch'].description), byName['context-watch'].description)
  check('handoff description is Chinese', hasCJK(byName['handoff'].description), byName['handoff'].description)
  check('descriptions are non-empty', commands.every((c) => typeof c.description === 'string' && c.description.trim() !== ''))
  check('command names stay lowercase', commands.every((c) => /^[a-z][a-z0-9_-]*$/.test(c.name)), JSON.stringify(names))
  check('no warnings on a normal mount', warnings.length === 0, JSON.stringify(warnings))
}

// 2. contextNudge:false drops the budget section.
{
  const { ctx, sections } = fakeCtx()
  apply(ctx, { contextNudge: false })
  check('nudge off registers one section', sections.length === 1, `got ${sections.length}`)
  check('the remaining section is the rule', sections[0]?.name === SECTION_NAME)
}

// 3. commands:false drops both commands but keeps sections.
{
  const { ctx, sections, commands } = fakeCtx()
  apply(ctx, { commands: false })
  check('commands off registers no commands', commands.length === 0, `got ${commands.length}`)
  check('commands off still registers sections', sections.length === 2)
}

// 4. Custom text replaces the default rule (nudge unaffected).
{
  const { ctx, sections } = fakeCtx()
  apply(ctx, { text: '  Custom rule.  ' })
  const reason = sections.find((s) => s.name === SECTION_NAME)
  check('custom text is used and trimmed', reason?.text === 'Custom rule.', JSON.stringify(reason?.text))
}

// 5. enabled:false is a clean no-op.
{
  const { ctx, sections, commands, warnings } = fakeCtx()
  apply(ctx, { enabled: false })
  check('enabled:false registers nothing', sections.length === 0 && commands.length === 0)
  check('enabled:false does not warn', warnings.length === 0)
}

// 6. Missing section() degrades: warns once, still registers commands.
{
  const { ctx, commands } = fakeCtx({ withSection: false })
  let threw = null
  const seen = withCapturedWarnings(() => {
    try {
      apply(ctx, {})
    } catch (e) {
      threw = e
    }
  })
  check('missing section() does not throw', threw === null, threw?.message)
  check('missing section() warns once', seen.length === 1, `got ${seen.length}`)
  check('warning names the plugin', String(seen[0] ?? '').includes('context-keeper'))
  check('commands still registered without section()', commands.length === 2, `got ${commands.length}`)
}

// 7. Missing commands degrades: warns once, still registers sections.
{
  const { ctx, sections } = fakeCtx({ withCommands: false })
  const seen = withCapturedWarnings(() => apply(ctx, {}))
  check('missing commands warns once', seen.length === 1, `got ${seen.length}`)
  check('sections still registered without commands', sections.length === 2)
}

// 8. maxChars truncates the rule at a paragraph boundary.
{
  const { ctx, sections } = fakeCtx()
  const long = ['First paragraph here.', 'Second paragraph here.', 'Third paragraph here.'].join('\n\n')
  apply(ctx, { text: long, maxChars: 45 })
  const reason = sections.find((s) => s.name === SECTION_NAME)
  check('truncated under maxChars', (reason?.text ?? '').length <= 45, `${(reason?.text ?? '').length} chars`)
}

// 9. Default rule stays within a sane budget.
{
  const len = DEFAULT_RULE_TEXT.trim().length
  check('default rule is not a lecture (< 1200 chars)', len < 1200, `${len} chars`)
  check('default rule is substantive (> 300 chars)', len > 300, `${len} chars`)
  check('nudge is short (< 400 chars)', DEFAULT_BUDGET_NUDGE.length < 400, `${DEFAULT_BUDGET_NUDGE.length} chars`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
