import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_KEYS } from "../keys.js";
import type { FleeceConfig } from "../config.js";
import type { Target, Turn } from "../transcript/types.js";
import { bodyLines, duration, renderFrame, tokens } from "./frame.js";
import { displayWidth, ESC } from "./text.js";

function seen(text: string): string {
  return text.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("");
}

const config: FleeceConfig = {
  exportDir: "/tmp",
  includePrompt: true,
  includeThinking: false,
  frontMatter: true,
  journal: false,
  dockTurns: 3,
  dockWidth: 46,
  keys: DEFAULT_KEYS,
  keyProblems: [],
};

const turn: Turn = {
  index: 14,
  prompt: "add the migration",
  promptAt: "2026-09-11T10:00:00.000Z",
  text: "## Summary\n\nAdded it.",
  thinking: "",
  toolUses: [
    { name: "Read", count: 1 },
    { name: "Edit", count: 16 },
    { name: "Bash", count: 6 },
  ],
  files: [{ path: "/repo/src/a.ts", edits: 16 }],
  model: "claude-opus-5",
  endedAt: "2026-09-11T10:01:00.000Z",
  usage: { input: 12400, output: 2100, cacheRead: 0, cacheCreation: 0 },
  gitBranch: "master",
  cwd: "/repo",
};

const target: Target = { paneId: "w1:p1", agent: "claude", sessionId: "abc", cwd: "/repo" };

test("the frame never shows a tool-use footer", () => {
  // Which tools ran is session metadata, and in a frame opened to read an
  // answer it sits between the reader and the last paragraph.
  const body = bodyLines(turn, config, 76).map(seen).join("\n");

  assert.ok(!body.includes("⚙"), body);
  assert.ok(!body.includes("Edit ×16"), body);
  assert.ok(body.trimEnd().endsWith("Added it."), body);
});

test("the answer is preceded by the prompt only when asked for", () => {
  const withPrompt = bodyLines(turn, config, 76).map(seen).join("\n");
  assert.match(withPrompt, /❯ add the migration/);

  const without = bodyLines(turn, { ...config, includePrompt: false }, 76).map(seen).join("\n");
  assert.ok(!without.includes("add the migration"), without);
});

test("the header carries the session facts instead", () => {
  const frame = seen(renderFrame(turn, target, config, { width: 100, height: 12 }));
  const header = frame.split("\n")[0]!;

  assert.match(header, /claude-opus-5/);
  assert.match(header, /turn 14/);
  assert.match(header, /12\.4k↑ 2\.1k↓/);
  assert.match(header, /master/);
});

test("every frame line fits the requested width", () => {
  for (const width of [30, 60, 100]) {
    for (const line of renderFrame(turn, target, config, { width, height: 14 }).split("\n")) {
      assert.equal(displayWidth(line), width, `width ${width}: "${seen(line)}"`);
    }
  }
});

test("a prompt cannot inject OSC 52 into the frame", () => {
  const BEL = String.fromCharCode(7);
  const injected = `add the ${ESC}]52;c;QQ${BEL}migration`;
  const body = bodyLines({ ...turn, prompt: injected }, config, 76).join("\n");

  assert.equal(body.includes(`${ESC}]52`), false);
  assert.equal(body.includes(BEL), false);
});

test("an empty answer says so rather than rendering nothing", () => {
  const body = bodyLines({ ...turn, text: "" }, config, 76).map(seen).join("\n");
  assert.match(body, /no text in this answer/);
});

test("duration and token counts are abbreviated", () => {
  assert.equal(duration(420), "420ms");
  assert.equal(duration(48_000), "48s");
  assert.equal(duration(95_000), "1m35s");
  assert.equal(tokens(940), "940");
  assert.equal(tokens(12_400), "12.4k");
});
