# dsh-think-watch

Look at what your model actually thought.

An offline, read-only analyzer for reasoning traces recorded by
[DeepSeek Harness](https://github.com/deepseek-ai) sessions. It answers
questions like: how much of this session was thinking, where did the model
commit to a plan, and did the part after that commitment still produce anything
new.

It does **not** reduce thinking. See [Why no reduction](#why-no-reduction) —
that was the original goal, and real measurements killed it.

---

## What it does

Reads `session.v*.jsonl.zstd` files from a DSH home and reports per-trace
metrics:

| Metric | Meaning |
|---|---|
| `tokens` | Estimated thinking tokens for the trace |
| `paras` | Paragraphs in the trace |
| `commit@` | Where the first commitment to a plan lands, as a share of the trace |
| `recommit` | Commitments appearing after that first one |
| `retract` | Strong retractions in the converged phase ("scratch that", "I was wrong") |
| `tail-eff` | Share of post-commitment paragraphs that name a new artifact, tool, or number |
| `churn` | 0..1 composite of the three above |

Verdicts: `lean` (short), `normal`, `churn-risk` (all three signals present),
`unclear` (no commitment found).

## Install

No build step, no dependencies.

```sh
git clone <repo> && cd dsh-think-watch
node bin/cli.mjs --help
```

Node >= 22 (uses the built-in `zlib.zstdDecompressSync`).

## Use

```sh
# every session under a DSH home, sorted by thinking volume
node bin/cli.mjs scan "$DSH_HOME/sessions"

# one session, aggregate
node bin/cli.mjs report path/to/session.v4.jsonl.zstd

# longest traces first
node bin/cli.mjs traces path/to/session.v4.jsonl.zstd --limit 20

# export candidates for human review, with a verdict checkbox block per sample
node bin/cli.mjs samples path/to/session.v4.jsonl.zstd --n 5 --out ./review
```

`--json` works on `report`, `traces`, and `scan`.

## Why no reduction

The project started as "reduce unnecessary thinking". Three hypotheses were
tested against a real 235-trace session:

| Hypothesis | Measured | Result |
|---|---|---|
| Looping traces repeat sentences | 0.1% sentence repetition | dead |
| Nearby steps re-derive earlier steps | 0.3% of step pairs above Jaccard 0.35 | dead |
| Early commitment + long tail = waste | two top candidates read by hand: both productive | dead |

The two longest "suspicious" traces were read in full. One discovered that a
planned config change carried a hidden compatibility risk; the other discovered
a required tool was absent and pivoted. Both tails were work, not restatement.

So this tool observes and never intervenes. It does not lower reasoning effort,
does not stop turns, and does not modify any model input. Details and numbers:
[docs/calibration.md](docs/calibration.md).

What the data *does* support: thinking is **59%** of all output tokens in a
measured session (137k of 232k). There is a great deal to look at, even if
there is no validated target to cut.

## Reading the numbers honestly

- `tokens` is an estimate (CJK 1 char ≈ 1 token, Latin 1 token ≈ 4 chars). Good
  for ratios inside one trace, **not billing-grade**.
- `commit@` uses English and Chinese commitment patterns. Traces in other
  languages, or from models with unusual phrasing, will land in `unclear`
  rather than be mis-scored.
- `churn` is a heuristic that has never been validated against a corpus where
  waste is known to exist. Treat `churn-risk` as "worth a look", not as a
  diagnosis.

## Session storage facts

Two things that will silently corrupt any independent analysis:

1. **Multi-frame zstd.** Session files are a sequence of independently framed
   zstd blocks, not one stream. Node's `zstdDecompressSync` reads only the
   first frame. `src/zstd.mjs` splits on the magic number and decodes each
   frame.
2. **Reasoning is stored four times per attempt.** `content[]`,
   `replayState.blocks[]`, `chunk.block`, and `chunk.replayState.blocks[]` all
   carry it. Walking the event tree counts every trace 4x. Read
   `data.message.content[]` only; `src/session.mjs` documents why.

## Layout

```
bin/cli.mjs        command wiring
src/session.mjs    session file -> reasoning records
src/metrics.mjs    pure metric functions
src/zstd.mjs       multi-frame decoder
src/render.mjs     table/report formatting
docs/calibration.md  the measurements that shaped the metrics
```

## License

MIT

## Status

`0.1.0` — offline analysis only. A live host plugin (a reasoning badge in the
chat UI, a `think_watch` reporting tool) is designed but not built; it would
need the `llm/stream` waterfall and the `conversation.chat.reasoning.body`
slot. Nothing in this package touches a running harness.
