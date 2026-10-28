/**
 * dsh-think-watch — host plugin.
 *
 * Registers one persistent system-prompt section that teaches the model how to
 * reason well. Nothing here inspects, interrupts, or rewrites a model call.
 *
 * ## Why a prompt section and not a stream interceptor
 *
 * The earlier design watched the reasoning stream and reacted to it (lower the
 * effort tier, stop a runaway turn). Measured against real sessions that
 * approach had no target: traces that looked wasteful at a glance turned out to
 * be productive work when read by hand (see docs/calibration.md). It also leaned
 * on `llm/stream`, an interception point with no in-tree consumer, and on
 * `agent/turn-stopping`, which only fires after the turn has already ended.
 *
 * A prompt section is the opposite kind of intervention: declared once, visible
 * on every request, and requiring no detection. The model does not have to be
 * caught in a bad pattern in order to learn from it.
 *
 * ## Failure behaviour
 *
 * `systemPrompt.section()` is a public registry method on a loaded service. If a
 * future harness build renames it, this plugin must not take the host down with
 * it: `apply()` checks for the method first and degrades to "registered
 * nothing" with one warning. A plugin that turns a cosmetic rule into a startup
 * crash is worse than the absence of the rule.
 */
import { DEFAULT_RULE_TEXT } from './rule.mjs'

/** Stable section name: used for dedupe, config targeting, and log lines. */
export const SECTION_NAME = 'think-watch:how-to-reason'

/**
 * Services this plugin reads.
 *
 * Cordis resolves `ctx.<service>` through declared injection, and both failure
 * modes are bad: an undeclared service throws during activation ("cannot get
 * property X without inject"), while a declared-but-never-provided one leaves the
 * entry pending forever ("waiting for service: X"). Both were hit during
 * development, so this list stays minimal and every name is verified.
 *
 * Logging is NOT in this list: `console` is a Node global, not a harness
 * service. Declaring it made activation hang waiting for a provider that does
 * not exist.
 */
export const inject = ['systemPrompt']

/**
 * Where the section sits in the assembled prompt.
 *
 * `PLAN_POLICY` is 500 and `TEAM_POLICY` 600, while tool instructions start at
 * 1000. Reasoning guidance belongs with the other policies: after the deployment
 * persona (which owns order 0 on some builds) and before the tool catalog.
 */
export const SECTION_ORDER = 650

/**
 * Mount the plugin.
 * @param {any} ctx - Cordis context carrying the injected services.
 * @param {object} [config]
 * @param {string} [config.text] - Replace the default rule text.
 * @param {number} [config.order] - Override the section order.
 * @param {boolean} [config.enabled] - Set false to register nothing.
 * @param {number} [config.maxChars] - Truncate the rendered text at this length.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  // Read every service through one guarded accessor. Cordis throws on an
  // undeclared service, and this path exists specifically to survive a harness
  // that changed shape - an exception here would defeat its own purpose.
  const systemPrompt = service(ctx, 'systemPrompt')
  if (typeof systemPrompt?.section !== 'function') {
    // Global console, not a service: see the note on `inject`.
    const warn = globalThis.console?.warn
    if (typeof warn === 'function') {
      warn.call(
        globalThis.console,
        '[think-watch] systemPrompt.section() is unavailable in this harness build; ' +
          'the reasoning rule was not installed. The plugin stays loaded so the rest of the profile is unaffected.',
      )
    }
    return
  }

  const text = resolveText(config)
  if (text === '') return

  const order = Number.isFinite(config.order) ? config.order : SECTION_ORDER

  systemPrompt.section({
    name: SECTION_NAME,
    order,
    // Plain prose with no template variables. Interpolating it would let a stray
    // `{{...}}` in a future edit silently swallow text.
    interpolate: false,
    text,
  })
}

/**
 * Read a declared service without letting an undeclared one throw.
 *
 * `ctx[prop]` throws under cordis when `prop` is missing from `inject`. Every
 * service this plugin reads is therefore declared - `console` is included
 * alongside `systemPrompt` purely so the degradation path can log. Nothing else
 * is read, and this helper keeps that rule in one place.
 *
 * @param {any} ctx
 * @param {string} prop
 * @returns {any} the service, or undefined when absent
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
 *
 * A system-prompt section is charged on every request, so an accidental paste of
 * a whole document into `config.text` would quietly inflate every call. The
 * length is capped rather than trusted.
 *
 * @param {object} config
 * @returns {string}
 */
function resolveText(config) {
  const raw = typeof config.text === 'string' ? config.text : DEFAULT_RULE_TEXT
  const max = Number.isFinite(config.maxChars) ? config.maxChars : 2000
  const trimmed = String(raw).trim()
  if (trimmed === '') return ''
  if (trimmed.length <= max) return trimmed
  // Cut at the last paragraph boundary that fits, so truncation never leaves a
  // half sentence in the prompt.
  const head = trimmed.slice(0, max)
  const cut = head.lastIndexOf('\n\n')
  return cut > max * 0.5 ? head.slice(0, cut) : head
}

export { DEFAULT_RULE_TEXT }
