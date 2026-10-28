# dsh-think-watch

Two things for a [DeepSeek Harness](https://github.com/deepseek-ai) agent:

- **A host plugin** that teaches it how to reason well — one persistent
  system-prompt section, visible on every request.
- **An offline analyzer** that reads what it actually thought, from the session
  files on disk.

It does **not** cut reasoning short. That was the original goal; measurement
killed it. See [Why this does not reduce thinking](#why-this-does-not-reduce-thinking).

---

## Install

### As a DSH plugin

```sh
dsh plugin --profile <your-profile> add dsh-think-watch
```

Then restart the profile. The plugin registers one prompt section named
`think-watch:how-to-reason` at order 650, which places it with the other policy
sections — after the deployment persona, before the tool catalog.

To turn it off without uninstalling, either set `enabled: false` in the config
block, or add a patch row:

```yaml
- id: think-watch
  disabled: true
```

Config options:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` registers nothing |
| `text` | built-in rule | Replace the rule text entirely |
| `order` | `650` | Section position in the assembled prompt |
| `maxChars` | `2000` | Truncate at a paragraph boundary |

### As a CLI

```sh
git clone https://github.com/Orliba/dsh-think-watch
cd dsh-think-watch
node bin/cli.mjs --help
```

No build step, no dependencies, Node >= 22 (uses built-in `zlib.zstdDecompressSync`).

---

## The plugin: what it puts in the prompt

The rule is five lines, each naming an observable behaviour rather than a
virtue:

> **Decide before acting.** Before the first tool call, settle what you are
> doing, why, and how you will know it worked. Once you state a plan, execute
> it; do not reopen the plan mid-execution.
>
> **Change a conclusion only with a reason.** …
>
> **When reasoning stalls, gather evidence instead of thinking harder.** …
>
> **Match depth to risk.** Read-only exploration may be quick. Irreversible
> actions deserve a second look. …
>
> **Say what you do not know.** …

Full text and the reasoning behind each line: [plugin/rule.mjs](plugin/rule.mjs)
and [docs/rule-text.md](docs/rule-text.md).

### Why a prompt section and not a stream interceptor

The first design watched the reasoning stream and reacted — lower the effort
tier when a trace looked wasteful, stop a turn that ran away. Three
measurements, on real sessions, removed the target:

| Hypothesis | Measured | Result |
|---|---|---|
| Looping traces repeat sentences | 0.1% sentence repetition | dead |
| Nearby steps re-derive earlier steps | 0.3% of step pairs above Jaccard 0.35 | dead |
| Early commitment + long tail = waste | top candidates read by hand: both productive | dead |

It also depended on two fragile places: `llm/stream` (no in-tree consumer) and
`agent/turn-stopping` (fires only after the turn already ended).

A prompt section is the opposite kind of intervention. It is declared once, it
is visible on every request, and it needs no detection — the model does not have
to be caught in a bad pattern in order to learn from it. Numbers and raw data:
[docs/calibration.md](docs/calibration.md).

### Failure behaviour

`systemPrompt.section()` is a public registry method, but this plugin still
refuses to take a host down if a future build changes shape. If the method is
missing, it warns once and registers nothing — the entry stays loaded so the
rest of the profile is unaffected.

Two failure modes were found the hard way during development, both now covered
by tests:

- an **undeclared** service throws at activation (`cannot get property X without inject`)
- a **declared but never provided** service leaves the entry pending forever
  (`waiting for service: X`) — this is what happens if you declare `console`,
  which is a Node global, not a harness service

---

## The CLI: reading what it thought

```sh
# every session under a DSH home, sorted by thinking volume
node bin/cli.mjs scan "$DSH_HOME/sessions"

# one session, aggregate
node bin/cli.mjs report path/to/session.v4.jsonl.zstd

# longest traces first
node bin/cli.mjs traces path/to/session.v4.jsonl.zstd --limit 20

# export candidates for human review, with a verdict checkbox per sample
node bin/cli.mjs samples path/to/session.v4.jsonl.zstd --n 5 --out ./review
```

`--json` works on `report`, `traces`, and `scan`.

| Metric | Meaning |
|---|---|
| `tokens` | Estimated thinking tokens |
| `paras` | Paragraphs in the trace |
| `commit@` | Where the first commitment to a plan lands, as a share of the trace |
| `recommit` | Commitments appearing after that first one |
| `retract` | Strong retractions ("scratch that", "I was wrong") |
| `tail-eff` | Share of post-commitment paragraphs naming a new artifact or number |
| `churn` | 0..1 composite of the three above |

Verdicts: `lean`, `normal`, `churn-risk`, `unclear` (no commitment found).

### Reading the numbers honestly

- `tokens` is an estimate (CJK ≈ 1 char/token, Latin ≈ 4 chars/token). Fine for
  ratios inside one trace, **not billing-grade**.
- `commit@` matches English and Chinese commitment patterns. Traces in other
  languages land in `unclear` rather than being mis-scored.
- `churn` is a heuristic never validated against a corpus where waste is known
  to exist. Treat `churn-risk` as "worth a look", not a diagnosis.

---

## Session storage facts

Two things that silently corrupt any independent analysis:

1. **Multi-frame zstd.** Session files are a sequence of independently framed
   zstd blocks, not one stream. Node's `zstdDecompressSync` reads only the first
   frame. `src/zstd.mjs` splits on the magic number and decodes each frame.
2. **Reasoning is stored four times per attempt** — `content[]`,
   `replayState.blocks[]`, `chunk.block`, and `chunk.replayState.blocks[]`.
   Walking the event tree counts every trace 4x, with no error and no symptom.
   Read `data.message.content[]` only; `src/session.mjs` explains why.

---

## Layout

```
bin/cli.mjs         command wiring
src/session.mjs     session file -> reasoning records
src/metrics.mjs     pure metric functions
src/zstd.mjs        multi-frame decoder
src/render.mjs      table/report formatting
plugin/index.mjs    the host plugin
plugin/rule.mjs     the rule text
test/               35 assertions across three files
docs/               calibration data and design notes
```

Run the tests:

```sh
node test/plugin.test.mjs        # unit: what gets registered
node test/activation.test.mjs    # cordis injection rules
```

---

## License

MIT
