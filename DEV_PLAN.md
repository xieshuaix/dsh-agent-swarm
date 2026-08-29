# dsh-agent-swarm — plan

Multi-agent orchestration in a DSH session. The **main agent** recruits
subagents, plans the orchestration (itself or by delegating planning to one
subagent), executes, then summarizes. The whole lifecycle is observable to the
web UI and the model.

## Reference architecture (established by discovery)

- DSH is Cordis. A plugin = host half (`lib/index.js`, a `ctx` apply) + optional
  client half (`lib/client.js`, a `window.__ModuleLoader__.load` bundle) + a
  `cordis.patch.yml` bundle layer + a `package.json` carrying `dsh.bundle` and
  `dsh.client` manifests. Proven by `dsh-folder-permissions`,
  `dsh-chrom-notification`, `dsh-session-icons`.
- Host subagent seam: `ctx.subagents` (`@deepseek-ai/dsh-subagent`) exposes
  `start(name, request)` → `SubagentRun { id, localAgent, result, dispose }`,
  `startContinuable(spec)`, `followup`, `interrupt`, `listChildren`, `list`.
  Lifecycle events `subagent/start` / `subagent/end` are emitted with
  `{ runId, provider, id, local }` and `{ ...same, stopReason, lastAssistantMessage }`.
- UI data plane precedent: a loopback-only `webServer.register({ kind: "exact",
  path, handler })` route the browser tab fetches (`/folder-permissions/grants`,
  `/session-icons/...`). No custom RPC channel.
- Client slot precedent: `ctx.slots.inject("conversation.view", ...)` registers
  a tab in the conversation view ring (folder-permissions "Permissions" tab).

## Deliverables

```
dsh-agent-swarm/
  lib/store.js         durable per-session swarm projection store  [DONE]
  lib/index.js         host half: ctx.swarm service + command + context + HTTP
  lib/client.js        client half: "Swarm" conversation.view tab
  cordis.patch.yml     bundle patch layer
  package.json         bundle + client manifests
  README.md
  DEV_PLAN.md          this file
```

## Host half — `ctx.swarm` service (lib/index.js)

Injects `["sessions"]` (always present). Provides `ctx.swarm`:

- `state(session)` → current projection (from store, folded with live subagent
  lifecycle)
- `recruit(session, agents[])` → record roster entries (phase → recruiting/planning)
- `setPlan(session, plan[], {delegated})` → set orchestration plan
- `delegatePlan(session, {prompt})` → spawn a one-shot planner subagent, parse
  its structured output into the plan
- `spawn(session, {label, prompt, role, task})` → real `ctx.subagents.start`,
  track the `SubagentRun`, update roster on settle
- `confirm(session)` → awaiting_confirm → executing (spawn queued subagents)
- `cancel(session)` → dispose tracked runs, phase back to recruiting
- `summarize(session, summary)` → phase complete + summary

Subscriptions (event → projection):
- `subagent/start` → roster entry status = active
- `subagent/end`   → roster entry status = complete | error; progress 100 | error
- `session/event`  → mirror lifecycle into the store (deferred via microtask to
  avoid the session re-entrancy guard, same as folder-permissions)

Model surface:
- `/swarm` slash command (`list | recruit | plan | confirm | cancel | summarize`)
- `systemPrompt.context` with the current swarm state (roster + plan + phase)

Data plane (loopback-only):
- `GET  /swarm/state?session=<id>` → `{ ok, swarm }`
- `POST /swarm/state` body `{ session, action, ... }` → mutate + return `{ ok, swarm }`

Provider resolution for spawn: prefer `spawn`, else `fork`, else first listed
from `ctx.subagents.list()`.

## Client half — `lib/client.js`

`window.__ModuleLoader__.load({ id: "dsh-agent-swarm", factory })`. Registers a
`conversation.view` slot (`order` beside the folder-permissions tab) titled
"Swarm" that:
- reads the current session id from `ctx.sessions` (binding/snapshot),
- polls `GET /swarm/state?session=<id>`,
- renders phase, objective, roster cards (status + progress), plan list, and
  summary; confirm/cancel buttons POST to `/swarm/state`.

Styled with the same `--dsw-alias-*` CSS tokens as the sibling plugins.

## UI wiring (`dsh-agent-swarm-ui`) — minimal changes

The UI already abstracts data behind `DshBridge`; `LiveDshBridge` has TODO
stubs for `ctx.swarm`. Wire it to the plugin's data plane instead:

- `src/api/live.ts`:
  - poll `GET /swarm/state?session=<id>`; keep a live cache
  - `getFrame(0)` → synthesize a `SimFrame` from the cache (messages + `swarms`)
  - `getAgentPlan/Todos/Logs/Artifacts` → map from the swarm projection
  - `confirmSwarm`/`cancelSwarm` → `POST /swarm/state`
- `src/api/index.ts`: add `createLiveBridge(sessionId)` helper (no behavior
  change to demo `createBridge()`)

No change to the React component tree, `App.tsx`, types, or demo data.

## Verification

1. `node --test test/store.test.mjs` (store round-trip + coercion).
2. `node --check lib/index.js lib/store.js` (ESM syntax).
3. Install into the web profile (`dsh plugin --profile web add file:...`) and
   restart the host; confirm the Swarm tab mounts and the `/swarm` command works.
4. UI: `tsc`/`vitest` still green after the `live.ts`/`index.ts` edits.

## Order of work

1. store.js ✅
2. lib/index.js (host half)
3. package.json + cordis.patch.yml
4. lib/client.js (client half)
5. README.md + tests
6. Wire UI `live.ts` / `index.ts` (minimal)
7. Verify (tests, install, restart)
