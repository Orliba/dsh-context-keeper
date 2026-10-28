#!/usr/bin/env node
/**
 * dsh-think-watch CLI - offline reasoning-trace analysis for DSH sessions.
 *
 * Read-only: it never writes to a session file, never touches a profile, and
 * never calls a model. The only output is text on stdout and, for the
 * `samples` command, markdown under an output directory the caller picks.
 *
 * Commands:
 *   report  <session-file|sessions-dir>   Aggregate report
 *   traces  <session-file> [--limit N]    Per-trace table, longest first
 *   samples <session-file> [--n N]        Export traces for human review
 *   scan    <sessions-root>               Every session under a DSH sessions root
 *
 * Exit codes: 0 success, 1 usage error, 2 nothing to analyze.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSession, listSessions } from '../src/session.mjs'
import { analyzeTrace, aggregate } from '../src/metrics.mjs'
import { reportLines, traceHeader, traceRow, pad, pct } from '../src/render.mjs'

const USAGE = `dsh-think-watch <command> [args]

  report  <session-file|sessions-dir>          Aggregate report
  traces  <session-file> [--limit N]           Per-trace table (longest first)
  samples <session-file> [--n N] [--out DIR]   Export traces for human review
  scan    <sessions-root>                      Every session under a DSH sessions root

Options:
  --json     Machine-readable output
  --limit    Row limit for 'traces' (default 30)
  --n        Sample count for 'samples' (default 5)
  --out      Output directory for 'samples' (default ./think-watch-samples)
`

const FS = { readdirSync, statSync, join }

function main(argv) {
  const [command, ...rest] = argv
  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(USAGE)
    return 0
  }
  const flags = parseFlags(rest)
  const positional = rest.filter((a) => !a.startsWith('--') && !isFlagValue(rest, a))
  const target = positional[0]
  if (!target) {
    process.stderr.write('missing target path\n\n' + USAGE)
    return 1
  }

  switch (command) {
    case 'report':
      return cmdReport(target, flags)
    case 'traces':
      return cmdTraces(target, flags)
    case 'samples':
      return cmdSamples(target, flags)
    case 'scan':
      return cmdScan(target, flags)
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

function isFlagValue(argv, value) {
  const idx = argv.indexOf(value)
  return idx > 0 && argv[idx - 1].startsWith('--')
}

function parseFlags(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function cmdReport(target, flags) {
  const files = resolveFiles(target)
  if (files.length === 0) {
    process.stderr.write(`no session file found: ${target}\n`)
    return 2
  }
  if (flags.json) {
    const payload = files.map((file) => {
      const session = readSession(file)
      const metrics = session.records.map((r) => analyzeTrace(r.text))
      return {
        file,
        turns: session.turns,
        steps: session.steps,
        failedFrames: session.failedFrames,
        aggregate: aggregate(metrics),
      }
    })
    process.stdout.write(JSON.stringify(payload.length === 1 ? payload[0] : payload, null, 2) + '\n')
    return 0
  }
  for (const file of files) {
    const session = readSession(file)
    const metrics = session.records.map((r) => analyzeTrace(r.text))
    const lines = reportLines(file, session, aggregate(metrics))
    process.stdout.write(lines.join('\n') + '\n')
  }
  return 0
}

function cmdTraces(target, flags) {
  const files = resolveFiles(target)
  if (files.length === 0) {
    process.stderr.write(`no session file found: ${target}\n`)
    return 2
  }
  const limit = Number(flags.limit ?? 30)
  const all = []
  for (const file of files) {
    const session = readSession(file)
    for (const r of session.records) all.push({ r, m: analyzeTrace(r.text) })
  }
  all.sort((a, b) => b.m.tokens - a.m.tokens)
  const shown = all.slice(0, limit)

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        shown.map(({ r, m }) => ({ turn: r.turn, step: r.step, model: r.model, ...m })),
        null,
        2,
      ) + '\n',
    )
    return 0
  }

  console.log(traceHeader())
  console.log('-'.repeat(90))
  for (const { r, m } of shown) console.log(traceRow(r, m))
  console.log(`\n${all.length} traces, showing top ${shown.length} by thinking length`)
  return 0
}

function cmdSamples(target, flags) {
  const files = resolveFiles(target)
  if (files.length === 0) {
    process.stderr.write(`no session file found: ${target}\n`)
    return 2
  }
  const n = Number(flags.n ?? 5)
  const outDir = flags.out ?? 'think-watch-samples'

  const candidates = []
  for (const file of files) {
    const session = readSession(file)
    for (const r of session.records) {
      const m = analyzeTrace(r.text)
      // Long, committed early, long converged tail: the traces where the
      // "wasted deliberation" hypothesis would have to hold if it holds at all.
      if (m.tokens >= 400 && m.firstCommitRatio >= 0 && m.convergedParas >= 3) {
        candidates.push({ r, m, file })
      }
    }
  }
  candidates.sort((a, b) => b.m.churnScore - a.m.churnScore)
  if (candidates.length === 0) {
    console.log('no candidate samples (long trace with an early commitment)')
    return 0
  }

  mkdirSync(outDir, { recursive: true })
  const picked = candidates.slice(0, n)
  const index = []

  picked.forEach(({ r, m, file }, i) => {
    const name = `sample-${String(i + 1).padStart(2, '0')}-turn${r.turn}-step${r.step}.md`
    writeFileSync(join(outDir, name), sampleMarkdown(i, r, m, file), 'utf8')
    index.push({ name, tokens: m.tokens, churn: m.churnScore, ratio: m.firstCommitRatio })
  })

  writeFileSync(
    join(outDir, 'README.md'),
    [
      '# Human review samples',
      '',
      'Generated by `dsh-think-watch samples`.',
      '',
      '**Why a human has to look.** Everything downstream rests on one assumption:',
      'that a trace which committed to a plan early and then kept writing was wasting',
      'effort. That assumption may be wrong. The tail could be gathering evidence,',
      'checking a hunch, or hedging against a failure it can see coming - all of which',
      'are high quality thinking, not waste. No threshold is trustworthy until this is',
      'settled by eye.',
      '',
      'Each sample ends with a checkbox block. Read at least five before tuning anything,',
      'and note *why* you judged it the way you did. The notes are worth more than the tick.',
      '',
      '## Samples',
      '',
      '| file | thinking tokens | churn | commitment at |',
      '|---|---|---|---|',
      ...index.map((x) => `| ${x.name} | ${x.tokens} | ${x.churn.toFixed(2)} | ${pct(x.ratio)} |`),
      '',
    ].join('\n'),
    'utf8',
  )

  console.log(`exported ${picked.length} samples to ${outDir}`)
  console.log(`${candidates.length} candidates, top ${picked.length} by churn score.`)
  console.log('read README.md first, then tick the boxes at the end of each sample.')
  return 0
}

function sampleMarkdown(i, r, m, file) {
  return [
    `# Sample ${i + 1}: turn ${r.turn} / step ${r.step}`,
    '',
    `source: \`${file}\``,
    `model: ${r.model || '(unrecorded)'}   provider: ${r.provider || '(unrecorded)'}`,
    '',
    '## Metrics',
    '',
    '| item | value |',
    '|---|---|',
    `| estimated thinking tokens | ${m.tokens} |`,
    `| chars | ${m.chars} |`,
    `| paragraphs | ${m.paragraphs} |`,
    `| commitment at paragraph | ${m.firstCommitAt} (${pct(m.firstCommitRatio)} of the trace) |`,
    `| divergent paragraphs before it | ${m.divergentParas} |`,
    `| converged paragraphs after it | ${m.convergedParas} (${m.tailChars} chars) |`,
    `| re-commitments in the tail | ${m.reCommits} |`,
    `| strong retractions in the tail | ${m.strongRetracts} |`,
    `| tail paragraphs naming new evidence | ${m.tailEvidenceRatio === null ? 'n/a' : pct(m.tailEvidenceRatio)} |`,
    `| churn score | ${m.churnScore.toFixed(2)} |`,
    '',
    '## Human verdict (fill this in)',
    '',
    '- [ ] Genuine waste: the plan was already clear, the rest circles',
    '- [ ] Good thinking: the tail adds detail or checks evidence',
    '- [ ] Cannot tell / need the full context',
    '',
    'Reason:',
    '',
    '## Raw reasoning',
    '',
    '```text',
    r.text,
    '```',
    '',
  ].join('\n')
}

function cmdScan(target, flags) {
  if (!existsSync(target)) {
    process.stderr.write(`path does not exist: ${target}\n`)
    return 2
  }
  const files = listSessions(target, FS)
  if (files.length === 0) {
    process.stderr.write(`no session.v*.jsonl.zstd under: ${target}\n`)
    return 2
  }
  const rows = []
  for (const file of files) {
    const session = readSession(file)
    if (session.records.length === 0) continue
    rows.push({
      file,
      turns: session.turns,
      session,
      agg: aggregate(session.records.map((r) => analyzeTrace(r.text))),
    })
  }
  rows.sort((a, b) => b.agg.totalTokens - a.agg.totalTokens)

  if (flags.json) {
    process.stdout.write(JSON.stringify(rows.map(({ file, turns, agg }) => ({ file, turns, agg })), null, 2) + '\n')
    return 0
  }

  console.log(
    pad('turns', 7) + pad('traces', 8) + pad('think-tok', 12) + pad('churn', 12) + 'session',
  )
  console.log('-'.repeat(94))
  for (const { file, turns, agg } of rows) {
    const short = file.replace(/^.*sessions[\\/]/, '')
    console.log(
      pad(String(turns), 7) +
        pad(String(agg.records), 8) +
        pad(String(agg.totalTokens), 12) +
        pad(`${agg.churnRisk}/${agg.records}`, 12) +
        short,
    )
  }
  const total = rows.reduce((a, r) => a + r.agg.totalTokens, 0)
  const risk = rows.reduce((a, r) => a + r.agg.churnRisk, 0)
  const traces = rows.reduce((a, r) => a + r.agg.records, 0)
  console.log(`\n${rows.length} sessions, ${traces} traces, thinking tokens approx ${total}, churn-risk ${risk}`)
  return 0
}

function resolveFiles(target) {
  if (!existsSync(target)) return []
  const st = statSync(target)
  if (st.isFile()) return [target]
  return listSessions(target, FS)
}

process.exitCode = main(process.argv.slice(2))
