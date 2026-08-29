// test/helpers/fake-ctx.mjs — a faithful-enough fake Cordis context for driving
// the dsh-agent-swarm host half (`lib/index.js` apply) without a live harness.
//
// It implements exactly the surface `apply(ctx)` touches:
//   - ctx.get("sessions" | "agents" | "subagents")
//   - ctx.provide / ctx.on / ctx.inject / ctx.logger
//   - injections for "systemPrompt", "commands", "webServer"
//
// Callers supply a `webServer` registrar (capture, or a real node:http server)
// and a `subagents` service (controllable double). The helper records what the
// plugin provides and registers so tests can assert on it.

export function createFakeCtx({ webServer = null, subagents = null, sessions = null, agents = null } = {}) {
  const provided = {};
  const handlers = { "subagent/start": [], "subagent/end": [], "session/event": [] };
  const injections = [];
  const registrations = { systemPrompt: [], commands: [], webServer: [], tools: [] };

  const defaultSessions = {
    get: (id) => (id ? { id } : undefined),
    list: () => []
  };
  const defaultAgents = {
    get: (id) => (id ? { id, session: { id }, options: {} } : undefined),
    list: () => []
  };
  const defaultSubagents = {
    list: () => ["spawn"],
    getProvider: () => ({ name: "spawn", capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }),
    start: async () => { throw new Error("fake subagents.start not wired"); }
  };

  const ctx = {
    // Cordis injects declared services as properties (inject: ["sessions","tools"]),
    // while optional services are read lazily via ctx.get(...).
    sessions: sessions ?? defaultSessions,
    tools: { register: (def) => registrations.tools.push(def) },
    get(service) {
      if (service === "sessions") return sessions ?? defaultSessions;
      if (service === "agents") return agents ?? defaultAgents;
      if (service === "subagents") return subagents ?? defaultSubagents;
      return undefined;
    },
    provide(key, value) {
      provided[key] = value;
    },
    on(event, handler) {
      if (handlers[event]) handlers[event].push(handler);
    },
    emit(event, payload) {
      for (const handler of handlers[event] ?? []) handler(payload);
    },
    inject(deps, callback) {
      injections.push(deps);
      const scope = {};
      if (deps.includes("systemPrompt")) scope.systemPrompt = { context: (cfg) => registrations.systemPrompt.push(cfg) };
      if (deps.includes("commands")) scope.commands = { register: (cmd) => registrations.commands.push(cmd) };
      if (deps.includes("webServer")) scope.webServer = webServer ?? { register: (route) => registrations.webServer.push(route) };
      callback(scope);
    },
    logger: { info() {}, warn() {}, error() {} }
  };

  return { ctx, provided, handlers, injections, registrations };
}

/** A controllable one-shot subagent run double. */
export function makeRun({ id = "child-1", stopReason = "completed", output = [], structured = undefined } = {}) {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const run = {
    id,
    localAgent: undefined,
    result,
    dispose: async () => {}
  };
  return {
    run,
    settle(overrides = {}) {
      resolveResult({ stopReason, output, ...(structured !== undefined ? { structured } : {}), ...overrides });
    }
  };
}

/** A controllable fake subagents service. */
export function createFakeSubagents() {
  const calls = [];
  const service = {
    list: () => ["spawn"],
    getProvider: (name) => ({ name, capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true } }),
    start: async (name, request) => {
      calls.push({ name, request });
      const { run, settle } = makeRun();
      service._pending = service._pending ?? [];
      service._pending.push({ run, settle, request });
      return run;
    }
  };
  service.calls = calls;
  return service;
}

/** A fake node:http req/res pair for driving the /swarm/state route handler. */
export function makeHttp() {
  const req = {
    method: "GET",
    url: "/swarm/state",
    socket: { remoteAddress: "127.0.0.1" },
    setEncoding() {},
    on(event, cb) {
      if (event === "data") this._onData = cb;
      else if (event === "end") this._onEnd = cb;
      else if (event === "error") this._onError = cb;
      return this;
    },
    fireBody(body) {
      if (body !== undefined && this._onData) this._onData(body);
      if (this._onEnd) this._onEnd();
    }
  };
  const res = {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? "";
    }
  };
  return { req, res };
}
