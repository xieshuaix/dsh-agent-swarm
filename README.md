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
- **`GET/POST /swarm/state`** — loopback-only HTTP data plane the web tab polls.
- **"Swarm" tab** — a `conversation.view` tab rendering phase, roster cards,
  plan list, and summary, with confirm/cancel actions.
- **"Ideal UI" tab** — a second `conversation.view` tab that embeds the full
  ideal swarm UI (`dsh-agent-swarm-ui`, the Figma app) in an iframe served from
  this plugin at `/dsh-agent-swarm/ui/`. The ideal UI fetches `/swarm/state` on
  the native DSH origin, so no separate host and no core patch is needed.

### Refreshing the embedded ideal UI

The embedded bundle is a build of `dsh-agent-swarm-ui` copied to `ui-dist/`:

```sh
cd dsh-agent-swarm-ui && pnpm run build
rm -rf ../dsh-agent-swarm/ui-dist && mkdir -p ../dsh-agent-swarm/ui-dist
cp -R dist/. ../dsh-agent-swarm/ui-dist/
```

Re-run this whenever the ideal UI changes, then reinstall/restart the host.

## Install

From inside the profile directory (e.g. `$DSH_HOME/profiles/web`):

```sh
dsh plugin --profile web add file:/path/to/dsh-agent-swarm
```

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
lib/client.js      client half: the "Swarm" conversation.view tab
lib/store.js       durable per-session swarm projection store (unit-tested)
scripts/patch-core.mjs  one-time core patch: subagent reasoning-effort routing
cordis.patch.yml   bundle patch layer
package.json       bundle + client manifests
```

## Tests

```sh
node --test test/*.test.mjs
```
