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

test("apply registers locale dictionaries and the conversation.view slot", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();

  assert.doesNotThrow(() => module.apply(fake.ctx));

  assert.equal(fake.registered.locales.length, 1);
  assert.equal(fake.registered.locales[0].ns, "dsh-agent-swarm");

  assert.equal(fake.registered.slots.length, 1);
  const swarm = fake.registered.slots[0];
  assert.equal(swarm.meta.name, "conversation.view");
  assert.equal(swarm.meta.id, "swarm");
  assert.equal(typeof swarm.meta.label, "function");
  assert.equal(swarm.meta.label(), "tab"); // t() is the identity stub
});

test("the slot render function produces a native SwarmView element for a session", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();
  module.apply(fake.ctx);
  const { render } = fake.registered.slots[0];

  const element = render({ sessionId: "s1" });
  assert.ok(element, "render returns an element");
  assert.equal(typeof element.type, "function", "renders the native SwarmView component");
  assert.equal(element.props.sessionId, "s1");
});
