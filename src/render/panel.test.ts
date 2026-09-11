import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../extract.js";
import { keyMap, listLines, renderPanel, shortenPath } from "./panel.js";
import { displayWidth, ESC } from "./text.js";

function seen(line: string): string {
  return line.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("");
}

const item = (kind: Item["kind"], text: string, extra: Partial<Item> = {}): Item => ({
  kind,
  label: text,
  text,
  turn: 1,
  ...extra,
});

test("keys are handed out in listing order across sections", () => {
  const items = [
    item("link", "https://a.test"),
    item("code", "let a;", { detail: "1 ln", tag: "js" }),
    item("command", "npm ci"),
  ];
  const keys = keyMap(items);

  assert.equal(keys.get("1")?.text, "let a;");
  assert.equal(keys.get("2")?.text, "npm ci");
  assert.equal(keys.get("3")?.text, "https://a.test");
});

test("edited files lead the panel and take the first key", () => {
  const items = [
    item("command", "npm ci"),
    item("file", "/repo/src/a.ts", { label: "src/a.ts", detail: "×3" }),
  ];

  assert.equal(keyMap(items).get("1")?.text, "/repo/src/a.ts");
  assert.equal(seen(listLines(items, 40)[0]!), "FILES");
});

test("sections are titled and separated", () => {
  const lines = listLines([item("code", "let a;", { tag: "js" }), item("command", "npm ci")], 40);
  const text = lines.map(seen);

  assert.equal(text[0], "CODE");
  assert.equal(text[2], "");
  assert.equal(text[3], "COMMANDS");
});

test("a path keeps its filename by eliding the middle", () => {
  assert.equal(shortenPath("short.ts", 20), "short.ts");

  const elided = shortenPath("/very/long/path/to/some/deep/file.ts", 18);
  assert.ok(displayWidth(elided) <= 18, elided);
  assert.ok(elided.endsWith("file.ts"), elided);
  assert.ok(elided.includes("…"), elided);
});

test("eliding an absolute path does not double its leading slash", () => {
  const elided = shortenPath("/Users/me/Projects/app/src/transcript/claude.ts", 30);

  assert.ok(elided.startsWith("/…/"), elided);
  assert.ok(!elided.includes("//"), elided);
  assert.equal(shortenPath("~/Projects/app/src/a/b/claude.ts", 20).slice(0, 3), "~/…");
});

test("every panel line fits the requested width", () => {
  const items = [
    item("code", "a fairly long first line of code that will not fit", {
      tag: "typescript",
      detail: "42 ln",
    }),
    item("command", "herdr plugin action invoke fleece.dock --with --many --flags"),
    item("path", "~/Projects/Ai/herdr/herdr-fleece/src/render/panel.ts"),
    item("link", "https://herdr.dev/docs/socket-api/#event-subscriptions"),
  ];

  for (const width of [28, 46, 104]) {
    // A header label is the part that overflows when the box arithmetic is off.
    const frame = renderPanel(items, {
      width,
      height: 20,
      note: "wC:p1 · live",
      label: "turn 21 · 2 back",
    });
    for (const line of frame.split("\n")) {
      assert.equal(displayWidth(line), width, `width ${width}: "${seen(line)}"`);
    }
  }
});

test("panel commands are never handed out as item keys", () => {
  const items = Array.from({ length: 26 }, (_, n) => item("path", `dir/file${n}.ts`));
  const keys = [...keyMap(items).keys()];

  for (const reserved of ["g", "j", "k", "m", "o", "q", "r", "s", "y"]) {
    assert.ok(!keys.includes(reserved), `${reserved} must stay a command`);
  }
});

test("an empty panel says so", () => {
  const frame = renderPanel([], { width: 40, height: 8 });
  assert.ok(frame.includes("nothing to take away yet"));
});

test("OSC 52 in a label never reaches the pane", () => {
  const BEL = String.fromCharCode(7);
  const frame = renderPanel(
    [item("command", `npm${ESC}]52;c;x${BEL} test`)],
    { width: 46, height: 10 },
  );

  assert.equal(frame.includes(`${ESC}]52`), false);
  assert.equal(frame.includes(BEL), false);
});
