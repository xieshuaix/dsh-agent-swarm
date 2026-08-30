import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { dirname, join } from "node:path";

// The client half (lib/client.js) is a plain browser bundle that registers
// itself on window.__ModuleLoader__.load and pulls React from the frozen module
// table. Load it in a vm sandbox with a stub React and a fake document/ctx to
// verify the functional contract — that it registers the "Swarm" tab and its
// render function produces an element — without a browser.

const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length ? children : undefined } };
  },
  useState(initial) {
    return [initial, () => undefined];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
  useCallback(fn) {
    return fn;
  },
  useReducer(_reducer, initial) {
    return [initial, () => undefined];
  }
};

function makeFakeDocument() {
  const head = { children: [], appendChild(el) { this.children.push(el); } };
  return {
    createElement: () => ({ setAttribute() {}, textContent: "", style: {} }),
    head
  };
}

function loadBundle() {
  const loaded = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loaded.push(entry);
        }
      }
    },
    document: makeFakeDocument(),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BUNDLE_PATH, "utf8"), sandbox);
  assert.equal(loaded.length, 1, "bundle registered exactly one module");

  const require = (id) => {
    if (id === "react") return ReactStub;
    throw new Error(`unexpected require("${id}")`);
  };
  return { module: loaded[0].factory(require), sandbox };
}

function makeFakeCtx() {
  const registered = { locales: [], slots: [] };
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => registered.locales.push({ ns, dict })
    },
    effect: (fn) => {
      fn();
      return () => undefined;
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (meta, render) => {
        registered.slots.push({ meta, render });
      }
    }
  };
  return { ctx, registered };
}

test("client bundle exports the host-facing contract", () => {
  const { module } = loadBundle();
  assert.equal(module.name, "dsh-agent-swarm");
  assert.equal(module.inject.length, 2);
  assert.equal(module.inject[0], "slots");
  assert.equal(module.inject[1], "locale");
  assert.equal(typeof module.apply, "function");
});

test("apply registers locale dictionaries and the conversation slots", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();

  assert.doesNotThrow(() => module.apply(fake.ctx));

  assert.equal(fake.registered.locales.length, 1);
  assert.equal(fake.registered.locales[0].ns, "dsh-agent-swarm");

  assert.equal(fake.registered.slots.length, 2);
  const swarm = fake.registered.slots.find((s) => s.meta.name === "conversation.view");
  assert.ok(swarm, "conversation.view slot registered");
  assert.equal(swarm.meta.id, "swarm");
  assert.equal(typeof swarm.meta.label, "function");
  assert.equal(swarm.meta.label(), "tab"); // t() is the identity stub

  const dock = fake.registered.slots.find((s) => s.meta.name === "conversation.input.dock");
  assert.ok(dock, "conversation.input.dock slot registered");
  assert.equal(dock.meta.id, "swarm");
  assert.equal(typeof dock.meta.order, "number");
});

test("the slot render function produces a native SwarmView element for a session", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();
  module.apply(fake.ctx);
  const { render } = fake.registered.slots.find((s) => s.meta.name === "conversation.view");

  const element = render({ sessionId: "s1" });
  assert.ok(element, "render returns an element");
  assert.equal(typeof element.type, "function", "renders the native SwarmView component");
  assert.equal(element.props.sessionId, "s1");
});

test("firstSwarmTurn finds the first dispatching swarm tool call", () => {
  const { module } = loadBundle();
  const { firstSwarmTurn } = module.__internals;

  const assistant = (turn, blocks) => ({ kind: "assistant", turn, blocks });
  const call = (name, action) => ({ kind: "tool-call", name, argsRaw: JSON.stringify({ action }) });

  const snapshot = {
    nodes: [
      assistant(1, [call("write", "run")]),
      assistant(2, [call("swarm", "recruit")]),
      assistant(3, [call("swarm", "state")]),
      assistant(4, [call("swarm", "summarize")])
    ]
  };

  assert.equal(firstSwarmTurn(snapshot), 2, "first recruit/plan/confirm turn, not a state read");
  assert.equal(firstSwarmTurn({ nodes: [] }), -1, "empty snapshot has no dispatch turn");
  assert.equal(firstSwarmTurn({}), -1, "missing nodes declines safely");
  assert.equal(firstSwarmTurn(null), -1, "null snapshot declines safely");

  // A `state` read alone is not a dispatch.
  const readOnly = { nodes: [assistant(1, [call("swarm", "state")])] };
  assert.equal(firstSwarmTurn(readOnly), -1);
});

test("LiveSwarmDock mounts once the swarm is dispatched", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();
  module.apply(fake.ctx);
  const dock = fake.registered.slots.find((s) => s.meta.name === "conversation.input.dock");
  const { render } = dock;
  const t = (key) => key;
  // The stub React records elements without running components, so drive the
  // component body directly through the recorded element. useSession receives
  // a selector and applies it to a snapshot (the real hook shape).
  const run = (useSession) => {
    const el = render({ sessionId: "s1", useSession, t });
    return el.type(el.props);
  };

  const dispatched = run((sel) => sel({
    nodes: [{ kind: "assistant", turn: 1, blocks: [{ kind: "tool-call", name: "swarm", argsRaw: JSON.stringify({ action: "confirm" }) }] }]
  }));
  assert.ok(dispatched, "renders the inline panel once the swarm tool is dispatched");
  assert.equal(dispatched.type, "div", "wraps in a .das-inline card");

  const none = run((sel) => sel({ nodes: [] }));
  assert.equal(none, null, "a session with no swarm renders nothing");
});
