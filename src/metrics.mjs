/**
 * Metrics for one reasoning record.
 *
 * ## What this module deliberately does NOT measure
 *
 * "Repetition". On a real 142-block session the sentence repetition rate was
 * 0.1% and adjacent-block Jaccard was 0.131 (median). A looping model does not
 * repeat sentences; it restates the same idea in fresh words. Lexical-overlap
 * detectors are dead on arrival, so none is implemented here.
 *
 * ## What it measures instead
 *
 * Two phases of deliberation:
 *
 *   divergent   - exploring: naming candidate approaches, gathering evidence
 *   converged   - committed: from the first paragraph that states a plan or
 *                 picks an approach to the end
 *
 * Churn lives in the converged phase. A trace that keeps re-planning after it
 * already decided, while its tail stops naming anything new, wasted effort.
 *
 * ## Calibration history (2026-10-28, real data)
 *
 * v1 counted "Let me <verb>" as a decision. Real traces use that construction in
 * most paragraphs, so one 6417-token trace reported 57 "re-decisions" and every
 * long trace clustered at churn 0.58-0.65 - no separation at all. Widening the
 * regex made coverage look better (14% -> 62%) while destroying the signal.
 *
 * v2 (this file) separates exploration from commitment: the phase boundary is
 * the first *commitment* ("Plan:", "I'll", "the fix is", "那就"), not the first
 * action. See docs/calibration.md for the before/after numbers.
 */

/** Characters per token for the length estimate. CJK is ~1 char/token; Latin ~4. */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g

/**
 * Rough token estimate. Good enough for ratio comparisons inside one trace;
 * do not treat the absolute number as billing-grade.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0
  const cjkCount = (text.match(CJK) ?? []).length
  const latinChars = text.length - cjkCount
  return Math.round(cjkCount + latinChars / 4)
}

/**
 * Split a trace into paragraphs. Blank lines are the strongest signal; when a
 * trace has none (some models emit one long block) fall back to sentence
 * grouping so the shape analysis still has segments to work with.
 * @param {string} text
 * @returns {string[]}
 */
export function paragraphs(text) {
  const byBlank = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (byBlank.length >= 3) return byBlank
  const sentences = text
    .split(/(?<=[.!?。！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (sentences.length <= 3) return [text.trim()]
  const groups = []
  const per = Math.max(2, Math.ceil(sentences.length / 8))
  for (let i = 0; i < sentences.length; i += per) {
    groups.push(sentences.slice(i, i + per).join(' '))
  }
  return groups
}

/**
 * A commitment: the paragraph states a plan, picks an approach, or asserts what
 * the answer/fix is. Deliberately narrower than "any action verb" - `Let me
 * grep X` is a step, not a decision, and treating it as one was the v1 mistake.
 */
const COMMIT = new RegExp(
  [
    String.raw`^\s*(?:Plan|Approach|Next steps?|Order of operations|Strategy|Summary)\s*:`,
    String.raw`\bI(?:'ll| will| should| need to)\s+(?:just\s+)?(?:use|go with|take|write|change|fix|add|remove|build|switch|keep|drop|stop|start over)`,
    String.raw`\b(?:so|therefore|thus)\s+(?:I|we)\s+(?:should|will|need|are going to|'ll)`,
    String.raw`\bthe\s+(?:fix|plan|approach|solution|root cause|answer|conclusion)\s+is\b`,
    String.raw`\broot cause\s+(?:is|was)\b`,
    String.raw`\bwe (?:should|need to|have to)\s+[\w]`,
    String.raw`\bI'?m going to\s+[\w]`,
    String.raw`\bdecision\s*:`,
    // Chinese
    String.raw`所以(?:我|决定|应该|要)`,
    String.raw`那就(?:改|做|用|先|这样|定)`,
    String.raw`结论[:：是]`,
    String.raw`根本原因(?:是|就)`,
    String.raw`我(?:决定|打算|准备)`,
  ].join('|'),
  'im',
)

/**
 * Strong retraction: the model abandons a conclusion it already stated.
 * Only these count toward churn. `wait` / `hmm` / `actually` are ordinary
 * discourse markers in real traces ("Wait — the actual prompts include...")
 * and are tracked separately as `discourseMarkers`.
 */
const RETRACT_STRONG = new RegExp(
  [
    String.raw`\bbut wait\b`,
    String.raw`\bon second thought\b`,
    String.raw`\bscratch that\b`,
    String.raw`\bnever mind\b`,
    String.raw`\bthat'?s (?:wrong|not right|incorrect)\b`,
    String.raw`\bI was wrong\b`,
    String.raw`\blet me reconsider\b`,
    String.raw`\bI mis-?read\b`,
    String.raw`\bno,? that'?s\b`,
    String.raw`\bI was mistaken\b`,
    String.raw`\bforget (?:that|it)\b`,
    String.raw`\bstart over\b`,
    String.raw`不对`,
    String.raw`看错了`,
    String.raw`搞错`,
    String.raw`重新想`,
    String.raw`推翻`,
    String.raw`算错了`,
  ].join('|'),
  'i',
)

/** Routine transition words: counted for context, not weighted as churn. */
const DISCOURSE = /\b(?:wait|hmm+|actually|hold on|back to)\b|等等|其实/gi

/**
 * Evidence of new work: a concrete artifact named, a tool invocation planned,
 * or a specific number. Paragraphs carrying these are productive even when long.
 */
const EVIDENCE = new RegExp(
  [
    String.raw`[\w./\\-]+\.(?:mjs|cjs|js|ts|tsx|json|jsonl|md|py|yml|yaml|conf|aedt|pth|csv|zstd)\b`,
    String.raw`@deepseek-ai/[\w-]+`,
    String.raw`\b(?:grep|rg|cat|read|glob|list_dir|pwsh|bash|sed|awk|head|tail|node|npm|pnpm)\b`,
    String.raw`\b(?:file|path|directory|line\s+\d+|seq\s+\d+|L\d+)\b`,
    String.raw`\b\d{2,}\b`,
    String.raw`\b(?:settings|config|cordis|patch|schema|route|endpoint|waterfall|hook|session)\b`,
    String.raw`文件|路径|目录|行号|配置|代码`,
  ].join('|'),
  'i',
)

/**
 * @typedef {object} TraceMetrics
 * @property {number} chars
 * @property {number} tokens               Estimated thinking tokens.
 * @property {number} paragraphs
 * @property {number} commits              Paragraphs that commit to a plan.
 * @property {number} firstCommitAt        Paragraph index of the first commitment, or -1.
 * @property {number} firstCommitRatio     firstCommitAt / paragraphs; -1 when none.
 * @property {number} divergentParas       Paragraphs before the first commitment.
 * @property {number} convergedParas       Paragraphs from the first commitment on.
 * @property {number} tailChars            Characters in the converged phase.
 * @property {number} tailEvidenceRatio    Converged-phase paragraphs naming new artifacts.
 * @property {number} reCommits            Commitments appearing after the first.
 * @property {number} strongRetracts       Abandon-conclusion markers in the tail.
 * @property {number} discourseMarkers     wait/hmm/actually count (context only).
 * @property {number} churnScore           0..1
 * @property {string} verdict              'lean' | 'normal' | 'churn-risk' | 'unclear'
 */

/**
 * Compute shape metrics for one reasoning trace.
 * @param {string} text
 * @returns {TraceMetrics}
 */
export function analyzeTrace(text) {
  const paras = paragraphs(text)
  const chars = text.length
  const tokens = estimateTokens(text)

  let firstCommitAt = -1
  let commits = 0
  for (let i = 0; i < paras.length; i++) {
    if (COMMIT.test(paras[i])) {
      commits++
      if (firstCommitAt === -1) firstCommitAt = i
    }
  }

  const convergent = firstCommitAt >= 0 ? paras.slice(firstCommitAt) : []
  const tailChars = convergent.reduce((a, p) => a + p.length, 0)
  const tailEvidence =
    convergent.length === 0
      ? null
      : convergent.filter((p) => EVIDENCE.test(p)).length / convergent.length

  // Re-commits only count inside the converged phase; every commitment before
  // it is exploration, which is the point of thinking at all.
  const reCommits = Math.max(0, commits - 1)

  const strongRetracts =
    firstCommitAt >= 0
      ? (convergent.join('\n').match(new RegExp(RETRACT_STRONG.source, 'gi')) ?? []).length
      : 0
  const discourseMarkers = (text.match(DISCOURSE) ?? []).length

  // Churn = a long converged phase that keeps re-planning and stops producing
  // evidence. Absolute tail length matters: 2 re-commits in 300 chars is noise,
  // 2 re-commits across 4000 chars of stalling is not.
  let churnScore = 0
  if (firstCommitAt >= 0 && convergent.length >= 3) {
    const density = Math.min(1, reCommits / Math.max(2, convergent.length * 0.25))
    const staleness = 1 - (tailEvidence ?? 1)
    const retractRate = Math.min(1, strongRetracts / Math.max(1, tailChars / 500))
    churnScore = clamp01(density * 0.45 + staleness * 0.4 + retractRate * 0.15)
    // A short tail cannot be wasteful no matter what it says.
    if (tailChars < 600) churnScore *= 0.5
  }

  let verdict = 'unclear'
  if (chars < 400) verdict = 'lean'
  else if (firstCommitAt === -1 || convergent.length < 3) verdict = 'unclear'
  else if (churnScore >= 0.55) verdict = 'churn-risk'
  else verdict = 'normal'

  return {
    chars,
    tokens,
    paragraphs: paras.length,
    commits,
    firstCommitAt,
    firstCommitRatio:
      firstCommitAt >= 0 && paras.length > 0 ? firstCommitAt / paras.length : -1,
    divergentParas: firstCommitAt >= 0 ? firstCommitAt : paras.length,
    convergedParas: convergent.length,
    tailChars,
    tailEvidenceRatio: tailEvidence,
    reCommits,
    strongRetracts,
    discourseMarkers,
    churnScore,
    verdict,
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x))
}

/**
 * Aggregate metrics across many records.
 * @param {TraceMetrics[]} list
 */
export function aggregate(list) {
  const n = list.length
  if (n === 0) return { records: 0 }

  const sum = (f) => list.reduce((a, x) => a + f(x), 0)
  const sorted = [...list].sort((a, b) => a.tokens - b.tokens)
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]

  const withCommit = list.filter((m) => m.firstCommitAt >= 0 && m.tailEvidenceRatio !== null)

  return {
    records: n,
    totalTokens: sum((m) => m.tokens),
    totalChars: sum((m) => m.chars),
    meanTokens: Math.round(sum((m) => m.tokens) / n),
    medianTokens: quantile(0.5).tokens,
    p90Tokens: quantile(0.9).tokens,
    maxTokens: quantile(1).tokens,
    withCommit: withCommit.length,
    withCommitRatio: withCommit.length / n,
    meanFirstCommitRatio:
      withCommit.length > 0
        ? withCommit.reduce((a, m) => a + m.firstCommitRatio, 0) / withCommit.length
        : -1,
    meanTailEvidenceRatio:
      withCommit.length > 0
        ? withCommit.reduce((a, m) => a + m.tailEvidenceRatio, 0) / withCommit.length
        : null,
    reCommits: sum((m) => m.reCommits),
    strongRetracts: sum((m) => m.strongRetracts),
    discourseMarkers: sum((m) => m.discourseMarkers),
    churnRisk: list.filter((m) => m.verdict === 'churn-risk').length,
    lean: list.filter((m) => m.verdict === 'lean').length,
    unclear: list.filter((m) => m.verdict === 'unclear').length,
    normal: list.filter((m) => m.verdict === 'normal').length,
  }
}
