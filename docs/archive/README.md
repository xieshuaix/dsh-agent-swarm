# Archived development plans

These are **closed** (fully implemented) historical plans, kept for reference:

- `DEV_PLAN.md` — the original plugin build plan.
- `PHASE_DATA_INTERFACE.md` — the data-interface milestone (swarm tab as the
  primitive UI).

For the current state, read the root `README.md`, `docs/DSH_FRAMEWORK.md`, and
`docs/DEBUGGING.md`.

## Known unresolved follow-up

The per-edge **read/write/execute permission editor** is still open: the data
plane persists `permissions` and `saveTopology` carries them, but no editing
surface exists yet. It is tracked in the UI repo's `SWARM_DATA_GAP.md` (row 13)
and `ARCHITECTURE.md`.
