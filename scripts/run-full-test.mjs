// scripts/run-full-test.mjs — the FULL lifecycle test: the MAIN AGENT (not HTTP)
// orchestrates the swarm via the /swarm command and summarizes at the end.
//
// This is the test that closes the "no main agent orchestrating / no summary"
// gap: it creates a fresh grouped session, then prompts the main agent with an
// explicit orchestration recipe. The main agent issues /swarm recruit (with
// --model/--effort/--outline/--prompt), /swarm plan, /swarm confirm, polls
// /swarm list until every subagent is terminal, then /swarm summarize. The
// script only observes (polls /swarm/state); it does not mutate swarm state.
//
//   node scripts/run-full-test.mjs [round]

const HOST = process.env.DSH_HOME_URL ?? "http://127.0.0.1:3080";
const WORKSPACE = process.env.WORKSPACE ?? "Swarm Experiments";
const ROUND = process.argv[2] ?? "005";

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

async function swarmGet(sessionId) {
  const res = await fetch(`${HOST}/swarm/state?session=${encodeURIComponent(sessionId)}`, {
    headers: { accept: "application/json" },
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORCHESTRATION_PROMPT = `You are orchestrating a multi-agent swarm for this session. Drive it yourself with the /swarm slash command — do NOT delegate to another agent.

Recipe (exact subcommands):
1. Recruit four subagents. Use /swarm recruit with the --model and --effort flags so each runs cheap and without thinking, and give two of them --outline:
   - /swarm recruit Aria frontend "Build a tiny static site in a new folder" --model=deepseek-v4-flash --effort=off --outline
   - /swarm recruit Blake backend "Build a tiny HTTP API in a new folder" --model=deepseek-v4-flash --effort=off --outline
   - /swarm recruit Clio docs "Write architecture docs in a new folder" --model=deepseek-v4-flash --effort=off
   - /swarm recruit Dex qa "Write a smoke test in a new folder" --model=deepseek-v4-flash --effort=off
2. Set the plan with owners and an objective:
   /swarm plan "Build static site"@aria ; "Build HTTP API"@blake ; "Write docs"@clio ; "Write smoke test"@dex --objective="Ship the multi-modal search API (main-agent driven)"
3. Confirm execution: /swarm confirm
4. Poll /swarm list until every agent's status is complete or error. Keep polling if any agent is still active/queued.
5. Summarize the result in one sentence: /swarm summarize "<one-sentence summary>"

Do all of this in this session, and do not stop until the summary is recorded.`;

async function main() {
  const round = String(Number.parseInt(ROUND, 10) || 5).padStart(3, "0");
  const title = `swarm experiment ${round}`;

  const { value: ws } = await unary("workspace.list");
  let workspace = ws.items.find((w) => w.title === WORKSPACE);
  if (!workspace) {
    const created = await unary("workspace.create", { path: `${process.env.HOME}/Documents/DeepSeek/${WORKSPACE.toLowerCase().replace(/\s+/g, "-")}` });
    workspace = created.value.workspace;
  }
  const created = await unary("session.create", { workspaceId: workspace.workspaceId });
  const sessionId = created.value.sessionId;
  await unary("session.rename", { sessionId, title });
  console.log(`session: ${title} (${sessionId})`);

  // Drive the main agent (this is the whole point — the agent orchestrates).
  const prompt = await unary("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: ORCHESTRATION_PROMPT }],
  });
  console.log(`main agent prompted: ${JSON.stringify(prompt)}`);

  // Observe only: wait for the swarm to reach complete WITH a summary.
  const deadline = Date.now() + 15 * 60 * 1000;
  let snapshot;
  for (;;) {
    await sleep(5000);
    snapshot = (await swarmGet(sessionId)).swarm;
    const terminal = snapshot.agents.length > 0 && snapshot.agents.every((a) => a.status === "complete" || a.status === "error");
    const hasSummary = typeof snapshot.summary === "string" && snapshot.summary !== "";
    process.stdout.write(`\r  phase=${snapshot.phase} agents=${snapshot.agents.length} complete=${snapshot.completedCount} summary=${hasSummary ? "yes" : "no"}   `);
    if (terminal && hasSummary) break;
    if (snapshot.phase === "complete" && !hasSummary && Date.now() > deadline - 60 * 1000) break; // give up on summary near timeout
    if (Date.now() > deadline) break;
  }
  console.log("");

  console.log(`\nphase=${snapshot.phase} objective="${snapshot.objective}"`);
  console.log(`summary="${snapshot.summary ?? "(none)"}"`);
  for (const a of snapshot.agents) {
    console.log(
      `- ${a.name} [${a.role}] ${a.status} ${a.progress}%` +
      ` plan=${a.plan?.length ?? 0} todos=${a.todos?.length ?? 0} logs=${a.logs?.length ?? 0} artifacts=${a.artifacts?.length ?? 0}` +
      ` model=${a.model ?? "?"} effort=${a.reasoningEffort ?? "?"}`
    );
  }
  console.log(`\nsession: ${sessionId}`);
}

main().catch((error) => {
  console.error(`\n❌ ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
