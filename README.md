# dsh-agent-swarm

Multi-agent orchestration in a DeepSeek Harness session. The **main agent**
recruits subagents, plans the orchestration (its own plan, or by **delegating
planning to one subagent**), executes, and **summarizes** at the end — with the
whole lifecycle observable in the web UI and to the model.

Implements the *"dsh-agent-swarm"* extension idea as a self-contained Cordis
plugin over the harness's real subagent seam (`ctx.subagents`). No core/harness
patch is required; a one-time plugin install + host restart is all it takes.

## What it does

| Stage | Mechanism |
|-------|-----------|
| **Recruit** | `ctx.swarm.recruit(session, agents)` records the roster; `ctx.swarm.spawn(...)` launches real one-shot subagents via `ctx.subagents.start`. |
| **Plan** | `ctx.swarm.setPlan(...)` records the main agent's plan; `ctx.swarm.delegatePlan(...)` spawns a one-shot *planner* subagent and adopts its structured plan. |
| **Confirm / execute** | `ctx.swarm.confirm(...)` moves `awaiting_confirm → executing`; subagent `subagent/start` / `subagent/end` lifecycle edges update roster status and progress. |
| **Summarize** | `ctx.swarm.summarize(session, text)` closes the swarm and records the summary. |

The **main agent** drives these through the `/swarm` slash command (and the
model-facing swarm-state context); the **web UI** drives them through the
loopback HTTP data plane. The plugin never runs its own LLM loop.

## Surfaces

- **`ctx.swarm`** — first-class service: `state`, `recruit`, `setPlan`,
  `delegatePlan`, `spawn`, `confirm`, `cancel`, `summarize`.
- **`/swarm`** slash command — `list | recruit | plan | confirm | cancel | summarize`.
- **system-prompt context** — the active session's swarm phase, objective,
  roster, and plan are injected into the model's context.
- **`GET/POST /swarm/state`** — loopback-only HTTP data plane the web UI polls.
- **"Swarm" tab** — the **primitive** `conversation.view` tab: basic data only
  (phase, objective, roster, plan, summary) polled from `/swarm/state` — no
  complicated UI.
- **Ideal card in the chat** — the **ideal** SwarmPanel (rich, interactive
  agent cards) mounts as a **720px card inline in the conversation, at the
  moment the swarm is dispatched** — a `conversationEvents` chat node
  (`swarm-card`, keyed on `conversation.chat.node`) that publishes during the
  turn when the `swarm` tool's `recruit` call fires. It appears live from
  recruiting onward, like a chat/think block, not a bottom dock. The embed
  adapts to the host theme (light/dark) and is fully interactive — agent click
  opens the detail popup, the canvas opens the orchestrator board, and the
  tasks/percent toggle works.

### Refreshing the embedded ideal UI

The ideal UI's **source** lives in the separate `dsh-agent-swarm-ui` repo; this
repo only carries its **built bundle** in `ui-dist/`. `ui-dist/` holds the
embed library — an IIFE build (`ideal-swarm-ui.js` + `ideal-swarm-ui.css`) that
exposes `window.IdealSwarmUI.mount(container, { sessionId })`. Rebuild + sync it
whenever `dsh-agent-swarm-ui` changes (one command, from the UI repo):

```sh
cd dsh-agent-swarm-ui
pnpm build:plugin      # builds dist-embed/ and copies into ../dsh-agent-swarm/ui-dist/
```

This also writes `ui-dist/version.json` (`{ uiVersion, uiCommit, builtAt }`) so
you can tell which UI commit produced the bundle. See the UI repo's `BUILD.md`
for the full reproducible guide.

Then **refresh the browser** — the client half is served from the plugin's
`lib/client.js` and re-read per request, so no host restart is needed for
client-half or embed-library changes (a host restart is only required for
host-half `lib/index.js` changes).

## Install

One line, from npm (once published):

```sh
dsh plugin --profile web add dsh-agent-swarm
```

Or straight from git — no publish step needed:

```sh
dsh plugin --profile web add git+https://github.com/<you>/dsh-agent-swarm.git
```

Or from a local checkout (development):

```sh
dsh plugin --profile web add file:/path/to/dsh-agent-swarm
```

The package is **self-contained**: it bundles `lib/` (host + client halves),
`ui-dist/` (the built ideal-UI embed library), and `cordis.patch.yml`. Installing
requires **no separate UI repo, no build step, and no submodule** — the ideal UI
ships inside this one package.

This appends `dsh-agent-swarm` to `dsh.profile.bundles`. Restart the host once
to load it; the **Swarm** tab then appears in the conversation view ring beside
Chat / Trajectory / Context.

## Configuration

The bundle `config` is optional (all keys have defaults):

```yaml
- id: agent-swarm
  name: dsh-agent-swarm
  config:
    concurrencyLimit: 3        # 1..64, default 3
    providers: []              # spawn → fork → first registered, default []
```

## Persistence

Presentation projections live in a per-session JSON file under
`$DSH_HOME/agent-swarm/` (atomic writes, isolated per session, survives a host
restart). The authoritative subagent truth stays in `ctx.subagents` and the
owning session log; the store is a durable cache, never the source of
orchestration truth.

## Model routing + reasoning effort (core patch, for fast testing)

`spawn(session, spec)` accepts `model` / `reasoningEffort` / `maxTokens` per
subagent (the main agent decides by task difficulty/nature):

- `model` — routes the child to a cheap model (e.g. `deepseek-v4-flash`) via
  `agentOptions`. This works out of the box.
- `reasoningEffort` — `"off"` (thinking disabled) | `"low"` | `"high"` | `"max"`.
  Requires the one-time core patch below, because the request-builder
  (`dsh-agent-loop` `buildRequest`) does not read `AgentOptions.reasoningEffort`
  by default — the effort falls back to the deployment default.

This patch exists **so experiments stay cheap**: without `"off"`, subagents on a
reasoning-capable model still spend reasoning tokens (and time). Apply once
(idempotent), then **restart the host**:

```sh
pnpm run patch:core -- --checkout /path/to/@deepseek-ai/dsh
# or directly:
node scripts/patch-core.mjs --checkout /path/to/@deepseek-ai/dsh
```

Re-apply after every DSH upgrade (the patch edits a built package file; an
upgrade replaces it).

## Files

```
lib/index.js       host half: ctx.swarm service + command + context + HTTP
lib/client.js      client half: native ideal-UI "Swarm" tab + inline turnTail
lib/store.js       durable per-session swarm projection store (unit-tested)
ui-dist/           built ideal-UI embed library (shipped in the package)
scripts/patch-core.mjs  one-time core patch: subagent reasoning-effort routing
scripts/verify-inline-chat.mjs  browser check: inline cards + Swarm tab
cordis.patch.yml   bundle patch layer
package.json       bundle + client manifests
docs/DSH_FRAMEWORK.md  how DSH works (host/client/BE↔FE wiring) for developing this plugin
docs/DEBUGGING.md      tools, guidance, and where-to-look for each bug class
```

## Tests & demo runs

### Unit / integration

```sh
node --test test/*.test.mjs    # host half + client half + store — no host needed
```

### End-to-end session runs (main-agent-driven)

Each runner creates a fresh, isolated workspace under `dsh-agent-swarm-tests/<test>/`
(session named `swarm experiment <round>`), prompts the main agent with a natural
task, then observes `/swarm/state` until the swarm completes and a summary is
recorded. Requires a running host with the plugin installed.

| Script | What it does | Agents | Duration |
|---|---|---|---|
| `node scripts/run-swarm-session-test-toy.mjs [round]` | **Toy** — minimal click-counter web app (index.html / style.css / app.js / README.md). The smallest working end-to-end test. | 4 | ~1–2 min |
| `node scripts/run-swarm-session-test-search-fe.mjs [round]` | **Search (multi-modal)** — build a multi-modal search API (frontend + embedding backend + API schema + smoke tests). Longer than toy. | 4 | ~2–5 min |
| `node scripts/run-swarm-session-test-scale.mjs [round]` | **Scale** — 20 theme designers at concurrency 5, each writing one CSS theme + a doc. Exercises large multi-agent orchestration. | 20 (concurrency 5) | ~2–4 min |

Every runner finishes with a per-agent table and an at-a-glance check:

```
agents with own plan: N/N; agents with >=1 artifact: N/N
```

`[round]` is any number; pass a fresh one per run (it names the session and
workspace).

### Verify scripts

| Script | What it checks |
|---|---|
| `node scripts/verify-data-completeness.mjs <sessionId>` | Reads the JSONL event log + `/swarm/state`; asserts phase evolution and per-agent plan/todo/artifact/log completeness. No UI. |
| `node scripts/verify-real.mjs [sessionId]` | Mounts the real host half against a real completed session's evidence (no running host) and checks the full projection. |
| `node scripts/verify-inline-chat.mjs [title] [id]` | Browser check: the ideal card mounts inline in chat and the Swarm tab stays primitive. |
| `node scripts/verify-interactions.mjs [title] [id] [agentName]` | Browser check: agent click → popup, canvas, progress toggle, canvas → workspace. |

### Legacy / utilities

- `node scripts/run-experiment.mjs [round]` — older HTTP-driven experiment (drives
  the swarm via `POST /swarm/state` directly, not via the main agent).
- `node scripts/patch-core.mjs --checkout <path>` — one-time core patch for
  subagent `reasoningEffort` routing (see "Model routing" above).
- `node scripts/migrate-test-workspaces.mjs` — migrate old test workspaces into
  `dsh-agent-swarm-tests/<test>/`.
