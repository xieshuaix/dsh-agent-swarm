// scripts/verify-data-completeness.mjs — non-intrusive UI↔backend integration
// check. It does NOT touch the running UI; it reads the same two things the UI
// consumes — the plugin's JSONL event log (the UI's state-transition stream) and
// GET /swarm/state (the UI's snapshot) — and asserts the state evolution and
// per-agent data completeness match what a main-agent-driven swarm should look
// like.
//
//   node scripts/verify-data-completeness.mjs <sessionId>
//
// Checks:
//   1. phase evolution: swarm/phase events end in "complete" and never regress.
//   2. recruitment: every roster agent has a swarm/recruited + a child event.
//   3. summary: /swarm/state carries a non-empty summary.
//   4. per-agent data: status complete; plan present when outlinePlan; logs
//      present (they ran tools); artifacts present (they wrote files).

const HOST = process.env.DSH_HOME_URL ?? "http://127.0.0.1:3080";
const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`;
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("usage: node scripts/verify-data-completeness.mjs <sessionId>");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const PHASE_ORDER = ["recruiting", "planning", "awaiting_confirm", "executing", "complete"];

function main() {
  const eventsFile = join(DSH_HOME, "agent-swarm", "events", `${SESSION_ID}.jsonl`);
  let events;
  try {
    events = readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    console.error(`cannot read event log ${eventsFile}: ${String(err?.message ?? err)}`);
    process.exit(1);
  }

  // ── 1. phase evolution ─────────────────────────────────────────────────────
  const phases = events.filter((e) => e.type === "swarm/phase").map((e) => e.data?.phase);
  check("phase events present", phases.length > 0, phases.join(" → "));
  check("final phase is complete", phases[phases.length - 1] === "complete", phases[phases.length - 1]);
  let regressed = false;
  let last = -1;
  for (const p of phases) {
    const idx = PHASE_ORDER.indexOf(p);
    if (idx < last) regressed = true;
    last = Math.max(last, idx);
  }
  check("phase never regressed", !regressed);

  // ── 2. recruitment ─────────────────────────────────────────────────────────
  const recruited = events.filter((e) => e.type === "swarm/recruited").map((e) => e.data?.agent);
  const children = events.filter((e) => e.type === "swarm/agent/child").map((e) => e.data?.agentId);
  check("every recruited agent got a child run", recruited.length > 0 && recruited.every((a) => children.includes(a.id)),
    `recruited=${recruited.length} children=${children.length}`);

  // ── 3 + 4. /swarm/state data completeness ──────────────────────────────────
  return fetch(`${HOST}/swarm/state?session=${encodeURIComponent(SESSION_ID)}`, { headers: { accept: "application/json" } })
    .then((r) => r.json())
    .then((body) => {
      const swarm = body.swarm;
      if (!swarm || swarm.agents.length === 0) {
        check("swarm has agents", false, "empty /swarm/state");
        finish();
        return;
      }
      check("summary recorded", typeof swarm.summary === "string" && swarm.summary !== "", swarm.summary?.slice(0, 60));
      check("objective recorded", typeof swarm.objective === "string" && swarm.objective !== "", swarm.objective?.slice(0, 60));

      for (const a of swarm.agents) {
        const plan = (a.plan ?? []).length;
        const ownedPlan = (swarm.plan ?? []).filter((p) => p.ownerId === a.id).length;
        const todos = (a.todos ?? []).length;
        const logs = (a.logs ?? []).length;
        const artifacts = (a.artifacts ?? []).length;
        check(`${a.name} complete`, a.status === "complete", `${a.status} ${a.progress}%`);
        check(`${a.name} has plan`, a.outlinePlan ? plan > 0 : ownedPlan > 0 || plan > 0, `plan=${plan} owned=${ownedPlan}`);
        check(`${a.name} has logs`, logs > 0, `logs=${logs}`);
        check(`${a.name} has artifacts`, artifacts > 0, `artifacts=${artifacts}`);
      }
      finish();
    });

  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  }
}

main();
