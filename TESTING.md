# Testing dsh-agent-swarm

The plugin is tested across four layers, from pure logic up to a browser-driven
visual check of the UI wired to the real host half.

## Layers

| Layer | Where | What it proves | Run |
|-------|-------|----------------|-----|
| Unit (store) | `test/store.test.mjs` | The durable projection store round-trips, sanitizes, and clamps hostile input. | `node --test` |
| Host e2e | `test/host-e2e.test.mjs` | The full orchestration lifecycle (recruit → plan → confirm → spawn → summarize), the `/swarm` command, the model context, and the HTTP data plane — against a faithful fake Cordis ctx. | `node --test` |
| Client functional | `test/client.test.mjs` | The browser bundle (`lib/client.js`) registers the primitive `conversation.view` "Swarm" tab and the `conversation.chat.turnTail` inline-card seat, and renders without a browser (vm sandbox + stub React). | `node --test` |
| Swarm-tab render | `dsh-agent-swarm-ui/src/components/__tests__/swarmTab.test.tsx` | Renders the client bundle with real React + jsdom: the `conversation.view` tab renders the primitive thin view (basic data), and the turnTail seat mounts the ideal card only at the dispatch turn. | `pnpm test:run` (in the UI) |
| Embed interactions | `dsh-agent-swarm-ui/src/components/__tests__/embed.test.tsx` | The native embed is a live mini-App: agent click → detail popup, canvas opens, and the tasks/percent toggle applies — against a mocked `/swarm/state`. | `pnpm test:run` (in the UI) |
| Inline-card browser check | `scripts/verify-inline-chat.mjs` | **Real GUI**: opens a completed swarm session at `127.0.0.1:3080` and asserts the ideal card mounts inline at the dispatch message while the Swarm tab stays primitive. | `node scripts/verify-inline-chat.mjs` |
| Interaction browser check | `scripts/verify-interactions.mjs` | **Real GUI**: drives the inline card — agent click opens the popup, canvas opens the board, percent toggle applies. | `node scripts/verify-interactions.mjs` |
| UI bridge integration | `dsh-agent-swarm-ui/src/api/__tests__/live.test.ts` | `LiveDshBridge` polls `/swarm/state`, synthesizes a `SimFrame`, maps plan/todos/logs, and POSTs confirm/cancel — against the plugin's exact wire shape. | `pnpm test:run` (in the UI) |
| FE visual e2e | `dsh-agent-swarm-ui/e2e/run-e2e.mjs` | **End to end**: mounts the REAL `lib/index.js` `apply` on a real `node:http` server, serves the built UI, and drives it in system Chrome via Playwright — asserting the swarm panel renders and transitions awaiting_confirm → executing → complete. | `pnpm test:e2e` (in the UI) |

## The host-e2e fake ctx

`test/helpers/fake-ctx.mjs` is a faithful-enough Cordis context double. It
implements exactly the surface `apply(ctx)` touches (`ctx.sessions` as an
injected property, `ctx.get("agents"/"subagents")`, `ctx.provide`/`on`/`inject`/
`logger`, and the `systemPrompt`/`commands`/`webServer` injection scopes). A
controllable `subagents` double (`createFakeSubagents`) lets tests settle
one-shot child runs and assert what the seam was asked to do.

## The visual e2e (the important one)

`dsh-agent-swarm-ui/e2e/run-e2e.mjs` is the answer to "does the FE work as
expected in DSH". It does NOT mock the HTTP layer:

1. `e2e/mock-dsh.mjs` mounts the real `dsh-agent-swarm/lib/index.js` `apply`
   against a real `node:http` server (the fake ctx's `webServer.register` binds
   the plugin's actual `/swarm/state` route), seeds two sessions, and serves the
   built UI from `dist/`.
2. Playwright launches system Chrome (`channel: "chrome"` — no browser download
   needed), loads `/?session=s1`, and asserts the swarm panel, roster, and
   phase badge render; clicks **Allow** and asserts the transition to
   `executing`; then loads `/?session=s2` and asserts the completion banner.
3. Screenshots land in `e2e/.artifacts/` (git-ignored).

Requirements: a built UI (`vite build` — the `test:e2e` script does it) and a
Chrome/Chromium on PATH (or `PLAYWRIGHT_PATH` pointing at a `playwright` install).

## Known mistakes & debugging log

Every bug below was found by running the real thing (a live session driving the
swarm, not just unit tests) and then turned into a regression test so it cannot
come back silently. The test file/name column is where the guard lives.

| # | Symptom | Root cause | Fix | Regression test |
|---|---------|-----------|-----|-----------------|
| 1 | Swarm tab showed `[object Object]` in the phase cell | `kv()` called `String(value)` on a React element | Render the value directly, never stringify | `swarmTab.test.tsx` (`not.toContain("[object Object]")`) |
| 2 | Raw `status_pending`/`status_done` keys leaked into the tab | client DICT had no plan-status keys | Add `status_pending/in_progress/done` + badges | `swarmTab.test.tsx` (dict-resolving `t`) |
| 3 | `plan=0` for every `outlinePlan` agent | The plan JSON is emitted in an **early** `assistant/message`, before the tool loop; the run's final `result.output` no longer carries it | `readChildPlan()` scans the child session events; folded live in `state()` | `host-e2e` "outlined plan is parsed from the child's early assistant message" |
| 4 | Every produced folder stamped with one child's id (artifact over-attribution) | Concurrent spawns share the same `before` snapshot, so `after − before` includes every child's dirs | `childOwnsDir()` prefers the `.dsh-subagent.json` marker, then a child-session event-reference heuristic; `listArtifacts`/`writeMarkersForChild` both filter by ownership | `host-e2e` "artifacts are attributed via … markers" + "state() and completion surface … artifacts" |
| 5 | Every agent showed `avatar=orca` and `mode=continuous` | `coerceSwarm` force-defaulted `avatarId:"orca"` / `progressMode:"continuous"`, so `state()`'s `?? derivation` never fired | Omit those fields when unset; derive in `state()` | `store` "coerceSwarm does not force-default avatarId or progressMode" |
| 6 | The main agent could not call `/swarm` — it wandered off reading DSH/plugin source | `/swarm` was a **user** slash command (`ctx.commands.register`), which is NOT in the agent's tool list | Register an agent-facing `swarm` tool via `ctx.tools.register`, with `tools` declared in the module `inject` | `host-e2e` "registers a callable swarm tool" + `apply.smoke` `inject === ["sessions","tools"]` |
| 7 | Tool `recruit` created agents under random ids, so plan `ownerId`s couldn't reference them | Agent spec without `id` → `recruit()` generated `randomUUID()` | Derive a stable `id` from `name` (same rule as the command) | `host-e2e` tool test (derived `aria` id is findable) |
| 8 | No summary; session showed no main-agent orchestration | The experiment mutated `/swarm/state` over HTTP instead of letting the main agent drive | The `swarm` tool + a natural prompt; the agent does recruit → plan → confirm → summarize | `host-e2e` "swarm tool drives the full lifecycle to a complete, summarized swarm" |
| 9 | `model`/`reasoningEffort` carried in the data plane but never shown in the tab | client roster rendering dropped them | Render a `model/effort` tag per agent | `swarmTab.test.tsx` (asserts `deepseek-v4-flash/off`, `Wave`, logs, summary, topology) |
| 10 | Subagents ignored `reasoningEffort: "off"` (still reasoned) | `AgentOptions` had no `reasoningEffort` field; `dsh-agent-loop` only read provider/model/maxTokens | `scripts/patch-core.mjs` edits `dsh-agent-loop/lib/index.js` to route `reasoningEffort`; re-apply after a DSH upgrade | manual: `grep reasoningEffort …/dsh-agent-loop/lib/index.js` (needs `danger-full-access`) |
| 11 | Phase stuck `executing` / plan stuck `pending` after all agents settled | No close-out when the last child settled | `closeOut(swarm)` self-heals on read + settlement | `host-e2e` "state() self-heals a stale executing projection" |
| 12 | Live UI did not re-render on snapshot change | `DshContext` value identity was stable, so React bailed out children | Context value changes identity on tick (`{bridge, tick}`) | `dsh-agent-swarm-ui` `DshContext.test.tsx` |
| 13 | Ideal UI shell rendered but the SwarmPanel never appeared in live mode | `getFrame()` mapped real parent messages **without** a `swarmPanelId`, and `MessageBubble` only mounts `SwarmPanel` for a message that links one | Attach `swarmPanelId` to the last real message in `getFrame()` | `dsh-agent-swarm-ui` `live.test.ts` "links the SwarmPanel to the LAST real message" |
| 14 | Agent workspace showed empty logs/todos after the run (logs=0, todos=0) | `todos`/`logs` were only folded live from `ctx.sessions`, which DSH unloads once the child finishes | Persist them on the agent at completion (like plan/artifacts) | `host-e2e` "completion persists todos + logs so they survive child-session unload" |
| 15 | Artifacts=0 when subagents wrote files straight into the workspace root (no folder) | `listArtifacts` only scanned top-level **directories** | Also diff root-level files (`topLevelFiles`) and attribute via the child's write-event reference | `host-e2e` "root-level files are captured as artifacts" |
| 16 | Swarm cards only appeared in the Swarm tab, not in the chat where the swarm was dispatched | The ideal panel was only mounted in the `conversation.view` tab | Mount the ideal panel in the chat too (a live seat) | `client.test.mjs` `LiveSwarmDock` + `swarmTab.test.tsx` dock test + `scripts/verify-inline-chat.mjs` |
| 17 | `swarmTab.test.tsx` failed after the tab switched to the native ideal mount | The test still asserted the removed thin `SwarmView` (`toHaveLength(1)`, `text.toContain("recruiting")`, role-prompt text) | Rewrote it to assert the real contract: native `IdealSwarmUI.mount` + the live seat | `swarmTab.test.tsx` (202 UI tests green) |
| 18 | Clicking an agent in the embedded card did nothing; no canvas; the ▣/% toggle was dead | `embed.tsx` rendered `SwarmPanel` with `onAgentClick={() => {}}`, an undefined `onShowCanvas`, and a hardcoded `progressDisplay` — no popup/board/toggle state | Rewrote `embed.tsx` as a live mini-`App` owning `selectedAgent`/`workspaceAgent`/`showBoard`/`progressDisplay`/`avatarOverrides`, rendering `AgentDetailPopup` + `AgentWorkspacePanel` + `OrchestratorBoard` | `embed.test.tsx` (3 tests) + `scripts/verify-interactions.mjs` (7/7) |
| 19 | The ideal card spanned the whole chat width as a bottom panel (wrong design), and the Swarm tab was replaced by the ideal UI (it should stay primitive) | I mounted the ideal panel at `conversation.input.dock` (a full-width band above the composer) and pointed `conversation.view` at `NativeSwarmView` | Restore `conversation.view` as the **primitive** thin `SwarmView` (basic phase/roster/plan/summary), and mount the ideal panel as an **inline card** at the dispatch message via `conversation.chat.turnTail` | `client.test.mjs` + `swarmTab.test.tsx` + `scripts/verify-inline-chat.mjs`/`verify-interactions.mjs` (7/7 each) |
| 20 | Canvas "Open Workspace" opened the workspace panel invisibly **behind** the canvas | `embed.tsx` renders the canvas as a full-window fixed overlay (`zIndex 300`), which sits ABOVE the workspace panel (`zIndex 200`); `openWorkspace` didn't close the canvas | `openWorkspace` also `setShowBoard(false)` so the workspace slide-over is on top | `embed.test.tsx` "canvas agent panel 'Open Workspace' closes the canvas and opens the workspace panel" |
| 21 | `artifacts=0` even after the root-file scan shipped (real DSH toy run) | `childWroteFile`/`childReferencedDir` read `data.input`/`data.args`, but DSH stores tool/call args as a **JSON string under `data.arguments`** (keyed `file_path`), so the filename never matched | `toolCallInput()` normalizes `arguments`/`input`/`args`; `childWroteFile` parses `data.arguments` and matches `file_path`/`path` **precisely** (so a write's *content* naming a sibling file can't mis-attribute it) | `host-e2e` "artifacts read data.arguments (JSON string) and match file_path precisely" |
| 22 | `systemPrompt` lacked the `Role:` line even though `rolePrompt` was set | `confirm` passed an explicit `prompt` (objective + task) to `spawn`, and spawn's explicit-prompt branch dropped the `Role:` label | `confirm` passes `objective` (not `prompt`); `spawn` composes `Role:`/`Objective:`/`Task:` labels in both prompt branches | `host-e2e` "recruit → confirm propagates per-agent model, rolePrompt, and outlinePlan to spawn" (`Role:`/`Objective:`/`Task:` assertions) |

The pattern to keep: when a real run misbehaves, write the smallest test that
reproduces the symptom against the fake ctx / store / client bundle, then fix
until green — so the fix and its reason are pinned together.
