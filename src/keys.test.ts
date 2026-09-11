import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, DEFAULT_KEYS, hintLines, pickKeys, resolveKeys } from "./keys.js";
import { parseToml } from "./toml.js";

test("no two commands share a key out of the box", () => {
  const keys = Object.values(DEFAULT_KEYS);
  assert.equal(new Set(keys).size, keys.length, keys.join(" "));
  assert.equal(resolveKeys(undefined).problems.length, 0);
});

test("a bound letter is never also handed out as an item key", () => {
  // This is the whole reason bindings and the pick pool share a source.
  const pick = new Set(pickKeys(DEFAULT_KEYS));
  for (const command of COMMANDS) {
    assert.ok(!pick.has(DEFAULT_KEYS[command]), `${DEFAULT_KEYS[command]} (${command})`);
  }
});

test("rebinding a command frees the key it used to hold", () => {
  const { keys } = resolveKeys({ save: "w" });
  const pick = new Set(pickKeys(keys));

  assert.equal(keys.save, "w");
  assert.ok(pick.has("m"), "m is free once save moves off it");
  assert.ok(!pick.has("w"), "w is taken once save lands on it");
});

test("bindings come out of a [keys] table in the config file", () => {
  const table = parseToml('journal = true\n\n[keys]\nsend = "x"\ncopy_answer = "a"\n');
  const { keys, problems } = resolveKeys(table["keys"] as Record<string, string> | undefined);

  assert.equal(keys.send, "x");
  assert.equal(keys["copy-answer"], "a", "underscores read as dashes");
  assert.equal(keys.save, "m", "everything unmentioned keeps its default");
  assert.deepEqual(problems, []);
});

test("a binding Fleece cannot honour is reported, not obeyed", () => {
  const { keys, problems } = resolveKeys({ save: "ctrl+w", frobnicate: "z", send: "x" });

  assert.equal(keys.save, "m", "the bad binding falls back");
  assert.equal(keys.send, "x", "the good one in the same table still applies");
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /save: a binding is one character/);
  assert.match(problems.join("\n"), /unknown command "frobnicate"/);
});

test("binding two commands to one key is reported rather than silently resolved", () => {
  // Otherwise which command becomes unreachable is an accident of ordering.
  const { problems } = resolveKeys({ save: "y" });
  assert.match(problems.join("\n"), /"y" is bound to both copy-answer and save/);
});

test("the hints are generated from the bindings, so they cannot lie", () => {
  const [top, bottom] = hintLines(resolveKeys({ send: "x", save: "w" }).keys, [80, 80]);

  assert.equal(top, "key copy · x send");
  assert.equal(bottom, "y all · w save · o frame · [ ] turn · r reload · q close");
});

test("a narrow bar drops its least useful hints and keeps reading order", () => {
  const [, bottom] = hintLines(DEFAULT_KEYS, [80, 30]);

  assert.ok(bottom.length <= 30, bottom);
  assert.ok(!bottom.includes("reload"), "reload goes first");
  assert.ok(bottom.startsWith("y all"), bottom);
  assert.ok(bottom.endsWith("q close"), "the way out survives longest");
});

test("an impossibly narrow bar degrades rather than overflowing", () => {
  for (const room of [0, 1, 5, 12]) {
    const [top, bottom] = hintLines(DEFAULT_KEYS, [room, room]);
    assert.ok(top.length <= room || top === "key copy", `${room}: ${top}`);
    assert.ok(bottom.length <= room || bottom === "q close", `${room}: ${bottom}`);
  }
});
