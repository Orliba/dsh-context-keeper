/**
 * Unit tests for the context-budget math (src/budget.mjs). Pure functions.
 * Run: node test/budget.test.mjs
 */
import {
  levelFor,
  computeBudget,
  turnsToFull,
  formatBudget,
  formatBadge,
  roughTokens,
  DEFAULT_THRESHOLDS,
  BAND_COLOR,
} from '../src/budget.mjs'

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

console.log('budget math')

// Bands (yellow 0.5 / orange 0.65 / red 0.8)
check('green below yellow', levelFor(0.49) === 'green')
check('yellow at 0.5', levelFor(0.5) === 'yellow')
check('yellow up to orange edge', levelFor(0.64) === 'yellow')
check('orange at 0.65', levelFor(0.65) === 'orange')
check('orange up to red edge', levelFor(0.79) === 'orange')
check('red at 0.8', levelFor(0.8) === 'red')
check('red above 1.0', levelFor(1.2) === 'red')
check('unknown for non-finite', levelFor(NaN) === 'unknown')
check('thresholds are the documented defaults', DEFAULT_THRESHOLDS.yellow === 0.5 && DEFAULT_THRESHOLDS.orange === 0.65 && DEFAULT_THRESHOLDS.red === 0.8)

// Priority: projected > pressure > heuristic
{
  const b = computeBudget({ projectedTokens: 900, pressureTokens: 800, heuristicTokens: 700, contextWindow: 1000 })
  check('projected wins', b.used === 900 && b.source === 'projected', JSON.stringify(b))
  check('occupancy computed', Math.abs(b.occupancy - 0.9) < 1e-9)
  check('level is red', b.level === 'red')
  check('headroom computed', b.headroomTokens === 100)
}
{
  const b = computeBudget({ pressureTokens: 800, heuristicTokens: 700, contextWindow: 1000 })
  check('pressure used when no projected', b.used === 800 && b.source === 'pressure')
}
{
  const b = computeBudget({ heuristicTokens: 700, contextWindow: 1000 })
  check('heuristic used last', b.used === 700 && b.source === 'heuristic')
}
{
  const b = computeBudget({ heuristicTokens: 700 })
  check('no window -> unknown occupancy/level', b.occupancy === null && b.level === 'unknown' && b.headroomTokens === null)
}

// turnsToFull
check('turns to full: (0.8-0.4)/0.1 = 4', turnsToFull(0.4, 0.1) === 4)
check('turns to full null without growth', turnsToFull(0.5, 0) === null)

// roughTokens: CJK ~1/char, latin ~1/4
check('roughTokens empty', roughTokens('') === 0)
check('roughTokens latin ~ len/4', roughTokens('abcdefgh') === 2)
check('roughTokens cjk ~ len', roughTokens('这是中文测试') === 6)

// formatBudget
{
  const b = computeBudget({ projectedTokens: 800000, contextWindow: 1000000 })
  const lines = formatBudget(b, { perTurnGrowth: 12000, compactions: [{ seq: 9, summary: 'x', shadowedSeqs: [1, 2, 3] }] })
  const joined = lines.join('\n')
  check('shows occupancy %', joined.includes('80%'), joined)
  check('shows headroom', joined.includes('剩余空间'))
  check('shows growth and turns', joined.includes('增长速度') && joined.includes('轮后到红档'), joined)
  check('shows last compaction', joined.includes('上次压缩') && joined.includes('回收 3 条'), joined)
  check('recommends /handoff at orange/red', joined.includes('/handoff'), joined)
}

// formatBadge (client badge model)
{
  const green = formatBadge(computeBudget({ projectedTokens: 1000, contextWindow: 10000 }))
  check('badge green level', green.level === 'green')
  check('badge green text is pct only', green.text === '10%', green.text)
  check('badge green colour', green.color === BAND_COLOR.green)

  const orange = formatBadge(computeBudget({ projectedTokens: 7000, contextWindow: 10000 }))
  check('badge orange level (70%)', orange.level === 'orange')
  check('badge orange text has hint', orange.text.includes('建议交接'), orange.text)
  check('badge orange title recommends /handoff', orange.title.includes('/handoff'), orange.title)

  const unknown = formatBadge(computeBudget({ heuristicTokens: 500 }))
  check('badge unknown when no window', unknown.level === 'unknown' && unknown.pct === null, JSON.stringify(unknown))
  check('badge unknown colour is grey', unknown.color === BAND_COLOR.unknown)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
