# BOOTSTRAP — what to read when lost (swarm plugin + UI)

Minimal re-orientation for the `dsh-agent-swarm` plugin + `dsh-agent-swarm-ui`
work. Read the **concepts** first, then the **docs** when you need specifics.

## Concepts (the mental model)

1. **DSH plugin = dual half.** One package carries a host half (`lib/index.js`, a
   Cordis `apply(ctx)`) and a client half (`lib/client.js`, a
   `window.__ModuleLoader__.load` closure bundle). The host half provides
   services/data; the client half registers UI slots. See
   `../dsh-extension-guidance/README.md` §1–§5.

2. **Subagent seam** (`ctx.subagents`): `start(name, request)` → one-shot
   `SubagentRun { id, result, dispose }`; `listChildren`; lifecycle events
   `subagent/start` / `subagent/end`. The `request` carries `prompt`, `parent`,
   `agentOptions` (model/maxTokens), `persona`, `outputSchema`, `toolFilter`.

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
   `client-request` envelope. `session.create({workspaceId})` → grouped session
   (use this, not `cwd`); `session.prompt` materializes the agent; **fresh
   session per experiment round** (never reuse — history biases the main agent).
   See `../dsh-extension-guidance/README.md` §11.

7. **Self-heal + close-out.** `closeOut()` marks owned plan items done and flips
   `executing → complete` when all agents are terminal; it runs on read (in
   `state()`) and on settlement, so stale projections self-correct.

## Docs (the source of truth)

| When you need | Read |
|---------------|------|
| Plugin overview, install, model-routing patch | `dsh-agent-swarm/README.md` |
| The full data-gap list (accessible vs implemented) | `dsh-agent-swarm-ui/SWARM_DATA_GAP.md` |
| The prompt-driven protocol + event channel | `dsh-agent-swarm-ui/SWARM_PROTOCOL.md` |
| UI architecture + bridge abstraction | `dsh-agent-swarm-ui/ARCHITECTURE.md` |
| Test pyramid + how to run | `dsh-agent-swarm/TESTING.md` |
| Cross-plugin DSH guidance (dual-half, slots, sessions, HTTP API) | `dsh-extension-guidance/README.md` |
| This turn's plan | `dsh-agent-swarm/PHASE_DATA_INTERFACE.md` |

## Key paths

```
dsh-agent-swarm/            plugin (host + client halves)
  lib/index.js              host half: ctx.swarm + event channel + data plane
  lib/client.js             client half: Swarm tab (conversation.view)
  lib/store.js              durable per-session projection (coerceSwarm)
  scripts/patch-core.mjs    reasoning-effort core patch (fast testing)
dsh-agent-swarm-ui/         rich Figma UI + bridge abstraction
  src/api/live.ts           LiveDshBridge → /swarm/state
  src/types.ts              the ideal UI's full data model
dsh-extension-guidance/     cross-plugin guidance (not yet a git repo)
```

## Branch map

- plugin `main` ↔ UI `main` (branch 2): integration + minimal Swarm tab.
- UI `ideal-swarm-ui` (branch 3): the real visualization to build next.
- UI `figma-baseline` (branch 1): the original Figma scaffold.
