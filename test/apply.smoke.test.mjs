import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../lib/index.js";

/**
 * Smoke-test the host half's `apply(ctx)` against a minimal fake Cordis
 * context. The point is not to simulate the real host, but to catch obvious
 * mount-time failures (typos in service names, wrong injection-callback shapes,
 * missing exports) before the plugin is loaded into a live profile.
 */

function fakeScope(kind) {
  return {
    systemPrompt: { context: () => undefined },
    commands: { register: () => undefined },
    webServer: { register: () => undefined }
  };
}

function makeCtx() {
  const provided = {};
  const registered = []; // injection names seen
  const ctx = {
    get: (service) => {
      if (service === "sessions") return { get: () => undefined, list: () => [] };
      return undefined;
    },
    provide: (key, value) => { provided[key] = value; },
    on: () => undefined,
    inject: (deps, callback) => {
      registered.push(...deps);
      callback(fakeScope());
    },
    logger: { info: () => undefined, warn: () => undefined }
  };
  return { ctx, provided, registered };
}

test("apply mounts without throwing and provides ctx.swarm", () => {
  const { ctx, provided } = makeCtx();
  assert.doesNotThrow(() => apply(ctx, {}));

  assert.ok(provided.swarm, "ctx.swarm is provided");
  for (const method of ["state", "recruit", "setPlan", "delegatePlan", "spawn", "confirm", "cancel", "summarize"]) {
    assert.equal(typeof provided.swarm[method], "function", `swarm.${method} is a function`);
  }
});

test("apply registers the systemPrompt, commands, and webServer injections", () => {
  const { ctx, registered } = makeCtx();
  apply(ctx, {});
  assert.ok(registered.includes("systemPrompt"));
  assert.ok(registered.includes("commands"));
  assert.ok(registered.includes("webServer"));
});

test("module exports are the expected host-half contract", () => {
  assert.equal(typeof apply, "function");
  assert.deepEqual(inject, ["sessions"]);
  assert.equal(name, "agent-swarm");
});

test("swarm.state returns a valid empty projection for an unknown session", () => {
  const { ctx, provided } = makeCtx();
  apply(ctx, {});
  const state = provided.swarm.state(undefined);
  assert.equal(state.phase, "recruiting");
  assert.deepEqual(state.plan, []);
  assert.deepEqual(state.agents, []);
});

test("recruit/spawn require a live session and fail closed", async () => {
  const { ctx, provided } = makeCtx();
  apply(ctx, {});
  // No live agent / subagent service: spawn must fail closed, not throw.
  const recruitResult = provided.swarm.recruit(undefined, []);
  assert.equal(recruitResult.ok, false);

  const fakeSession = { id: "s1" };
  const spawnResult = await provided.swarm.spawn(fakeSession, { label: "x", task: "y" });
  assert.equal(spawnResult.ok, false);
});
