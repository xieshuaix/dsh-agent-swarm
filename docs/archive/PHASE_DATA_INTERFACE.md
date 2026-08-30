# PHASE — data interface (swarm tab as the primitive UI)

> **Status: complete (historical).** The data interface described here is fully
> wired — see `dsh-agent-swarm-ui/SWARM_DATA_GAP.md` (current data table) and
> `dsh-agent-swarm-ui/SWARM_PROTOCOL.md` (current protocol). This file records
> the original milestone.

Goal: make the swarm tab show **every** piece of data the ideal UI needs (per
`SWARM_DATA_GAP.md`), with **matching state evolution**, then hand off to
branch 3 for the real UI.

## Steps

1. **Full experiment** (no reasoning) — subagents that actually:
   - outline a plan (`outlinePlan`) and emit a parseable JSON plan,
   - check off steps via the `todo/write` tool (live todos),
   - write files (artifacts) + run tools (logs).
   Run on `deepseek-v4-flash` + `reasoningEffort: "off"` in a fresh grouped session.

2. **Close the data gaps** so the tab shows everything:
   - `logs` — aggregate child session events (tool/call, assistant/chunk,
     tool/result) → `logs[]` (currently unwired).
   - `artifacts` — list produced files (marker folders) → `artifacts[]`
     (currently unwired).
   - verify `todos`, `plan`, `rolePrompt`, `model`, `reasoningEffort` already flow.

3. **Verify against `SWARM_DATA_GAP.md`** — every row flips to `implemented` in
   the swarm tab; the JSONL event log shows the expected evolution (recruit →
   plan → child → todos/plan → status → complete).

4. **Commit branch 2 (`main`)** — concluding the plugin↔FE data interface, with
   the swarm tab as the primitive UI.

5. **Rebase `ideal-swarm-ui` (branch 3) on `main`**, checkout it, and start
   wiring the real UI (LiveDshBridge already reads `/swarm/state`) — then
   end-to-end test until it works.

## Checkpoint: what "everything visible" means

For each agent, the tab (or the data plane) must show: `name/role/task/status/
progress`, `rolePrompt` (when set), `plan[]` (when outlined), `todos[]` (live),
`artifacts[]` (files produced), `logs[]` (activity), `model`, `reasoningEffort`.
Plus swarm-level: `phase/objective/plan/summary/concurrencyLimit/counts`, and
the event log (JSONL) reflecting the step-by-step evolution.
