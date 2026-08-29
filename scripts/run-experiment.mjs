// scripts/run-experiment.mjs — drive one full no-thinking swarm experiment
// against the running web host (127.0.0.1:3080 by default).
//
// This is the fast path for testing the plugin end-to-end: it creates a fresh
// grouped session (never reuse — history biases the main agent), materializes
// its agent, then drives the swarm lifecycle through the plugin's own HTTP
// data plane (POST /swarm/state). Subagents run on deepseek-v4-flash with
// reasoningEffort "off" (no thinking), outline a plan, track steps via the
// todo/write tool, and write real files (artifacts) under the workspace.
//
//   node scripts/run-experiment.mjs [round]
//
//   DSH_HOST  — base URL (default http://127.0.0.1:3080)
//   WORKSPACE  — workspace title to create/reuse (default "Swarm Experiments")
//   MODEL      — subagent model (default deepseek-v4-flash)
//   EFFORT     — subagent reasoningEffort (default off)

const HOST = process.env.DSH_HOST ?? "http://127.0.0.1:3080";
const WORKSPACE = process.env.WORKSPACE ?? "Swarm Experiments";
const MODEL = process.env.MODEL ?? "deepseek-v4-flash";
const EFFORT = process.env.EFFORT ?? "off";
const ROUND = process.argv[2] ?? "003";

// ── unary RPC over the host's loopback /api/<method> surface ───────────────
async function unary(method, payload = {}, rpc = "r") {
  const res = await fetch(`${HOST}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: rpc, method, payload }),
  });
  const body = await res.json();
  if (body?.type === "server-response" && body.result) return body.result;
  throw new Error(`${method} failed: ${JSON.stringify(body)}`);
}

// ── swarm data-plane helper ────────────────────────────────────────────────
async function swarmPost(sessionId, action, extra = {}) {
  const res = await fetch(`${HOST}/swarm/state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: sessionId, action, ...extra }),
  });
  return res.json();
}

async function swarmGet(sessionId) {
  const res = await fetch(`${HOST}/swarm/state?session=${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const round = String(Number.parseInt(ROUND, 10) || 3).padStart(3, "0");
  const title = `swarm experiment ${round}`;

  // 1. Reuse/create the workspace group.
  const { value: ws } = await unary("workspace.list");
  let workspace = ws.items.find((w) => w.title === WORKSPACE || w.path.endsWith(WORKSPACE));
  if (!workspace) {
    const created = await unary("workspace.create", { path: `${process.env.HOME}/Documents/DeepSeek/${WORKSPACE.toLowerCase().replace(/\s+/g, "-")}` });
    workspace = created.value.workspace;
  }
  console.log(`workspace: ${workspace.title} (${workspace.workspaceId})`);

  // 2. Fresh grouped session.
  const created = await unary("session.create", { workspaceId: workspace.workspaceId });
  const sessionId = created.value.sessionId;
  await unary("session.rename", { sessionId, title });
  console.log(`session:   ${title} (${sessionId})`);

  // 3. Materialize the agent (trivial first message).
  await unary("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "hi" }],
  });
  console.log("agent materialized (session.prompt accepted)");
  // Give the agent a moment to materialize so `confirm` → `spawn` can resolve
  // the live parent agent via agentForSession.
  await sleep(2000);

  // 4. Recruit a roster of no-thinking subagents. Two outline a plan; two carry
  //    a role prompt; every task asks for a step-by-step todo + real files so
  //    the run produces live todos and on-disk artifacts.
  const agents = [
    {
      id: "aria", name: "Aria", role: "frontend",
      outlinePlan: true,
      task: "Build a tiny static site: outline your plan, then use the todo tool to track each step, then write index.html, styles.css, and app.js into a new top-level folder.",
    },
    {
      id: "blake", name: "Blake", role: "backend",
      rolePrompt: "You are a terse Node.js engineer.",
      outlinePlan: true,
      task: "Build a tiny HTTP API: outline your plan, track each step with the todo tool, then write server.mjs and README.md into a new top-level folder.",
    },
    {
      id: "clio", name: "Clio", role: "docs",
      rolePrompt: "You are a concise technical writer.",
      task: "Write architecture documentation: track each step with the todo tool, then write docs/architecture.md into a new top-level folder.",
    },
    {
      id: "dex", name: "Dex", role: "qa",
      task: "Write a smoke test: track each step with the todo tool, then write test/smoke.test.mjs into a new top-level folder.",
    },
  ];
  const recruit = await swarmPost(sessionId, "recruit", {
    agents: agents.map((a) => ({ ...a, model: MODEL, reasoningEffort: EFFORT })),
  });
  if (!recruit.ok) throw new Error(`recruit failed: ${recruit.error}`);
  console.log(`recruited ${recruit.swarm.agents.length} agents`);

  // 5. Plan + confirm.
  const plan = agents.map((a, i) => ({
    id: `p${i + 1}`,
    title: a.task.split(":")[0].split(",")[0].slice(0, 60),
    status: "pending",
    ownerId: a.id,
  }));
  const planned = await swarmPost(sessionId, "plan", { plan, objective: `No-thinking ${agents.length}-agent file-writing smoke test (round ${round})` });
  if (!planned.ok) throw new Error(`plan failed: ${planned.error}`);
  const confirmed = await swarmPost(sessionId, "confirm");
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error}`);
  console.log("confirmed; swarm executing…");

  // 6. Poll until every agent is terminal (or timeout).
  const deadline = Date.now() + 12 * 60 * 1000;
  let snapshot;
  for (;;) {
    await sleep(3000);
    snapshot = (await swarmGet(sessionId)).swarm;
    const terminal = snapshot.agents.every((a) => a.status === "complete" || a.status === "error");
    const done = snapshot.agents.filter((a) => a.status === "complete").length;
    const err = snapshot.agents.filter((a) => a.status === "error").length;
    process.stdout.write(`\r  phase=${snapshot.phase} complete=${done} error=${err} active=${snapshot.agents.filter((a) => a.status === "active").length}   `);
    if (terminal && snapshot.agents.length > 0) break;
    if (Date.now() > deadline) {
      console.log("\nTIMEOUT — dumping partial state");
      break;
    }
  }
  console.log("");

  // 7. Report the per-agent evidence the ideal UI renders.
  console.log(`\nobjective: ${snapshot.objective}`);
  for (const a of snapshot.agents) {
    const p = a.plan?.length ?? 0;
    const t = a.todos?.length ?? 0;
    const l = a.logs?.length ?? 0;
    const art = a.artifacts?.length ?? 0;
    console.log(
      `- ${a.name} [${a.role}] ${a.status} ${a.progress}%` +
      ` plan=${p} todos=${t} logs=${l} artifacts=${art}` +
      ` model=${a.model ?? "?"} effort=${a.reasoningEffort ?? "?"}`
    );
    for (const f of a.artifacts ?? []) console.log(`    artifact: ${f.path} (${f.artifactType ?? "file"})`);
  }
  console.log(`\nsession: ${sessionId}`);
  console.log(`workspace: ${workspace.workspaceId}`);
}

main().catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
