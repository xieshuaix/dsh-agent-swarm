import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { createFakeCtx, createFakeSubagents, makeHttp } from "./helpers/fake-ctx.mjs";

function isolateStore() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-e2e-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  };
}

const SESSION = { id: "s1" };

test("full orchestration lifecycle: recruit → plan → confirm → summarize", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    const r1 = swarm.recruit(SESSION, [
      { id: "a1", name: "Aria", role: "builder", task: "build" },
      { id: "a2", name: "Blake", role: "reviewer", task: "review" }
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r1.swarm.phase, "planning");
    assert.equal(r1.swarm.agents.length, 2);
    assert.equal(r1.swarm.recruitedCount, 2);

    const r2 = swarm.setPlan(SESSION, [
      { id: "p1", title: "build", status: "pending", ownerId: "a1" },
      { id: "p2", title: "review", status: "pending", ownerId: "a2" }
    ], { objective: "ship it" });
    assert.equal(r2.ok, true);
    assert.equal(r2.swarm.phase, "awaiting_confirm");
    assert.equal(r2.swarm.objective, "ship it");
    assert.equal(r2.swarm.plan.length, 2);

    const r3 = await swarm.confirm(SESSION);
    assert.equal(r3.ok, true);
    assert.equal(r3.swarm.phase, "executing");

    const r4 = swarm.summarize(SESSION, "all done");
    assert.equal(r4.ok, true);
    assert.equal(r4.swarm.phase, "complete");
    assert.equal(r4.swarm.summary, "all done");

    // State is durable across a fresh read.
    assert.equal(swarm.state(SESSION).phase, "complete");
  } finally {
    restore();
  }
});

test("confirm spawns every queued agent as a one-shot subagent", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [
      { id: "a1", name: "Aria", role: "builder", task: "build" },
      { id: "a2", name: "Blake", role: "reviewer", task: "review" }
    ]);
    swarm.setPlan(SESSION, [{ id: "p1", title: "build", status: "pending", ownerId: "a1" }]);

    const result = await swarm.confirm(SESSION);
    assert.equal(result.ok, true);
    assert.equal(result.swarm.phase, "executing");
    assert.equal(subagents.calls.length, 2, "both queued agents were spawned");
    assert.ok(result.swarm.agents.every((a) => a.status === "active"), "agents marked active after confirm");

    // The spawned prompt carries the objective and the agent's task.
    const prompts = subagents.calls.map((c) => c.request.prompt[0].text);
    assert.ok(prompts.some((p) => p.includes("build")), "spawn prompt includes the task");

    // Settle both children; the roster folds to complete.
    for (const pending of subagents._pending) pending.settle({ stopReason: "completed" });
    await new Promise((resolve) => setImmediate(resolve));

    const after = swarm.state(SESSION);
    assert.ok(after.agents.every((a) => a.status === "complete"));
    assert.equal(after.completedCount, 2);
  } finally {
    restore();
  }
});

test("spawn launches a real one-shot subagent and folds completion into the roster", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);
    const spawnResult = await swarm.spawn(SESSION, { id: "a1", label: "aria-build", task: "build the thing", role: "builder" });
    assert.equal(spawnResult.ok, true);

    // The service started exactly one child on the default provider with the parent session.
    assert.equal(subagents.calls.length, 1);
    assert.equal(subagents.calls[0].name, "spawn");
    assert.equal(subagents.calls[0].request.parent.id, "s1");
    assert.equal(subagents.calls[0].request.prompt[0].text, "build the thing");

    // Roster marked active immediately.
    assert.equal(swarm.state(SESSION).agents[0].status, "active");

    // Settle the child; the roster folds to complete.
    subagents._pending[0].settle({ stopReason: "completed" });
    await new Promise((resolve) => setImmediate(resolve));

    const agent = swarm.state(SESSION).agents[0];
    assert.equal(agent.status, "complete");
    assert.equal(agent.progress, 100);
    assert.equal(agent.childId, subagents.calls[0].request ? subagents._pending[0].run.id : null);
  } finally {
    restore();
  }
});

test("delegatePlan adopts the planner subagent's structured plan", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    // delegatePlan awaits the planner run's result internally, so start it and
    // settle the run before awaiting the returned promise.
    const pending = swarm.delegatePlan(SESSION, { objective: "ship it" });
    assert.equal(subagents.calls.length, 1, "planner started synchronously");
    assert.ok(subagents.calls[0].request.outputSchema, "planner started with outputSchema");

    subagents._pending[0].settle({ structured: { plan: [{ title: "step one", ownerId: "a1" }] } });
    const result = await pending;
    assert.equal(result.ok, true);

    const state = swarm.state(SESSION);
    assert.equal(state.phase, "awaiting_confirm");
    assert.equal(state.plan.length, 1);
    assert.equal(state.plan[0].title, "step one");
    assert.equal(state.plan[0].ownerId, "a1");
  } finally {
    restore();
  }
});

test("subagent/start and subagent/end lifecycle events update the roster", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);
    // Spawn registers the childId → roster mapping the event handlers key on.
    await swarm.spawn(SESSION, { id: "a1", label: "aria-build", task: "build", role: "builder" });
    const childId = subagents._pending[0].run.id;

    // Do NOT settle the run's result promise — exercise the event path instead.
    fake.ctx.emit("subagent/start", { id: childId });
    assert.equal(swarm.state(SESSION).agents[0].status, "active");

    fake.ctx.emit("subagent/end", { id: childId, stopReason: "completed" });
    const agent = swarm.state(SESSION).agents[0];
    assert.equal(agent.status, "complete");
    assert.equal(agent.progress, 100);
  } finally {
    restore();
  }
});

test("HTTP GET /swarm/state returns the projection", async () => {
  const restore = isolateStore();
  try {
    const routes = [];
    const webServer = { register: (route) => routes.push(route) };
    const fake = createFakeCtx({ webServer });
    apply(fake.ctx, {});
    fake.provided.swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);

    const route = routes.find((r) => r.path === "/swarm/state");
    assert.ok(route, "/swarm/state route registered");

    const { req, res } = makeHttp();
    req.method = "GET";
    req.url = "/swarm/state?session=s1";
    await route.handler(req, res);

    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(data.ok, true);
    assert.equal(data.swarm.phase, "planning");
    assert.equal(data.swarm.agents.length, 1);
    assert.equal(data.swarm.agents[0].name, "Aria");
  } finally {
    restore();
  }
});

test("HTTP POST /swarm/state confirm transitions awaiting_confirm → executing", async () => {
  const restore = isolateStore();
  try {
    const routes = [];
    const webServer = { register: (route) => routes.push(route) };
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ webServer, subagents });
    apply(fake.ctx, {});
    fake.provided.swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);
    fake.provided.swarm.setPlan(SESSION, [{ id: "p1", title: "build", status: "pending", ownerId: "a1" }]);

    const route = routes.find((r) => r.path === "/swarm/state");
    const { req, res } = makeHttp();
    req.method = "POST";
    req.url = "/swarm/state";
    const done = route.handler(req, res);
    req.fireBody(JSON.stringify({ session: "s1", action: "confirm" }));
    await done;

    const data = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(data.swarm.phase, "executing");
  } finally {
    restore();
  }
});

test("/swarm slash command drives the lifecycle", async () => {
  const restore = isolateStore();
  try {
    const fake = createFakeCtx();
    apply(fake.ctx, {});
    const command = fake.registrations.commands.find((c) => c.name === "swarm");
    assert.ok(command, "/swarm command registered");

    const agent = { session: { id: "s1" } };
    const reply = await command.handler({ agent, rawInput: "recruit Aria builder build the api" });
    assert.equal(reply.kind, "success");

    const stateReply = await command.handler({ agent, rawInput: "list" });
    assert.match(stateReply.text, /Aria/);
    assert.match(stateReply.text, /phase: planning/);
  } finally {
    restore();
  }
});

test("/swarm recruit parses model/effort/outline/prompt flags; plan parses multi-items + owners", async () => {
  const restore = isolateStore();
  try {
    const fake = createFakeCtx();
    apply(fake.ctx, {});
    const command = fake.registrations.commands.find((c) => c.name === "swarm");
    const agent = { session: { id: "s1" } };

    const r1 = await command.handler({ agent, rawInput: 'recruit Aria frontend build the site --model=deepseek-v4-flash --effort=off --outline --prompt="You are a terse engineer"' });
    assert.equal(r1.kind, "success");
    assert.match(r1.text, /model=deepseek-v4-flash/);
    assert.match(r1.text, /effort=off/);
    assert.match(r1.text, /outline/);

    const s = fake.provided.swarm.state({ id: "s1" });
    const aria = s.agents.find((a) => a.id === "aria");
    assert.equal(aria.model, "deepseek-v4-flash");
    assert.equal(aria.reasoningEffort, "off");
    assert.equal(aria.outlinePlan, true);
    assert.equal(aria.rolePrompt, "You are a terse engineer");
    assert.equal(aria.role, "frontend");
    assert.equal(aria.task, "build the site");

    const r2 = await command.handler({ agent, rawInput: 'plan build frontend@aria; build api@blake --objective="ship it"' });
    assert.equal(r2.kind, "success");
    const swarm = fake.provided.swarm.state({ id: "s1" });
    assert.equal(swarm.plan.length, 2);
    assert.equal(swarm.plan[0].ownerId, "aria");
    assert.equal(swarm.plan[1].ownerId, "blake");
    assert.equal(swarm.objective, "ship it");
    assert.equal(swarm.phase, "awaiting_confirm");
  } finally {
    restore();
  }
});

// Regression (TESTING.md mistake #6): the /swarm COMMAND (ctx.commands.register)
// is user-facing and never appears in the agent's tool list — the agent must get
// a `swarm` TOOL via ctx.tools.register instead.
test("registers a callable swarm tool the main agent can drive", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const tool = fake.registrations.tools.find((t) => t.name === "swarm");
    assert.ok(tool, "swarm tool registered");

    const exec = { agent: { id: "a0", session: { id: "s1" } } };

    // recruit → per-agent model/effort/outline plan
    const recruited = await tool.execute(
      { action: "recruit", agents: [{ name: "Aria", role: "builder", task: "build", model: "deepseek-v4-flash", reasoningEffort: "off", outlinePlan: true }] },
      exec
    );
    assert.equal(recruited.ok, true);
    assert.match(recruited.roster, /Aria\[builder\]=queued/);

    const aria = fake.provided.swarm.state({ id: "s1" }).agents.find((a) => a.id === "aria");
    assert.equal(aria.model, "deepseek-v4-flash");
    assert.equal(aria.reasoningEffort, "off");
    assert.equal(aria.outlinePlan, true);

    // plan → objective
    const planned = await tool.execute(
      { action: "plan", plan: [{ title: "build", ownerId: "aria" }], objective: "ship it" },
      exec
    );
    assert.equal(planned.ok, true);
    assert.equal(planned.objective, "ship it");

    // summarize → summary recorded
    const summarized = await tool.execute({ action: "summarize", summary: "all built" }, exec);
    assert.equal(summarized.ok, true);
    assert.equal(summarized.summary, "all built");
    assert.equal(summarized.phase, "complete");
  } finally {
    restore();
  }
});

// Regression for the "no summary / no main-agent orchestration" gap: the swarm
// tool must drive the FULL lifecycle (recruit → plan → confirm → children settle
// → summarize) so the projection ends complete WITH a summary, exactly what the
// main agent does in a real session.
test("swarm tool drives the full lifecycle to a complete, summarized swarm", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const tool = fake.registrations.tools.find((t) => t.name === "swarm");
    const exec = { agent: { id: "a0", session: { id: "s1" } } };

    await tool.execute(
      { action: "recruit", agents: [
        { name: "Aria", role: "frontend", task: "build ui", model: "deepseek-v4-flash", reasoningEffort: "off" },
        { name: "Blake", role: "backend", task: "build api", model: "deepseek-v4-flash", reasoningEffort: "off" }
      ] },
      exec
    );
    await tool.execute(
      { action: "plan", plan: [{ title: "ui", ownerId: "aria" }, { title: "api", ownerId: "blake" }], objective: "ship" },
      exec
    );
    const confirmed = await tool.execute({ action: "confirm" }, exec);
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.phase, "executing");

    // Children settle; then the agent summarizes.
    subagents._pending.forEach((p) => p.settle({ stopReason: "completed", output: [] }));
    await new Promise((r) => setImmediate(r));
    const summarized = await tool.execute({ action: "summarize", summary: "shipped" }, exec);

    assert.equal(summarized.ok, true);
    assert.equal(summarized.phase, "complete");
    assert.equal(summarized.summary, "shipped");
    assert.equal(summarized.roster, "Aria[frontend]=complete, Blake[backend]=complete");
  } finally {
    restore();
  }
});

test("system-prompt context exposes the swarm state to the model", () => {
  const restore = isolateStore();
  try {
    const fake = createFakeCtx();
    apply(fake.ctx, {});
    fake.provided.swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);

    const context = fake.registrations.systemPrompt.find((c) => c.name === "swarm:state");
    assert.ok(context, "swarm:state context registered");
    const text = context.text({ agent: { session: { id: "s1" } } });
    assert.match(text, /planning/);
    assert.match(text, /Aria/);
  } finally {
    restore();
  }
});

test("completion writes a .dsh-subagent.json marker into newly-created folders", async () => {
  const restore = isolateStore();
  const workspace = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-ws-"));
  try {
    // The parent session's cwd is the attribution root; the subagent "creates"
    // a new top-level dir there before settling.
    const agents = {
      get: (id) => (id ? { id, session: { id, header: { cwd: workspace } }, options: {} } : undefined),
      list: () => []
    };
    const subagents = createFakeSubagents();
    // The child's session references the produced dir (write_file path), the
    // ownership signal used for artifact attribution under concurrent spawns.
    const sessions = {
      get: (id) => (id ? { id, events: [
        { type: "tool/call", data: { name: "write_file", input: { path: "new-project/index.js" } } }
      ] } : undefined),
      list: () => []
    };
    const fake = createFakeCtx({ subagents, agents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);
    swarm.setPlan(SESSION, [{ id: "p1", title: "build", status: "pending", ownerId: "a1" }], { objective: "ship it" });

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build", label: "builder-aria" });

    // Simulate the subagent producing a new project folder.
    mkdirSync(join(workspace, "new-project"));
    subagents._pending[0].settle({ stopReason: "completed" });
    await new Promise((resolve) => setImmediate(resolve));

    const markerPath = join(workspace, "new-project", ".dsh-subagent.json");
    assert.ok(existsSync(markerPath), "marker written into the produced folder");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.equal(marker.kind, "dsh-subagent");
    assert.equal(marker.subagent.id, subagents._pending[0].run.id);
    assert.equal(marker.subagent.name, "Aria");
    assert.equal(marker.parent.sessionId, "s1");
    assert.equal(marker.parent.objective, "ship it");
    assert.equal(marker.status, "complete");

    // The owned plan item was also marked done, and the phase closed out.
    const state = swarm.state(SESSION);
    assert.equal(state.plan[0].status, "done");
    assert.equal(state.phase, "complete");
  } finally {
    restore();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("state() self-heals a stale executing projection (all agents terminal)", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    // Seed a state the OLD code would leave behind: every agent complete but the
    // phase still "executing" and the owned plan item still "pending".
    swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build", status: "complete", progress: 100 }]);
    swarm.setPlan(SESSION, [{ id: "p1", title: "build", status: "pending", ownerId: "a1" }]);
    await swarm.confirm(SESSION); // → executing (no queued agents to spawn)

    // A plain read must reconcile the stale state.
    const healed = swarm.state(SESSION);
    assert.equal(healed.phase, "complete");
    assert.equal(healed.plan[0].status, "done");
  } finally {
    restore();
  }
});

test("spawn passes rolePrompt as persona; outlinePlan adds directive and parses the plan", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    const result = await swarm.spawn(SESSION, {
      id: "a1", name: "Aria", role: "builder", task: "build the API",
      rolePrompt: "You are a senior backend engineer.",
      outlinePlan: true
    });
    assert.equal(result.ok, true);

    const call = subagents.calls[0];
    assert.equal(call.request.persona, "You are a senior backend engineer.");
    const prompt = call.request.prompt[0].text;
    assert.match(prompt, /outline your plan/);
    assert.match(prompt, /Role: You are a senior backend engineer\./);
    assert.match(prompt, /Task: build the API/);

    subagents._pending[0].settle({
      stopReason: "completed",
      output: [{ type: "text", text: '```json\n{"plan":[{"title":"step one"},{"title":"step two"}]}\n```' }]
    });
    await new Promise((r) => setImmediate(r));

    const agent = swarm.state(SESSION).agents[0];
    assert.equal(agent.rolePrompt, "You are a senior backend engineer.");
    assert.equal(agent.plan.length, 2);
    assert.equal(agent.plan[0].title, "step one");
    assert.equal(agent.plan[0].status, "done");
  } finally {
    restore();
  }
});

// Regression (TESTING.md mistake #3): the plan JSON is emitted in an EARLY
// assistant message, before the tool loop, so the run's final result.output no
// longer carries it. readChildPlan must recover it from the child session.
test("outlined plan is parsed from the child's early assistant message (not the final output)", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const sessions = {
      get: (id) => id ? {
        id,
        events: [
          { type: "assistant/message", data: { message: { content: [
            { type: "text", text: '```json\n{"plan":[{"title":"scaffold"},{"title":"write files"}]}\n```' }
          ] } } },
          { type: "tool/call", data: { name: "todo/write" } },
          { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Done." }] } } }
        ]
      } : undefined,
      list: () => []
    };
    const fake = createFakeCtx({ subagents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build", outlinePlan: true });
    // The run's final output has no plan JSON — only the early assistant message does.
    subagents._pending[0].settle({ stopReason: "completed", output: [{ type: "text", text: "Done." }] });
    await new Promise((r) => setImmediate(r));

    const agent = swarm.state(SESSION).agents[0];
    assert.equal(agent.plan.length, 2, "plan recovered from the child session events");
    assert.equal(agent.plan[0].title, "scaffold");
    assert.equal(agent.plan[1].title, "write files");
  } finally {
    restore();
  }
});

test("state() surfaces the child's live todos from todo/write events", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const sessions = {
      get: (id) => id ? { id, events: [{ type: "todo/write", data: { todos: [
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" }
      ] } }] } : undefined,
      list: () => []
    };
    const fake = createFakeCtx({ subagents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build" });
    const agent = swarm.state(SESSION).agents[0];
    assert.ok(Array.isArray(agent.todos), "todos surfaced from child session");
    assert.equal(agent.todos.length, 2);
    assert.equal(agent.todos[0].text, "step one");
    assert.equal(agent.todos[0].done, true);
    assert.equal(agent.todos[1].done, false);
  } finally {
    restore();
  }
});

test("state() surfaces the child's live logs from tool/assistant events", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const sessions = {
      get: (id) => id ? { id, events: [
        { type: "tool/call", data: { name: "write_file" } },
        { type: "tool/result", data: { message: { content: [{ type: "text", text: "wrote 2 files" }] } } },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "done" }] } } }
      ] } : undefined,
      list: () => []
    };
    const fake = createFakeCtx({ subagents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build" });
    const agent = swarm.state(SESSION).agents[0];
    assert.ok(Array.isArray(agent.logs), "logs surfaced from child session");
    assert.deepEqual(agent.logs.map((l) => l.type), ["action", "result", "text"]);
    assert.equal(agent.logs[0].tool, "write_file");
    assert.equal(agent.logs[1].content, "wrote 2 files");
    assert.equal(agent.logs[2].content, "done");
  } finally {
    restore();
  }
});

test("state() and completion surface the child's produced artifacts", async () => {
  const restore = isolateStore();
  let cwd;
  try {
    cwd = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-artifacts-"));
    const subagents = createFakeSubagents();
    const agents = { get: (id) => id ? { id, session: { id, header: { cwd } }, options: {} } : undefined, list: () => [] };
    const sessions = {
      get: (id) => (id ? { id, events: [
        { type: "tool/call", data: { name: "write_file", input: { path: "shipping/index.ts" } } }
      ] } : undefined),
      list: () => []
    };
    const fake = createFakeCtx({ subagents, agents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    const spawned = await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build" });
    assert.equal(spawned.ok, true);

    // The child writes a top-level dir + file while it runs.
    mkdirSync(join(cwd, "shipping"));
    writeFileSync(join(cwd, "shipping", "index.ts"), "export {}");

    // Settle the one-shot run so the completion path folds artifacts in.
    subagents._pending[0].settle({ stopReason: "completed", output: [] });

    const agent = swarm.state(SESSION).agents[0];
    assert.ok(Array.isArray(agent.artifacts), "artifacts surfaced");
    assert.equal(agent.artifacts.length, 1);
    assert.equal(agent.artifacts[0].name, "index.ts");
    assert.equal(agent.artifacts[0].path, "shipping/index.ts");
  } finally {
    restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression: todos + logs were only folded live from ctx.sessions, which is
// unloaded after the run, so the agent workspace showed empty later. Completion
// must persist them (like plan + artifacts).
test("completion persists todos + logs so they survive child-session unload", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const sessions = {
      get: (id) => (id ? { id, events: [
        { type: "todo/write", data: { todos: [{ content: "scaffold", status: "completed" }] } },
        { type: "tool/call", data: { name: "write_file", input: {} } },
        { type: "tool/result", data: { message: { content: [{ type: "text", text: "wrote" }] } } }
      ] } : undefined),
      list: () => []
    };
    const fake = createFakeCtx({ subagents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build" });
    subagents._pending[0].settle({ stopReason: "completed", output: [] });
    await new Promise((r) => setImmediate(r));

    // Read the durable store directly (as a later /swarm/state read would),
    // independent of the now-unloaded child session.
    const stored = JSON.parse(readFileSync(join(process.env.DSH_HOME, "agent-swarm", "s1.json"), "utf8"));
    const entry = stored.agents.find((a) => a.id === "a1");
    assert.equal(entry.todos.length, 1, "todos persisted");
    assert.equal(entry.todos[0].text, "scaffold");
    assert.ok(Array.isArray(entry.logs) && entry.logs.length > 0, "logs persisted");
  } finally {
    restore();
  }
});

// Regression: subagents often write files straight into the workspace ROOT
// (no folder), which the old top-level-dir-only scan missed → artifacts=0.
test("root-level files are captured as artifacts (not just top-level dirs)", async () => {
  const restore = isolateStore();
  let cwd;
  try {
    cwd = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-root-"));
    const subagents = createFakeSubagents();
    const agents = { get: (id) => id ? { id, session: { id, header: { cwd } }, options: {} } : undefined, list: () => [] };
    const sessions = {
      get: (id) => (id ? { id, events: [
        { type: "tool/call", data: { name: "write_file", input: { path: "app.js" } } }
      ] } : undefined),
      list: () => []
    };
    const fake = createFakeCtx({ subagents, agents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Aria", role: "builder", task: "build" });
    writeFileSync(join(cwd, "app.js"), "console.log(1)"); // no folder — root level
    subagents._pending[0].settle({ stopReason: "completed", output: [] });
    await new Promise((r) => setImmediate(r));

    const agent = swarm.state(SESSION).agents[0];
    assert.ok(Array.isArray(agent.artifacts), "root-file artifact surfaced");
    assert.equal(agent.artifacts.length, 1);
    assert.equal(agent.artifacts[0].name, "app.js");
    assert.equal(agent.artifacts[0].path, "app.js");
  } finally {
    restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
});

// Regression: real DSH stores tool/call arguments as a JSON string under
// `data.arguments` with a `file_path` key (not `data.input`). Attribution must
// read that shape AND match the path precisely so a write's *content* naming a
// sibling file can't mis-attribute it.
test("artifacts read data.arguments (JSON string) and match file_path precisely", async () => {
  const restore = isolateStore();
  let cwd;
  try {
    cwd = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-args-"));
    const subagents = createFakeSubagents();
    const agents = { get: (id) => id ? { id, session: { id, header: { cwd } }, options: {} } : undefined, list: () => [] };
    const sessions = {
      get: (id) => (id ? { id, events: [
        { type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: join(cwd, "README.md"), content: "## Files\n- app.js\n- index.html" }) } },
        { type: "tool/call", data: { name: "read", arguments: JSON.stringify({ file_path: join(cwd, "app.js") }) } }
      ] } : undefined),
      list: () => []
    };
    const fake = createFakeCtx({ subagents, agents, sessions });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    await swarm.spawn(SESSION, { id: "a1", name: "Docs", role: "docs", task: "write README" });
    // Sibling files exist at the root but were written by OTHER agents.
    writeFileSync(join(cwd, "README.md"), "# readme");
    writeFileSync(join(cwd, "app.js"), "console.log(1)");
    writeFileSync(join(cwd, "index.html"), "<h1>hi</h1>");
    subagents._pending[0].settle({ stopReason: "completed", output: [] });
    await new Promise((r) => setImmediate(r));

    const agent = swarm.state(SESSION).agents[0];
    const names = (agent.artifacts ?? []).map((a) => a.name).sort();
    assert.deepEqual(names, ["README.md"]);
  } finally {
    restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
});

test("artifacts are attributed via .dsh-subagent.json markers after spawnMeta is lost", async () => {
  const restore = isolateStore();
  let cwd;
  try {
    cwd = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-markers-"));
    // Simulate a post-restart state: the store has a completed agent with a
    // childId, the produced folder carries a provenance marker, but no spawnMeta.
    mkdirSync(join(cwd, "produced"));
    writeFileSync(join(cwd, "produced", ".dsh-subagent.json"), JSON.stringify({ subagent: { id: "child-9" } }));
    writeFileSync(join(cwd, "produced", "app.js"), "console.log(1)");
    mkdirSync(join(process.env.DSH_HOME, "agent-swarm"), { recursive: true });
    writeFileSync(join(process.env.DSH_HOME, "agent-swarm", "s1.json"), JSON.stringify({
      version: 1, id: "swarm-1", phase: "complete", objective: "", plan: [],
      agents: [{ id: "a1", name: "Aria", role: "builder", task: "build", status: "complete", progress: 100, childId: "child-9" }],
      summary: null, concurrencyLimit: 3, recruitedCount: 1, completedCount: 1
    }));

    const agents = { get: (id) => id ? { id, session: { id, header: { cwd } }, options: {} } : undefined, list: () => [] };
    const fake = createFakeCtx({ agents });
    apply(fake.ctx, {});
    const projection = fake.provided.swarm.state({ id: "s1", header: { cwd } });

    const agent = projection.agents[0];
    assert.ok(Array.isArray(agent.artifacts), "marker-attributed artifacts surfaced");
    assert.equal(agent.artifacts.length, 1);
    assert.equal(agent.artifacts[0].name, "app.js");
    assert.equal(agent.artifacts[0].path, "produced/app.js");
  } finally {
    restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
});

test("state() derives presentation metadata and topology for the ideal UI", async () => {
  const restore = isolateStore();
  try {
    const cwd = mkdtempSync(join(tmpdir(), "dsh-agent-swarm-topo-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# agent instructions");
    const subagents = createFakeSubagents();
    const agents = { get: (id) => id ? { id, session: { id, header: { cwd } }, options: {} } : undefined, list: () => [] };
    const fake = createFakeCtx({ subagents, agents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;
    const session = { id: "s1", header: { cwd } };

    swarm.recruit(session, [
      { id: "aria", name: "Aria", role: "builder", task: "build", outlinePlan: true },
      { id: "blake", name: "Blake", role: "reviewer", task: "review" }
    ]);
    swarm.setPlan(session, [
      { id: "p1", title: "build", status: "pending", ownerId: "aria" },
      { id: "p2", title: "review", status: "pending", ownerId: "blake" }
    ], { objective: "ship" });

    const projection = swarm.state(session);

    // Rows 4, 7, 8: plan windows + deterministic avatar/color.
    assert.equal(projection.plan[0].minProgress, 0);
    assert.equal(projection.plan[0].maxProgress, 50);
    assert.equal(projection.plan[1].maxProgress, 100);
    assert.equal(typeof projection.agents[0].color, "string");
    assert.equal(typeof projection.agents[0].avatarId, "string");
    assert.notEqual(projection.agents[0].avatarId, projection.agents[1].avatarId);

    // Row 5: composed system prompt; row 6: workspace AGENTS.md.
    assert.match(projection.agents[0].systemPrompt, /Task: build/);
    assert.equal(projection.agents[0].agentsMd, "# agent instructions");
    // The workspace root is surfaced so the UI can resolve artifact paths.
    assert.equal(projection.workspaceRoot, cwd);

    // Row 9: discrete progress mode follows an outlined plan; row 16: wave.
    assert.equal(projection.agents[0].progressMode, "discrete");
    assert.equal(projection.agents[0].wave, 1);

    // Rows 10, 11: positions + delegation/report edges derived from owners.
    assert.ok(projection.positions.aria, "position resolved for aria");
    const lineTypes = projection.lines.map((l) => `${l.from}->${l.to}:${l.type}`);
    assert.ok(lineTypes.includes("aria->blake:delegates") || lineTypes.includes("blake->aria:delegates"), "delegation edge present");
    assert.ok(lineTypes.some((l) => l.endsWith(":reports")), "report edge present");

    // Row 14: topology is persistable through the service + POST action.
    const t = swarm.setTopology(session, {
      positions: { aria: { x: 10, y: 20 } },
      lines: [{ from: "aria", to: "blake", type: "delegates" }],
      permissions: { "aria->blake": { read: true, write: true, execute: false } }
    });
    assert.equal(t.ok, true);
    const after = swarm.state(session);
    assert.deepEqual(after.positions.aria, { x: 10, y: 20 });
    assert.deepEqual(after.permissions["aria->blake"], { read: true, write: true, execute: false });
  } finally {
    restore();
  }
});

test("POST /swarm/state supports the topology action", async () => {
  const restore = isolateStore();
  try {
    const routes = [];
    const webServer = { register: (route) => routes.push(route) };
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ webServer, subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;
    swarm.recruit(SESSION, [{ id: "aria", name: "Aria", role: "builder", task: "build" }]);

    const route = routes.find((r) => r.path === "/swarm/state");
    const { req, res } = makeHttp();
    req.method = "POST";
    req.url = "/swarm/state";
    const done = route.handler(req, res);
    req.fireBody(JSON.stringify({
      session: "s1",
      action: "topology",
      topology: { positions: { aria: { x: 5, y: 7 } }, lines: [] }
    }));
    await done;

    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.deepEqual(swarm.state(SESSION).positions.aria, { x: 5, y: 7 });
  } finally {
    restore();
  }
});

test("serves the ideal-UI bundle via the /dsh-agent-swarm/ui prefix route", async () => {
  const restore = isolateStore();
  try {
    const routes = [];
    const webServer = { register: (route) => routes.push(route) };
    const fake = createFakeCtx({ webServer });
    apply(fake.ctx, {});
    const route = routes.find((r) => r.kind === "prefix" && r.path === "/dsh-agent-swarm/ui");
    assert.ok(route, "UI prefix route registered");

    // Serve the index.html (SPA entry).
    const { req, res } = makeHttp();
    req.url = "/dsh-agent-swarm/ui/";
    await route.handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(String(res.body), /<html|root|assets/i);

    // Serve a JS asset with the right content type.
    const { req: req2, res: res2 } = makeHttp();
    req2.url = "/dsh-agent-swarm/ui/assets/" + "index.js";
    await route.handler(req2, res2);
    // SPA fallback: unknown asset path still returns index.html (200).
    assert.equal(res2.statusCode, 200);
  } finally {
    restore();
  }
});

test("lifecycle emits swarm events to the JSONL log and registers an SSE route", async () => {
  const restore = isolateStore();
  try {
    const routes = [];
    const webServer = { register: (route) => routes.push(route) };
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ webServer, subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [{ id: "a1", name: "Aria", role: "builder", task: "build" }]);
    swarm.setPlan(SESSION, [{ id: "p1", title: "build", status: "pending", ownerId: "a1" }]);
    await swarm.confirm(SESSION);

    // Standard envelope JSONL log exists with the expected event types.
    const logFile = join(process.env.DSH_HOME, "agent-swarm", "events", "s1.jsonl");
    assert.ok(existsSync(logFile), "JSONL event log written");
    const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const types = lines.map((l) => l.type);
    for (const expected of ["swarm/phase", "swarm/recruited", "swarm/plan", "swarm/agent/child", "swarm/agent/status"]) {
      assert.ok(types.includes(expected), `event ${expected} logged`);
    }
    assert.ok(lines.every((l) => typeof l.ts === "number" && l.sessionId === "s1"), "standard envelope");

    // The SSE route is registered beside the state route.
    assert.ok(routes.some((r) => r.path === "/swarm/events"), "/swarm/events SSE route registered");
    assert.ok(routes.some((r) => r.path === "/swarm/state"), "/swarm/state route registered");
  } finally {
    restore();
  }
});

test("recruit → confirm propagates per-agent model, rolePrompt, and outlinePlan to spawn", async () => {
  const restore = isolateStore();
  try {
    const subagents = createFakeSubagents();
    const fake = createFakeCtx({ subagents });
    apply(fake.ctx, {});
    const swarm = fake.provided.swarm;

    swarm.recruit(SESSION, [
      {
        id: "a1", name: "Aria", role: "builder", task: "list 3 fruits",
        model: "deepseek-v4-flash", reasoningEffort: "low",
        rolePrompt: "You are a terse nutritionist.", outlinePlan: true
      }
    ]);
    swarm.setPlan(SESSION, [{ id: "p1", title: "list fruits", ownerId: "a1" }], { objective: "ship a fruit list" });
    await swarm.confirm(SESSION);

    assert.equal(subagents.calls.length, 1);
    const call = subagents.calls[0];
    assert.equal(call.request.agentOptions.model, "deepseek-v4-flash");
    assert.equal(call.request.agentOptions.reasoningEffort, "low");
    assert.equal(call.request.persona, "You are a terse nutritionist.");
    const prompt = call.request.prompt[0].text;
    assert.match(prompt, /outline your plan/);
    // The composed prompt (not an explicit prompt) keeps the Role + Objective
    // labels so the persisted systemPrompt reflects the persona and goal.
    assert.match(prompt, /Role: You are a terse nutritionist\./);
    assert.match(prompt, /Objective: ship a fruit list/);
    assert.match(prompt, /Task: list 3 fruits/);
  } finally {
    restore();
  }
});
