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
exposes `window.IdealSwarmUI.mount(container, { sessionId })`. Rebuild it
whenever `dsh-agent-swarm-ui` changes:

```sh
cd dsh-agent-swarm-ui
pnpm exec vite build --config vite.lib.config.ts
cp dist-embed/ideal-swarm-ui.js dist-embed/ideal-swarm-ui.css ../dsh-agent-swarm/ui-dist/
```

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
```

## Tests

```sh
node --test test/*.test.mjs
```
