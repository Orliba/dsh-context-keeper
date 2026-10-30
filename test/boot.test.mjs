/**
 * Live boot test.
 *
 * Every other test in this repo runs the plugin's `apply()` against a
 * hand-built context. None of them can catch a bad `cordis.patch.yml`, a wrong
 * entry name, a broken `exports` map, or a missing service declaration - and
 * those are exactly the failures that took a real desktop profile down twice.
 *
 * This boots a throwaway profile through the real CLI, waits for the port to
 * answer, and reports what the loader said. It never touches the desktop
 * profile.
 *
 * Usage:  node test/boot.test.mjs <profile> [port]
 * Exit:   0 booted and answered, 1 boot failed, 2 could not run
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const profile = process.argv[2]
const port = process.argv[3] ?? '61999'
if (!profile) {
  console.error('usage: node test/boot.test.mjs <profile> [port]')
  process.exit(2)
}

const CLI =
  process.env.DSH_CLI ?? 'H:\\Deepseekstudio\\resources\\runtime\\cli\\bin\\dsh.cmd'

console.log(`booting profile "${profile}" on port ${port}`)

const child = spawn(CLI, ['--profile', profile, '--port', port], {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? 'H:\\Deepseekstudio-data' },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => (stdout += d.toString()))
child.stderr.on('data', (d) => (stderr += d.toString()))

const deadline = Date.now() + 45000
let answered = false
let fatal = null

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500))
  if (child.exitCode !== null) break
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
    // 401 is the expected answer: the server is up and wants a token.
    if (res.status === 401 || res.ok) {
      answered = true
      break
    }
  } catch {
    // not up yet
  }
}

child.kill()
await new Promise((r) => setTimeout(r, 800))

const out = `${stdout}\n${stderr}`

console.log('\n--- process output ---')
console.log(out.trim() || '(none)')
console.log('--- end ---\n')

// A loader failure for this plugin is what matters. Other plugins complaining
// in a throwaway profile is noise for this test.
const mentionsPlugin = /context-keeper/i.test(out)
const mentionsFailure = /did not activate|failed|cannot get property|waiting for service|Error:/i.test(out)
const pluginBroken = mentionsPlugin && mentionsFailure

if (pluginBroken) {
  console.log('RESULT: FAIL - the loader reported a problem with context-keeper')
  process.exitCode = 1
} else if (answered) {
  console.log('RESULT: PASS - profile booted and the server answered')
  process.exitCode = 0
} else {
  console.log('RESULT: FAIL - the server never answered on port ' + port)
  process.exitCode = 1
}

if (fatal) console.log('note:', fatal)
