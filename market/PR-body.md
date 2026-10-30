# Add dsh-context-keeper

Adds one entry: `data/plugins/Orliba__dsh-context-keeper.yml`.

- Repo: https://github.com/Orliba/dsh-context-keeper
- Category: `session` (context-budget watching + handoff of a long session)
- `package.json` declares `dsh.bundle.patch` (`./cordis.patch.yml`) and `dsh.client` (`web`).
- Real working host + client code, offline test suites green.
- Repo carries the `dsh-plugin` topic.

What it does, stated plainly (all checked against the code):

- Host plugin registers a static reasoning-rule prompt section and a static context-budget nudge (no numbers in the prompt, so the prefix cache is never invalidated), plus two human commands: `/context-watch` (occupancy, band, headroom, growth, last compaction) and `/handoff` (writes a handoff package + full archive into `<cwd>/.context-keeper/handoff`). Both read the session file DSH already writes and call a model zero times.
- Client half (`plugin/client.js`) draws a colour dot in the `conversation.chat.turnTail` seat every turn, reading the official `contextPressure` projection: green <50% / yellow 50-65% / orange 65-80% / red >=80%. At orange/red it also shows a reminder panel in `conversation.composer.dock` with a one-click new-session handoff button (`session.create` + `session.prompt`). Pure presentation + one explicit click; no tokens spent until the button is pressed.

Honest limits (also in the README): the badge shows only when the projection is available; the new-session button cannot auto-navigate to the created session (the slot API has no navigation), so the panel says to open it from the sidebar; command names are lower-case because of the `^[a-z][a-z0-9_-]*$` rule.