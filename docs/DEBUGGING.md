# Debugging & troubleshooting (dsh-agent-swarm)

Practical guidance for developing this plugin: what tools exist, what they tell
you, and — the useful part — **where to look for each class of bug** (distilled
from the bugs actually hit while building it).

---

## 1. Mental model: three layers + one data flow

```
dsh-agent-swarm-ui (source) ──build──▶ ui-dist/ (ideal embed)
        │                                  ▲ served at /dsh-agent-swarm/ui/*
        │                                  │
lib/index.js (host) ──/swarm/state──▶ lib/client.js (client) ──▶ window.IdealSwarmUI.mount
        │                                  │ (slots + conversation node)
   ctx.subagents ◀── child sessions ──▶ ctx.sessions.get(childId).events
```

Everything the UI shows is derived in the **host half** `state()`, serialized over
`/swarm/state`, and re-derived/consumed by the **client** + **embed**. So the first
debug question is always: **is the data wrong at the source (host `state()`), in
the transport (`/swarm/state`), or in the renderer (client/embed)?**

---

## 2. Debugging tools (in order of "go here first")

### 2.1 The primitive Swarm tab (the "is the data there?" view)

The **Swarm** tab (`conversation.view`) is deliberately a thin, raw dump of
`/swarm/state`. Its hint now says it outright: *"anything missing here is also
missing in the rich UI."*

- If a field (plan/todos/artifacts/logs/resources/lines) is **missing here**, the
  bug is in the host derivation or the subagent didn't produce it — **not** in the
  ideal UI.
- If it's **present here but missing in the card**, the bug is in the embed/client
  rendering.

### 2.2 `/swarm/state` via curl (the source projection)

```sh
curl -s "http://127.0.0.1:3080/swarm/state?session=<SESSION_ID>&view=latest" | jq
```

`view=latest` shows only the latest `batch` (one swarm dispatch); omit it for the
session-level view. This is exactly what the browser fetches — no UI noise.

### 2.3 The event stream (state transitions over time)

- **SSE**: `curl -N "http://127.0.0.1:3080/swarm/events?session=<SESSION_ID>"`
- **JSONL log**: `$DSH_HOME/agent-swarm/events/<SESSION_ID>.jsonl`

One envelope `{ ts, sessionId, type, data }`. Watch the sequence
`swarm/phase → swarm/recruited → swarm/plan → swarm/agent/child →
swarm/agent/status → … → swarm/summary`. A missing/duplicated step tells you
where the lifecycle stalled.

### 2.4 The child session log (where plan/todos/logs/artifacts come from)

The **authoritative** subagent evidence is the child session JSONL:

```
$DSH_HOME/sessions/<encoded-workspace>/<childId>/session.jsonl.zstd
```

Decode it (zstd):

```sh
zstd -d -c session.jsonl.zstd | less
```

Look at `tool/call` events (the child's actual tool use), `tool/result`,
`assistant/message` (the early outlined plan lives here, **not** in the final
output), and `todo/write`.

> **Critical shape gotcha:** `tool/call` arguments are a **JSON string** under
> `data.arguments` (keyed `file_path`), NOT `data.input`/`data.args`. Any code
> reading child events must normalize this (see `toolCallInput()` in the host).

### 2.5 The swarm store (persisted projection)

```sh
cat "$DSH_HOME/agent-swarm/<SESSION_ID>.json" | jq
```

The durable cache the host writes at settle time. If the live `/swarm/state`
differs from this, something re-derives differently on read (e.g. child session
already unloaded).

### 2.6 The UI bundle marker

```sh
cat ui-dist/version.json    # { uiVersion, uiCommit, builtAt }
```

Answers "is the shipped embed actually the build I think it is?".

### 2.7 Verification scripts (automate the checks)

| Script | What it proves |
| --- | --- |
| `scripts/verify-data-completeness.mjs <id>` | phase evolution + per-agent completeness, from JSONL + `/swarm/state` (no UI) |
| `scripts/verify-real.mjs <id>` | mounts the real host half against a real session's evidence (no running host) |
| `scripts/verify-inline-chat.mjs <title> <id>` | browser: inline card + primitive tab |
| `scripts/verify-interactions.mjs <title> <id> [agent]` | browser: click sequence (popup/canvas/toggle/workspace) |

### 2.8 Host e2e with a fake ctx

`test/host-e2e.test.mjs` + `test/helpers/fake-ctx.mjs` let you drive the full
lifecycle (`recruit → plan → confirm → spawn → settle → summarize`) without a host,
and `createFakeSubagents()` lets you settle one-shot runs and inspect the spawn
request. This is the fastest way to reproduce a derivation bug.

### 2.9 Browser DevTools

- **Console**: page errors from the embed bundle.
- **Network**: `/swarm/state` (is it 200? does the JSON have the field?),
  `/swarm/events` (SSE), `/dsh-agent-swarm/ui/*` (is the bundle served?).
- **React/component**: the embed is a React tree; a missing UI is usually a
  missing prop/wiring in `embed.tsx` (`LiveSwarmApp`), not the backend.

---

## 3. Where to look for each kind of bug

| Symptom | Most likely cause | Look here |
| --- | --- | --- |
| Plugin not loaded at all (no Swarm tab/card) | host row not mounted / not restarted | `dsh.profile.bundles`, `cordis.patch.yml`, restart host |
| Card missing / not inline / not live | conversation node not published during turn | `lib/client.js` `swarmCardDefinition` (`match`/`publication`/`buildViewNode`), `conversation.chat.node` slot |
| Main agent wanders off, can't call the swarm tool | tool schema/description mismatch (e.g. `concurrency` missing), or tool not in the agent's list | `ctx.tools.register` `description` + `parameters` in `lib/index.js`; the session log to see what the agent actually tried |
| `plan=0` for `outlinePlan` agents | plan JSON is in an **early** `assistant/message`, not the final output | `readChildPlan()` (scans child events); child JSONL §2.4 |
| `todos=0` / `logs=0` | child session already unloaded before read | settle-time persistence; `readChildTodos`/`readChildLogs` |
| `artifacts=0` (or mis-attributed) | write-event matching / shared dir / marker | `childWroteFile`, `listArtifacts`; `data.arguments` vs `input`; child JSONL |
| Edges (arrows) missing in canvas | plan `ownerId` doesn't match an agent id | `resolveAgentId`, `deriveLines` |
| Concurrency not enforced | `confirm` spawns all at once | `confirm` wave-draining; `swarm.concurrencyLimit` |
| UI is black / wrong theme | embed hardcodes dark; host is light | `embed.tsx` `detectHostTheme()`, `<html>` `color-scheme` |
| Popup occluded / duplicated | `position:absolute` in a scroll container; state keyed by resource id | `OrchestratorBoard.tsx` `ResourcePill` (menuKey + `position:fixed`) |
| Host restarted but still old behavior | host-half needs restart; client/embed only need refresh | see §4.1 |
| "everything was fine, broke after DSH upgrade" | DSH contract changed | `docs/DSH_FRAMEWORK.md` §7 checklist |

---

## 4. Useful experience / gotchas

1. **Restart vs refresh.** Host-half (`lib/index.js`) changes need a **host
   restart**. Client-half (`lib/client.js`) and the embed (`ui-dist/`) are served
   per-request → **browser hard-refresh** only.

2. **Child sessions are garbage-collected after the run.** `ctx.sessions.get(childId)`
   works only while the child runs. That's why the host **persists** plan/todos/
   logs/artifacts onto the agent in the `run.result.then` settle handler — never rely
   on a later live read.

3. **`data.arguments` is a JSON string.** Normalize before matching
   (`toolCallInput()`). A write's `file_path` is the precise attribution signal;
   matching the whole args blob causes false attribution (content mentions sibling
   files).

4. **Shared directories are racy.** When several children write into one directory,
   directory-level attribution is ambiguous — attribute **per file** via write
   events, and use `.dsh-subagent.json` markers only as the post-restart fallback.

5. **Plan `ownerId`s are model-authored and can be sloppy** (`"html"` vs
   `"html-builder"`). Resolve them (exact → normalized → prefix) rather than trusting
   exact equality — otherwise the orchestrator's report edges silently vanish.

6. **The embed bundle is a snapshot.** After UI changes run `pnpm build:plugin` and
   commit `ui-dist/`; check `ui-dist/version.json` to confirm which UI commit is
   shipped.

7. **Isolate state for tests.** `test/helpers/fake-ctx.mjs` + a throwaway
   `DSH_HOME` (see `isolateStore()` in host-e2e) keeps tests from touching the real
   profile/sessions.

8. **The client exposes a test seam.** `lib/client.js` `module.exports.__internals`
   exposes `{ isSwarmTool, parseSwarmAction, isDispatchAction, firstSwarmTurn,
   swarmCardDefinition }` so `client.test.mjs` can assert the definition/match
   without a browser.

9. **zstd, not plain JSONL.** Child session logs are zstd-compressed
   (`session.jsonl.zstd`); use `zstd -d -c` (the `zstd` binary is on PATH).

---

## 5. Quick cheat sheet

```sh
# live projection
curl -s "http://127.0.0.1:3080/swarm/state?session=$SID&view=latest" | jq

# event stream (JSONL)
tail -f "$DSH_HOME/agent-swarm/events/$SID.jsonl"

# persisted projection
jq . "$DSH_HOME/agent-swarm/$SID.json"

# child session events (find childId from the projection first)
zstd -d -c "$DSH_HOME/sessions/<encoded-workspace>/$CHILD_ID/session.jsonl.zstd" | less

# host half unit/e2e (no host)
node --test

# browser checks (needs running host)
node scripts/verify-inline-chat.mjs <title> <sessionId>
node scripts/verify-interactions.mjs <title> <sessionId> <agentName>
node scripts/verify-data-completeness.mjs <sessionId>
```

The single most reliable habit: **reproduce the bug at the projection level first**
(`/swarm/state`), then trace the field up to its derivation in `lib/index.js` and
back to the child session JSONL. That pinpoints host-vs-transport-vs-UI in one step.
