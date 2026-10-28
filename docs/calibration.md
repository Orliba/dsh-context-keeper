# Calibration — what the real data said

This document records the measurements that shaped `src/metrics.mjs`. Every
number here came from a real DSH session on the author's machine, not from
synthetic fixtures. It exists because two plausible ideas turned out to be
wrong, and someone will otherwise try them again.

Source session: `session-5674b871`, 2,281,032 bytes compressed, 1,235 zstd
frames, 6,521,302 decoded characters, 19 turns, 316 steps.

---

## Fact 0 — reasoning is stored four times per attempt

Before any metric, the extraction path matters.

A single reasoning block appears at four separate paths in the same event:

```
data.message.content[]                    the assembled content blocks
data.message.source.replayState.blocks[]  adapter replay envelope
data.stream[].chunk.block                 per-chunk block-end payload
data.stream[].chunk.replayState.blocks[]  per-chunk replay envelope
```

Measured: 235 blocks at each path. A naive "walk the whole event tree, count
anything with `type === 'reasoning'`" counter reports **940** — exactly 4x.

Any tool that walks the event tree inflates every metric by 4, silently, with
no error and no visible symptom. `src/session.mjs` therefore reads reasoning
from `data.message.content[]` only, and concatenates multiple reasoning blocks
within one attempt (a single attempt can carry more than one).

---

## Fact 1 — lexical repetition does not exist in real traces

First hypothesis: a model that is going in circles repeats itself.

| Metric | Measured |
|---|---|
| Sentence-level repetition rate | **0.1%** |
| Adjacent-block Jaccard, median | **0.131** |
| Adjacent-block Jaccard, p90 | 0.291 |
| Adjacent-block Jaccard, max | 0.347 |

Zero signal. A looping model does not repeat its sentences — it restates the
same idea in fresh words. **Any detector built on lexical overlap is dead on
arrival.** This is why `metrics.mjs` contains no repetition metric at all.

---

## Fact 2 — cross-step repetition does not exist either

Second hypothesis: the waste is spread across steps, not inside one trace — a
later step re-derives what an earlier step already settled.

Measured across 2,384 same-turn step pairs (word-bag Jaccard, stopwords
removed):

| Threshold | Pairs | Share |
|---|---|---|
| Jaccard >= 0.35 | 8 | **0.3%** |

The 8 that do cross the threshold sit at 0.35–0.37, which for bag-of-words on
long traces is background overlap, not re-derivation. No signal either.

---

## Fact 3 — "long trace that committed early" is not waste

Third hypothesis, and the one the plugin design was originally built on: a
trace that states a plan early and then keeps writing must be wasting effort.

Metric v1 counted `Let me <verb>` as a decision. Real traces use that
construction in most paragraphs, so one 6,417-token trace reported **57
"re-decisions"**, and every long trace clustered at churn 0.58–0.65 with no
separation whatsoever. Widening the regex raised decision coverage from 14% to
62% while destroying the signal entirely — a textbook case of a metric that
looks better the less it means.

Metric v2 separated exploration from commitment: the phase boundary is the
first *commitment* (`Plan:`, `I'll use`, `the fix is`, `那就`), not the first
action. Scores spread out (0.00–0.39), and then the two top candidates were
read by hand.

**Sample 1** (turn 3 step 1, 1,523 tokens, churn 0.39, commitment at 10%):
the three opening paragraphs state the plan; the following 27 paragraphs
discover that the config change it was about to make carried a hidden
compatibility risk, and that mounting a plugin globally would collide with an
existing registry registration. Both discoveries are real work that the opening
plan did not contain.

**Sample 2** (turn 3 step 53, 2,813 tokens, churn 0.37, commitment at 0%):
the opening states "backup done, now write the preset"; the rest discovers the
`plugin_manager` tool is not in the toolset, that the profile directory is not
writable under the current sandbox, and pivots to inserting a preset
declaration row directly. Again: the tail found the path, it is not restating
the plan.

**Verdict: both are good thinking, not waste.** The hypothesis that generated
the whole "reduce thinking" half of the design does not hold on this data.

---

## Fact 4 — but thinking really is the majority of output

| Item | Value |
|---|---|
| Total output tokens | 231,999 |
| Estimated thinking tokens | 137,187 |
| Share | **59%** |

Across the machine's 28 sessions the same holds: total estimated thinking
tokens 2.9M+. Thinking is the bulk of what these models emit. So there is
plenty to *look at* — which is what this tool does — even though "reduce it"
has no measured target to aim at.

---

## What this means for the design

The original plan had two halves:

1. **Observe** — extract, summarize, display reasoning.
2. **Reduce** — detect waste, then lower the reasoning-effort tier or stop the
   turn.

Half 2 rested on hypotheses 1–3, all three of which are now falsified on real
data. Nothing in the measurements supports the claim that these traces contain
avoidable deliberation. So:

- Half 1 stays, and is the whole tool.
- Half 2 is **not implemented**. It is not "disabled by default" — it is
  absent, because there is no validated detector to wire it to.

A future detector might exist for a different model family, a different
provider, or a workload where re-derivation is actually common (for example a
weak local model on a long agent loop). If one is found, it goes here with
its own calibration numbers first.

---

## Reproducing

```sh
# aggregate over every session under a DSH home
node bin/cli.mjs scan "$DSH_HOME/sessions"

# per-trace detail for one session
node bin/cli.mjs traces <session.v*.jsonl.zstd> --limit 30

# export candidates for human review
node bin/cli.mjs samples <session.v*.jsonl.zstd> --n 5
```

The measuring code is `src/session.mjs` (extraction) and `src/metrics.mjs`
(shape). Both are pure functions over strings: no model calls, no network, no
writes.
