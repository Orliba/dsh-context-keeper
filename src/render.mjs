/**
 * Rendering helpers for the CLI. Kept separate from bin/cli.mjs so the command
 * wiring stays readable.
 */

/** @param {import('./metrics.mjs').TraceMetrics} m */
export function reportLines(file, session, agg) {
  const lines = []
  lines.push('')
  lines.push('='.repeat(74))
  lines.push(`session  ${file}`)
  lines.push(
    `frames ${session.frames} (failed ${session.failedFrames})   turns ${session.turns}   steps ${session.steps}`,
  )
  if (agg.records === 0) {
    lines.push('no reasoning recorded')
    return lines
  }
  lines.push(`reasoning records ${agg.records}`)
  lines.push('')
  lines.push(`  thinking tokens (est)      ${agg.totalTokens}`)
  lines.push(`  per record  mean / median  ${agg.meanTokens} / ${agg.medianTokens}`)
  lines.push(`  p90 / max                  ${agg.p90Tokens} / ${agg.maxTokens}`)
  lines.push('')
  lines.push(
    `  committed to a plan        ${agg.withCommit} / ${agg.records}  (${pct(agg.withCommitRatio)})`,
  )
  lines.push(
    `  commitment lands at        ${agg.meanFirstCommitRatio < 0 ? 'n/a' : pct(agg.meanFirstCommitRatio)}`,
  )
  if (agg.meanTailEvidenceRatio !== null) {
    lines.push(`  tail naming new evidence   ${pct(agg.meanTailEvidenceRatio)}`)
  }
  lines.push(`  re-commitments             ${agg.reCommits}`)
  lines.push(`  strong retractions         ${agg.strongRetracts}`)
  lines.push(`  discourse markers          ${agg.discourseMarkers}   (wait/hmm/actually - context only)`)
  lines.push('')
  lines.push(
    `  verdicts  lean ${agg.lean} | normal ${agg.normal} | churn-risk ${agg.churnRisk} | unclear ${agg.unclear}`,
  )
  return lines
}

export function traceHeader() {
  return (
    pad('turn/step', 11) +
    pad('tokens', 8) +
    pad('paras', 7) +
    pad('commit@', 9) +
    pad('recommit', 10) +
    pad('retract', 9) +
    pad('tail-eff', 10) +
    pad('churn', 7) +
    'verdict'
  )
}

export function traceRow(r, m) {
  return (
    pad(`${r.turn}/${r.step}`, 11) +
    pad(String(m.tokens), 8) +
    pad(String(m.paragraphs), 7) +
    pad(m.firstCommitRatio < 0 ? '-' : pct(m.firstCommitRatio), 9) +
    pad(String(m.reCommits), 10) +
    pad(String(m.strongRetracts), 9) +
    pad(m.tailEvidenceRatio === null ? '-' : pct(m.tailEvidenceRatio), 10) +
    pad(m.churnScore.toFixed(2), 7) +
    m.verdict
  )
}

export function pad(s, n) {
  const width = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - width))
}

export function pct(x) {
  return `${Math.round(x * 100)}%`
}
