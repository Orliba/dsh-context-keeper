/**
 * Live integration test for the two v3 commands.
 *
 * The unit tests prove argument shapes; this proves the *real* command handlers
 * - locate session file -> readSessionDetail -> budget/handoff - work against a
 * real DSH session on this machine. It mounts `apply()` with a fake command
 * registry, captures the registered handlers, and invokes them exactly as the
 * command adapter would. No harness, no model, no UI.
 *
 * Skips (exit 0) when this machine has no DSH sessions to read.
 *
 * Run: node test/integration-commands.test.mjs [sessionsRoot] [sessionId]
 */
import { existsSync, rmSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../plugin/index.mjs'

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

const sessionsRoot = process.argv[2] ?? process.env.DSH_SESSIONS ?? 'H:\\Deepseekstudio-data\\sessions'
// A real, content-rich session on the author's machine; overridable.
const sessionId = process.argv[3] ?? 'session-5c17190b-9841-4645-94d6-2a72ee9009b3'

console.log('integration: real command handlers')

if (!existsSync(sessionsRoot)) {
  console.log(`skip: sessions root not found (${sessionsRoot})`)
  process.exit(0)
}

const tmpDir = mkdtempSync(join(tmpdir(), 'context-keeper-it-'))
const handlers = {}
const ctx = {
  systemPrompt: { section: () => () => {} },
  commands: { register: (def) => ((handlers[def.name] = def.handler), () => {}) },
}

apply(ctx, { contextNudge: false, sessionsRoot, handoffDir: tmpDir })

check('context-watch handler registered', typeof handlers['context-watch'] === 'function')
check('handoff handler registered', typeof handlers.handoff === 'function')

const invocation = { agent: { session: { id: sessionId } }, rawInput: '', signal: { aborted: false }, attachments: [] }

;(async () => {
  // /context-watch
  const r1 = await handlers['context-watch'](invocation)
  check('context-watch returns success', r1?.kind === 'success', JSON.stringify(r1))
  check('context-watch reports occupancy', String(r1?.text ?? '').includes('上下文占用'), r1?.text)
  check('context-watch reports a band', /档位：(绿|黄|橙|红|未知)/.test(String(r1?.text ?? '')), r1?.text)

  // /handoff
  const r2 = await handlers.handoff(invocation)
  check('handoff returns success', r2?.kind === 'success', JSON.stringify(r2))
  const m = String(r2?.text ?? '').match(/交接包（读这份[^）]*）：(.+)/)
  const pkgPath = m ? m[1].trim() : ''
  check('handoff reports a package path', pkgPath !== '', r2?.text)
  check('package file exists on disk', pkgPath !== '' && existsSync(pkgPath), pkgPath)
  if (pkgPath && existsSync(pkgPath)) {
    const body = readFileSync(pkgPath, 'utf8')
    check('package has section 1', body.includes('## 1. 要做的事'))
    check('package has section 8 archive', body.includes('## 8. 全文归档'))
  }

  rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
})()
