# dsh-context-keeper

Two things for a [DeepSeek Harness](https://github.com/deepseek-ai) agent:

- **A host plugin** that teaches it how to reason well — one persistent
  system-prompt section, visible on every request.
- **An offline analyzer** that reads what it actually thought, from the session
  files on disk.

It does **not** cut reasoning short. That was the original goal; measurement
killed it. See [Why this does not reduce thinking](#why-this-does-not-reduce-thinking).

---

## Compatibility

- **DeepSeek Harness `>= 0.2.0-rc.1`** — declared in `package.json` under `dsh.engines.dsh`.
- **Node.js `>= 22`** — the plugin uses the built-in `zlib.zstdDecompressSync`.
- **Verified on:** DSH Desktop **44.7.0** (Windows) — the context badge mounts and
  renders in the turn footer, and `/context-watch` / `/handoff` run against local
  session files.

The plugin relies on public DSH APIs: `systemPrompt.section`, `commands.register`,
the `conversation.chat.turnTail` / `conversation.composer.dock` seats, and the
`contextPressure` projection. If a future build changes those, the host half warns
once and registers nothing instead of taking the host down; the client half simply
renders nothing when its projection is unavailable.

---

## What v0.4 adds: a context badge & reminder

**A colour dot in every turn's footer** (the `conversation.chat.turnTail`
seat — the same place and shape as dsh-cost-meter's usage chip). It reads the
official `contextPressure` projection and paints the band — **green (<50%) /
yellow (50–65%) / orange (65–80%) / red (≥80%)** — with the occupancy percent;
the action hint ("建议交接" / "该交接了") only appears from orange up. Hover shows
the full sentence.

**A reminder panel under the input** (`conversation.composer.dock`) that appears
at **orange/red** only. It states the band and offers an **开新会话** button: it
calls the client Remote `session.create` + `session.prompt` to make a fresh
session in the same workspace and seed it with "read the latest handoff package
under `.context-keeper/handoff` and continue". The new session is a full agent,
so it reads the package itself — the button does not inline the package (that
would spend tokens again).

Both are pure presentation plus one explicit user click. They never enter the
model input on their own and cost zero tokens until you press the button.

> **Honest limits** (verified against this build's source):
> - DSH's `ReasoningRow` header (above the thinking block) is hard-wired with no
>   extension seat, so the footer is the nearest always-visible open spot.
> - After creating the new session the button **cannot switch you to it** — the
>   slot API has no navigation; open it from the sidebar. The panel says so.
> - Command **names** must match `^[a-z][a-z0-9_-]*$` and third-party commands
>   render their name (no separate display `label`), so `/handoff` and
>   `/context-watch` cannot be shown as `Handoff`/`Context-Watch` in the menu.
>   Readability goes into the **Chinese one-line description** shown next to
>   each name instead.

The client half is `plugin/client.js` (declared under `dsh.client` in
`package.json`); the host half is unchanged. No config path needed.

---

## What v0.3 adds: context budget & handoff

v0.2 taught the agent *how* to think. v0.3 handles *whether the window can hold
it*. Two human commands, both reading the session file DSH already writes and
calling a model **zero times**:

- **`/context-watch`** — occupancy, band (green/yellow/orange/red), headroom,
  growth per turn, and the last compaction's reclaim.
- **`/handoff`** — write a portable handoff package plus a full faithful archive
  to `<workspace>/.context-keeper/handoff/`, so a fresh session can continue
  without re-deriving anything. It reuses DSH's own `compaction/summary`
  checkpoint as the "early context" (free multi-level distillation) and quotes
  the recent tail verbatim.

A short, **static** context-budget line is added to the system prompt. It holds
no numbers on purpose: a changing number in the system prompt would invalidate
the provider's prefix cache on every request, which costs more than it saves.

The design and the two references it distils are in
[docs/distill-design-v3.md](docs/distill-design-v3.md).

---

## Install

### As a DSH plugin

```sh
dsh plugin --profile <your-profile> add dsh-context-keeper
```

Then restart the profile. The plugin registers one prompt section named
`context-keeper:how-to-reason` at order 650, which places it with the other policy
sections — after the deployment persona, before the tool catalog.

To turn it off without uninstalling, either set `enabled: false` in the config
block, or add a patch row:

```yaml
- id: context-keeper
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
git clone https://github.com/Orliba/dsh-context-keeper
cd dsh-context-keeper
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

# context budget: occupancy, band, headroom, last compaction
node bin/cli.mjs context path/to/session.v4.jsonl.zstd

# write a portable handoff package + full archive for a session
node bin/cli.mjs handoff path/to/session.v4.jsonl.zstd --out ./handoff
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
src/session.mjs     session file -> reasoning records + full detail (users/tools/compactions)
src/metrics.mjs     pure metric functions
src/budget.mjs      pure context-budget math (occupancy, bands, ETA)
src/handoff.mjs     pure handoff packaging + archive rendering
src/zstd.mjs        multi-frame decoder
src/render.mjs      table/report formatting
plugin/index.mjs    the host plugin (rule sections + /context-watch + /handoff)
plugin/client.js    the client half (turnTail context badge, colour dot)
plugin/rule.mjs     the rule text
test/               plugin, budget, handoff, client-badge, activation and e2e prompt tests
docs/               calibration data and design notes
```

Run the tests:

```sh
npm test                         # everything below, in order
node test/plugin.test.mjs        # unit: what gets registered
node test/activation.test.mjs    # cordis injection rules
node test/client-badge.test.mjs  # badge math + parity with the host + reminder helpers
node test/client-boot.test.mjs   # mounts the client bundle under the real loader shape
```

---

## License

MIT
