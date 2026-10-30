/**
 * End-to-end prompt assembly test.
 *
 * Does not trust the plugin's claim that it registered something. Mounts the
 * plugin, then runs the *real* `renderPrompt` implementation lifted out of this
 * installation's `@deepseek-ai/dsh-system-prompt` bundle, and reads the result.
 *
 * Why this is separate from the unit test: a fake `systemPrompt` only proves the
 * argument shape. It cannot prove the text survives section ordering, empty
 * filtering, and rendering - which is exactly where a plugin that "looks fine"
 * can still contribute nothing to the model.
 *
 * Run: node test/e2e-prompt.test.mjs
 *   SYSTEM_PROMPT_PKG  path to the extracted package root (default: ../_asar_probe/pkgs/system-prompt)
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, SECTION_ORDER, DEFAULT_RULE_TEXT, DEFAULT_BUDGET_NUDGE } from '../plugin/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PKG = process.env.SYSTEM_PROMPT_PKG ?? join(here, '..', '..', '_asar_probe', 'pkgs', 'system-prompt')

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

console.log('context-keeper end-to-end prompt assembly')

const entry = join(PKG, 'lib', 'index.js')
check('extracted system-prompt bundle present', existsSync(entry), entry)
if (!existsSync(entry)) {
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(1)
}

const source = readFileSync(entry, 'utf8')
console.log('  bundle size:', source.length, 'chars')

// Lift the shipped implementation rather than paraphrasing it.
const ordersMatch = source.match(/const SECTION_ORDERS = \{[\s\S]*?\n\};/)
const renderMatch = source.match(/function renderPrompt\(assembly\) \{[\s\S]*?\n\}/)

check('bundle contains SECTION_ORDERS', Boolean(ordersMatch))
check('bundle contains renderPrompt', Boolean(renderMatch))

if (ordersMatch && renderMatch) {
  // Run the extracted originals. `interpolate` is stubbed only where it cannot
  // matter: every section under test sets interpolate:false, which renderPrompt
  // passes straight through.
  const factory = new Function(
    `${ordersMatch[0]}\n${renderMatch[0]}\n` +
      `function interpolate(section){ return section.text }\n` +
      `return { SECTION_ORDERS, renderPrompt };`,
  )
  const real = factory()
  const O = real.SECTION_ORDERS

  check(
    'our order lands in the policy band',
    SECTION_ORDER > O.DEPLOYMENT_PERSONA_PREFIX && SECTION_ORDER < O.TOOL_BASH,
    `ours=${SECTION_ORDER} persona=${O.DEPLOYMENT_PERSONA_PREFIX} firstTool=${O.TOOL_BASH}`,
  )

  // Assemble what the harness would: identity, persona, a sibling policy, our
  // rule, then the first tool section, sorted the way the registry sorts.
  const registered = []
  const ctx = {
    systemPrompt: {
      getSectionOrder: (n) => O[n],
      section: (arg) => {
        registered.push(arg)
        return () => {}
      },
    },
    commands: { register: () => () => {} },
  }
  apply(ctx, {})
  check('plugin registered both sections', registered.length === 2, `got ${registered.length}`)

  const assembly = {
    variables: {},
    sections: [
      { name: 'harness:identity', order: O.HARNESS_IDENTITY, interpolate: false, text: 'You are an AI agent.' },
      { name: 'deployment:persona-prefix', order: O.DEPLOYMENT_PERSONA_PREFIX, interpolate: false, text: 'Persona line.' },
      { name: 'plan-policy', order: O.PLAN_POLICY, interpolate: false, text: 'Plan policy.' },
      ...registered.map((s) => ({ ...s, interpolate: false })),
      { name: 'tool-bash', order: O.TOOL_BASH, interpolate: false, text: 'Bash tool.' },
    ].sort((a, b) => a.order - b.order),
  }

  const rendered = real.renderPrompt(assembly)
  const rule = DEFAULT_RULE_TEXT.trim()

  check('rendered prompt is non-empty', rendered.length > 0)
  check('rule text reached the assembled prompt', rendered.includes(rule))
  check('rule is complete, not truncated', rendered.includes(rule.slice(-40)))
  check('budget nudge reached the assembled prompt', rendered.includes(DEFAULT_BUDGET_NUDGE), 'nudge missing')
  check('nudge sits before the first tool section', rendered.indexOf('## Context budget') < rendered.indexOf('Bash tool.'))
  check(
    'rule sits after the persona line',
    rendered.indexOf('Persona line.') < rendered.indexOf('## How to reason'),
  )
  check(
    'rule sits before the first tool section',
    rendered.indexOf('## How to reason') < rendered.indexOf('Bash tool.'),
  )
  check('sections are joined by a blank line', rendered.includes('\n\n'))

  // An empty neighbour must vanish, not leave a gap.
  const withEmpty = {
    variables: {},
    sections: [
      { name: 'empty', order: 1, interpolate: false, text: '' },
      { name: 'ours', order: SECTION_ORDER, interpolate: false, text: rule },
    ],
  }
  check('empty sibling section contributes nothing', real.renderPrompt(withEmpty) === rule)

  // The whole rendered prompt, for eyeballing the real ordering.
  console.log('\n--- rendered prompt (verbatim) ---')
  console.log(rendered)
  console.log('--- end ---\n')
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
