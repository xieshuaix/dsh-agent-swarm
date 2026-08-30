# BOOTSTRAP — what to read when lost (swarm plugin + UI)

Minimal re-orientation for the `dsh-agent-swarm` plugin + `dsh-agent-swarm-ui`
work. Read the **concepts** first, then the **docs** when you need specifics.

## Concepts (the mental model)

1. **DSH plugin = dual half.** One package carries a host half (`lib/index.js`, a
   Cordis `apply(ctx)`) and a client half (`lib/client.js`, a
   `window.__ModuleLoader__.load` closure bundle). The host half provides
   services/data; the client half registers UI slots. See
   `docs/DSH_FRAMEWORK.md`.

2. **Subagent seam** (`ctx.subagents`): `start(provider, request)` → one-shot
   `SubagentRun { id, result, dispose }`; lifecycle events
   `subagent/start` / `subagent/end`. The `request` carries `prompt`, `parent`,
   `agentOptions` (model/reasoningEffort/maxTokens), `persona`, `outputSchema`,
   `toolFilter`. See `docs/DSH_FRAMEWORK.md` §2.

3. **Model routing + reasoning effort.** `agentOptions.model` routes the child
   (e.g. `deepseek-v4-flash`). `reasoningEffort` requires the core patch
   (`scripts/patch-core.mjs`) because `dsh-agent-loop` `buildRequest` ignores
   `AgentOptions.reasoningEffort` by default. `"off"` = DeepSeek thinking disabled.
   See `README.md` "Model routing + reasoning effort".

4. **Prompt-driven data protocol.** A subagent only emits plan/todos/role/
   artifacts when the spawn `spec` asks: `rolePrompt` → `persona`;
   `outlinePlan: true` → a parseable JSON plan directive; todos come from the
   child's standard `todo/write` events. See
   `../dsh-agent-swarm-ui/SWARM_PROTOCOL.md`.

5. **Event channel.** Every swarm state change publishes one envelope
   `{ts, sessionId, type, data}` on three channels: the Cordis bus
   (`ctx.emit("swarm/event")`), a JSONL log
   (`$DSH_HOME/agent-swarm/events/<sessionId>.jsonl`), and an SSE endpoint
   (`/swarm/events?session=<id>`). The tab subscribes via SSE (event-driven),
   with a slow poll fallback.

6. **Session/workspace lifecycle (HTTP API).** `POST /api/<method>` with a
   `client-request` envelope. `workspace.create({path})` adopts an existing dir;
   `session.create({workspaceId})` → grouped session; `session.prompt`
   materializes the agent; **fresh session per experiment round** (never reuse —
   history biases the main agent). (This is DSH's generic `/api/<method>` RPC —
   see `docs/DSH_FRAMEWORK.md` §7 for the client `sessions`/`workspaces`
   services.)

7. **Self-heal + close-out.** `closeOut()` marks owned plan items done and flips
   `executing → complete` when all agents are terminal; it runs on read (in
   `state()`) and on settlement, so stale projections self-correct.

## Docs (the source of truth)

> The `dsh-agent-swarm-ui/…` entries require a **sibling checkout** of
> `dsh-agent-swarm-ui` (`git clone https://github.com/xieshuaix/dsh-agent-swarm-ui.git`
> next to this repo).

| When you need | Read |
|---------------|------|
| Plugin overview, install, model-routing patch, demo tests | `dsh-agent-swarm/README.md` |
| DSH concepts (host/client/BE↔FE wiring) | `dsh-agent-swarm/docs/DSH_FRAMEWORK.md` |
| Debugging tools + where-to-look per bug | `dsh-agent-swarm/docs/DEBUGGING.md` |
| The full data-gap list (accessible vs implemented) | `dsh-agent-swarm-ui/SWARM_DATA_GAP.md` |
| The prompt-driven protocol + event channel | `dsh-agent-swarm-ui/SWARM_PROTOCOL.md` |
| UI component map + click sequence | `dsh-agent-swarm-ui/IDEAL_UI_INTERACTION_MAP.md` |
| UI architecture + bridge abstraction | `dsh-agent-swarm-ui/ARCHITECTURE.md` |
| Building the UI into the plugin | `dsh-agent-swarm-ui/BUILD.md` |
| Test pyramid + how to run | `dsh-agent-swarm/TESTING.md` |

## Key paths

```
dsh-agent-swarm/            plugin (host + client halves)
  lib/index.js              host half: ctx.swarm + tool + command + context + HTTP/SSE
  lib/client.js             client half: primitive Swarm tab + inline ideal card
  lib/store.js              durable per-session projection (coerceSwarm)
  ui-dist/                  built ideal-UI embed library (shipped in the package)
  docs/                     DSH_FRAMEWORK.md, DEBUGGING.md
  scripts/                  session tests, verify scripts, patch-core, migrate
dsh-agent-swarm-ui/         ideal UI source + bridge abstraction
  src/embed.tsx             the live embed (window.IdealSwarmUI.mount)
  src/api/live.ts           LiveDshBridge → /swarm/state
  src/types.ts              the ideal UI's full data model
```

## Repos & branches

- plugin `dsh-agent-swarm` — branch `main`.
- UI `dsh-agent-swarm-ui` — branch `ideal-swarm-ui` (the built bundle ships into
  the plugin's `ui-dist/`; source stays here).
