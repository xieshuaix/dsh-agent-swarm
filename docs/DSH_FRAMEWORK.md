# DSH framework & data-wiring notes (critical for dsh-agent-swarm)

Reverse-engineered understanding of DeepSeek Harness (DSH) that this plugin
depends on, distilled so future work on `dsh-agent-swarm` does not have to re-read
the whole codebase. Covers the **backend half** (host/Cordis), the **frontend
half** (browser/client), and the **BE↔FE integration / data wiring** between them,
plus the fragility points to re-check after a DSH upgrade.

> The installed DSH tree at
> `/Users/xs/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh`
> contains only the **published** `apps/cli` package and its `node_modules`. There
> is **no full monorepo checkout** — client packages are readable only through
> their built artifacts (`node_modules/@deepseek-ai/dsh-*/lib/client.js` closures)
> and `lib/types/**/*.d.ts`. Everything below was determined from those.

---

## 1. The plugin is dual-half: host + client + an embedded UI

Three coordinated pieces, wired by `package.json`:

| Piece | Where | Wired by |
| --- | --- | --- |
| **Host half** (`lib/index.js`) | Node (`dsh web`) | `main` + `dsh.bundle.patch` → `cordis.patch.yml` `insert` row |
| **Client half** (`lib/client.js`) | Browser | `dsh.client` (`platform: "web"`, `inject: [...]`) + `exports["./client"]` |
| **Ideal UI** (`ui-dist/`) | Browser (embedded) | built from the separate `dsh-agent-swarm-ui` repo; shipped inside this package |

`package.json` essentials:

```jsonc
{
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib", "ui-dist", "scripts", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  }
}
```

`cordis.patch.yml` is the bundle layer: `insert: [{ id: "agent-swarm", name: "dsh-agent-swarm", config: { concurrencyLimit, providers } }]`. Installing the package appends it to `dsh.profile.bundles` (via `dsh plugin add` reconciliation); the row loads `main` as a Cordis plugin.

### The client half is only discovered if the host row mounts

The client module system scans the **host Loader's live fibers**; a package whose
host row never mounts is never picked up client-side. `lib/index.js` therefore is
**not** a no-op — it registers the real host half — but the rule still matters:
if the host half throws at load, the client half disappears too.

### Installing

```sh
dsh plugin --profile web add git+https://github.com/xieshuaix/dsh-agent-swarm.git
# dev:  dsh plugin --profile web add file:/abs/path/to/dsh-agent-swarm
```

`dsh plugin add` runs `pnpm add` in the profile dir, then reconciles
`dsh.profile.bundles` (any dependency declaring `dsh.bundle.patch` joins the
stack). A **new** bundle requires a **host restart**.

---

## 2. Host half (BE): a Cordis plugin

`lib/index.js` declares `name = "agent-swarm"` and `inject = ["sessions", "tools"]`
(module inject = Cordis services consumed at load; optional services are read
lazily via `ctx.get(...)`).

The `apply(ctx, config)` does:

- `ctx.provide("swarm", { state, recruit, setPlan, setTopology, delegatePlan, spawn, confirm, cancel, summarize })` — first-class service.
- `ctx.tools.register({ name: "swarm", ... })` — the **agent-facing** tool the main agent calls (`action=recruit/plan/confirm/cancel/summarize/state`).
- `ctx.inject(["systemPrompt"], ...)` — injects the live swarm phase/objective/roster/plan into the model context (`swarm:state`).
- `ctx.inject(["commands"], ...)` — the `/swarm` user slash command.
- `ctx.inject(["webServer"], ...)` — registers three routes: `GET/POST /swarm/state`, `GET /swarm/events` (SSE), and `GET /dsh-agent-swarm/ui/*` (static embed).
- `ctx.on("subagent/start" | "subagent/end" | "session/event", ...)` — lifecycle edges.

Optional services it reaches through `ctx.get(...)`:

| `ctx.get(...)` | Used for |
| --- | --- |
| `"subagents"` | `subagents.start(provider, {...})` — spawn one-shot children |
| `"agents"` | `agentForSession` — resolve the live parent agent for a session |

`ctx.subagents.start` returns a **run** handle `{ id, result, dispose }`; the run
id becomes the child session id (`entry.childId = run.id`), and `ctx.sessions.get(childId)`
reads the child's events later.

### The `swarm` tool schema (agent-facing)

The model drives the whole lifecycle through ONE tool. Its `parameters` are:
`action` (enum) + `agents[]` (recruit) + `plan[]` (plan) + `objective` +
`concurrency` + `summary`. `recruit` derives a stable agent id from `name`
(`name.toLowerCase().replace(/\W+/g, "-")`) so plan `ownerId`s can reference it.

### Subagent lifecycle

1. `recruit` records roster entries (`status: "queued"`).
2. `plan` records the plan (`phase: "awaiting_confirm"`).
3. `confirm` spawns each queued agent via `subagents.start`, **draining in waves of
   `concurrencyLimit`** (spawn a batch, await every run's settlement, spawn the next).
4. `run.result.then(...)` settles the agent: status, outlined plan (parsed from the
   child's early `assistant/message`), artifacts/todos/logs (read from `ctx.sessions`
   while still loaded), persisted to the store.
5. `summarize` closes (`phase: "complete"`).

`subagent/start` / `subagent/end` events mirror the roster too (belt-and-suspenders).

---

## 3. Client half (FE): a browser closure

`lib/client.js` is a **CJS closure** registered at eval time:

```js
window.__ModuleLoader__.load({
  id: "dsh-agent-swarm",
  factory: (require) => {
    module.exports = {
      name: "dsh-agent-swarm",
      inject: ["slots", "locale", "conversationEvents"],
      apply(ctx) { /* … */ },
    }
  }
})
```

- `id` must equal the package name.
- `inject` on `module.exports` lists **Cordis services** the client `apply` needs
  (distinct from `dsh.client.inject`, which lists client **module** edges).
- The factory only registers; it materializes on first import.

### What the client `apply` does

1. Registers the **primitive** `conversation.view` slot (`SwarmView`) — thin
   basic-data tab, polled from `/swarm/state`.
2. Registers a **keyed chat node renderer** on `conversation.chat.node` with
   `key: "swarm-card"` — mounts the ideal UI inline at the dispatch message.
3. Registers a **custom conversation node** via `ctx.conversationEvents.register`:
   `{ kind: "swarm-card", target: "chat", match, start, update, publication: () => "immediate", buildViewNode }`.
   `match` fires on the `swarm` tool call (`recruit` → role "start", `plan`/`confirm`
   → role "update"); `buildViewNode` anchors it at `seq + 0.1` in the message flow.
4. Loads the embed library (`<link>/<script>` to `/dsh-agent-swarm/ui/ideal-swarm-ui.*`)
   and calls `window.IdealSwarmUI.mount(container, { sessionId })`.

### Slot facts

- `ctx.slots.inject(slotName, () => ctx.slots.register({ name, id/key, order, locale }, render))`.
- `conversation.view` is a `list` slot (the tab ring shows all entries).
- `conversation.chat.node` is keyed by node `kind` — the renderer is looked up by
  `key: "swarm-card"`.

---

## 4. BE↔FE integration & data wiring (the important part)

### 4.1 The projection is the contract

The FE never talks to `ctx.swarm` directly — it polls HTTP. The **single source of
truth** is `state(session, latest)` in the host half, serialized by `/swarm/state`.

`state(session)` returns (and `/swarm/state` serves):

```jsonc
{
  // swarm-level (persisted) …
  "phase": "executing", "objective": "…", "plan": [{ "id","title","status","ownerId","minProgress","maxProgress" }],
  "summary": "…", "concurrencyLimit": 5, "recruitedCount": 20, "completedCount": 13,
  "batch": 1,
  // …plus derived presentation:
  "agents": [ /* see below */ ],
  "resources": [{ "id","name","rtype","ownerId","zone" }],   // zone === ownerId ⇒ exclusive
  "lines":    [{ "from","to","type": "delegates"|"reports" }],
  "positions": { "<agentId>": { "x","y" } },
  "messages": [ /* parent session assistant messages + tool calls */ ],
  "workspaceRoot": "/abs/path/to/workspace"
}
```

Each **agent** projection folds live child evidence + presentation metadata:

```jsonc
{ "id","name","role","task","status","progress","childId",
  "rolePrompt","model","reasoningEffort","outlinePlan",
  "plan":[…], "todos":[…], "logs":[…], "artifacts":[…],
  "systemPrompt","agentsMd",
  "color","avatarId","progressMode","discreteTotal","wave" }
```

`view=latest` filters to the current `batch` (one `swarm` dispatch) so the ideal UI
shows only the latest call, while the primitive tab shows every batch (session-level).

### 4.2 How each field is derived (data sourcing)

| Field | Mechanism |
| --- | --- |
| `plan` | child's early `assistant/message` fenced-JSON plan (`outlinePlan`), else the swarm plan items owned by the agent |
| `todos` | latest `todo/write` event in the child session |
| `logs` | child session `tool/call` / `tool/result` / `assistant/message` events |
| `artifacts` | workspace files the child **wrote** (root files via write-event `file_path`; directory files attributed **per file**; marker fallback after child unload) |
| `rolePrompt` / `systemPrompt` | spawn spec → composed prompt (`Role:`/`Objective:`/`Task:` labels) |
| `agentsMd` | workspace `AGENTS.md` (or `.dsh/AGENTS.md`, `CLAUDE.md`) |
| `resources` | artifacts → `{ ownerId, zone: ownerId }` (exclusive by default) |
| `lines` | plan `ownerId`s (resolved to agent ids) → orchestrator→owner `delegates`, owner→orchestrator `reports` |

**Fragility:** several of these read `event.data.arguments` (a JSON *string*), not
`event.data.input`/`args`. See §7.

### 4.3 HTTP routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/swarm/state?session=<id>&view=latest` | GET | the projection (loopback) |
| `/swarm/state` | POST `{ session, action }` | `confirm` / `cancel` / `topology` |
| `/swarm/events?session=<id>` | GET (SSE) | `swarm/*` event stream |
| `/dsh-agent-swarm/ui/*` | GET | the built embed (`ui-dist/`) |

### 4.4 Event channel (one envelope, three channels)

Every state change is published as `{ ts, sessionId, type, data }` on:

1. the Cordis bus (`ctx.emit("swarm/event", …)`),
2. a JSONL log `$DSH_HOME/agent-swarm/events/<sessionId>.jsonl`,
3. the SSE endpoint.

Types: `swarm/phase`, `swarm/recruited`, `swarm/plan`, `swarm/agent/child`,
`swarm/agent/status`, `swarm/agent/plan`, `swarm/summary`.

The client subscribes to SSE with a slow-poll fallback, and re-reads `/swarm/state`
on each event (debounced).

### 4.5 The ideal UI (embed library)

The **source** lives in the separate `dsh-agent-swarm-ui` repo. Only its **built
bundle** ships here in `ui-dist/`:

- `vite.lib.config.ts` → IIFE (`dist-embed/`) inlining React; `window.IdealSwarmUI.mount(container, { sessionId })`.
- `pnpm build:plugin` builds + copies `ideal-swarm-ui.js`/`.css` into `ui-dist/` and stamps `ui-dist/version.json`.
- The host serves `ui-dist/` at `/dsh-agent-swarm/ui/*`; the client injects those URLs.

Inside the embed, `LiveDshBridge` polls `/swarm/state?…&view=latest` (1500 ms) and
synthesizes a `SimFrame` (`swarms`, `messages`, …) so the same React tree renders
live data. Theme is detected from the host's `<html>` `color-scheme`.

---

## 5. Persistence

The swarm store (`lib/store.js`) is a per-session JSON file under
`$DSH_HOME/agent-swarm/<sessionId>.json` — a **durable cache**, never the source of
truth. The authoritative subagent truth stays in `ctx.subagents` + the owning
session log. `state()` self-heals stale projections (e.g. `closeOut` when all
agents are terminal but `phase !== "complete"`).

---

## 6. Testing strategy

| Layer | Where | What |
| --- | --- | --- |
| Store unit | `test/store.test.mjs` | round-trip + sanitize |
| Host e2e | `test/host-e2e.test.mjs` | full lifecycle against a **fake Cordis ctx** (`test/helpers/fake-ctx.mjs`) + controllable `subagents` double |
| Client | `test/client.test.mjs` | bundle registers slots + node definition (vm + stub React) |
| UI (in the UI repo) | `dsh-agent-swarm-ui` vitest | `swarmTab.test.tsx`, `embed.test.tsx`, `live.test.ts` (mocked `/swarm/state`) |
| Browser | `scripts/verify-inline-chat.mjs`, `verify-interactions.mjs` | real GUI assertions |
| Session runs | `scripts/run-swarm-session-test-{toy,search-fe,scale}.mjs` | real end-to-end (main-agent-driven) |

The fake ctx (`fake-ctx.mjs`) implements exactly the surface `apply(ctx)` touches;
`createFakeSubagents()` lets tests settle one-shot runs and inspect the spawn request.

---

## 7. Upgrade-fragility checklist (re-check first)

1. **Host discovery** — `name`, `inject`, `main` still resolve; `cordis.patch.yml`
   `insert` row still correct; `dsh.client.platform === "web"`, `exports["./client"]` resolves.
2. **Client services** — `slots`, `locale`, `conversationEvents` still provided;
   the `dsh.client.inject` module ids still exist.
3. **Conversation node API** — `ctx.conversationEvents.register` still takes
   `{ kind, target, match, start, update, publication, buildViewNode }`; the
   `conversation.chat.node` slot still keyed by node `kind`.
4. **Event shape** — child `tool/call` args are `data.arguments` (JSON string), and
   `todo/write` / `assistant/message` shapes are unchanged (they feed plan/todos/logs).
5. **Subagent seam** — `ctx.subagents.start(provider, { label, prompt, parent, signal, persona, agentOptions })` unchanged; `run.id`/`run.result`/`run.dispose` still the run contract.
6. **`ctx.sessions.get(childId)`** still returns `{ events: [...] }` for a child while
   it runs (garbage-collected after — hence persistence at settle time).
7. **Web server** — `scope.webServer.register({ kind: "prefix"/"route", path, handler })` unchanged; the `/swarm/state` + SSE + `/dsh-agent-swarm/ui` routes still bind.
8. **Tool API** — `ctx.tools.register({ name, description, parameters, output, execute })` unchanged; the model-facing tool is still reachable (this is how the main agent drives the swarm).
9. **`reasoningEffort` core patch** — `scripts/patch-core.mjs` edits
   `dsh-agent-loop`'s request builder; re-apply after every DSH upgrade.

---

## Key package map (where to look)

| Concern | Package / file |
| --- | --- |
| Profile boot, bundle layer | `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/cordis-plugin-loader` |
| Client bundle discovery | `@deepseek-ai/dsh-client-modules/lib/index.js` |
| Client module loader (browser) | `@deepseek-ai/dsh-client-modules/lib/client.js` |
| Client runtime (`sessions`, `slots`, `workspaces`) | `@deepseek-ai/dsh-client-runtime/lib/client.js` + `lib/types/**` |
| Conversation UI (slot `conversation.*`) | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` |
| Slot rendering | `@deepseek-ai/dsh-client-ui-renderer/lib/client.js` |
| Locale service | `@deepseek-ai/dsh-client-locale` |
| Session event persistence (JSONL/zstd) | `@deepseek-ai/dsh-session-persistence-jsonl` |
| Subagent seam | `@deepseek-ai/dsh-agent-loop` (spawn/start/run) |
| Tool / systemPrompt / command injection | Cordis context (`ctx.tools`, `ctx.inject`) |
