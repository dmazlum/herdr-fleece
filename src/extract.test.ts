import assert from "node:assert/strict";
import { test } from "node:test";
import { extractItems, isCommand, isPath, looksLikeCode } from "./extract.js";
import type { FileEdit, Turn } from "./transcript/types.js";

function turn(text: string, index = 1, files: FileEdit[] = []): Turn {
  return {
    index,
    prompt: "p",
    text,
    thinking: "",
    toolUses: [],
    files,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

function edited(text: string, files: FileEdit[], cwd = "/repo"): Turn {
  return { ...turn(text, 1, files), cwd };
}

test("a shell fence becomes one command per line", () => {
  const items = extractItems([turn("```sh\nnpm ci\n$ npm run build\n# a comment\n```")]);

  assert.deepEqual(
    items.map((item) => [item.kind, item.text]),
    [
      ["command", "npm ci"],
      ["command", "npm run build"],
    ],
  );
});

test("a non-shell fence becomes one code item with its language and size", () => {
  const items = extractItems([turn("```php\n<?php\necho 1;\n```")]);

  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "code");
  assert.equal(items[0]!.tag, "php");
  assert.equal(items[0]!.detail, "2 ln");
  assert.equal(items[0]!.text, "<?php\necho 1;");
});

test("a long shell block is kept whole rather than split into commands", () => {
  const lines = Array.from({ length: 20 }, (_, n) => `echo ${n}`).join("\n");
  const items = extractItems([turn(`\`\`\`sh\n${lines}\n\`\`\``)]);

  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "code");
});

/** Most tests care about detection, not about what is on this machine's disk. */
const anyPath = { exists: () => true, cwd: "/repo" };

test("a path that is not on disk is an illustration, not an item", () => {
  const text = "Accepted: `~/a`, `./a`, `/a`. Real: `src/real.ts`.";
  const items = extractItems([turn(text)], {
    cwd: "/repo",
    exists: (path) => path === "/repo/src/real.ts",
  });

  assert.deepEqual(
    items.map((item) => item.text),
    ["src/real.ts"],
  );
});

test("paths and commands are taken from inline code, identifiers are not", () => {
  const items = extractItems(
    [turn("Edit `src/render/panel.ts` then run `npm run build`, note `pane_id` and `herdr`.")],
    anyPath,
  );

  assert.deepEqual(
    items.map((item) => [item.kind, item.text]),
    [
      ["command", "npm run build"],
      ["path", "src/render/panel.ts"],
    ],
  );
});

test("links are collected and stripped of trailing punctuation", () => {
  const items = extractItems([turn("See https://herdr.dev/docs/plugins/, it helps.")]);

  assert.deepEqual(
    items.map((item) => [item.kind, item.text, item.label]),
    [["link", "https://herdr.dev/docs/plugins/", "herdr.dev/docs/plugins/"]],
  );
});

test("fenced content is not scanned again as prose", () => {
  // The path inside the block belongs to the block, not to a PATHS entry.
  const items = extractItems([turn("```js\nconst file = `src/a.ts`;\n```")]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["code"],
  );
});

test("duplicates across turns are listed once", () => {
  const items = extractItems([turn("run `npm ci` please", 1), turn("again, `npm ci`", 2)]);
  assert.equal(items.filter((item) => item.text === "npm ci").length, 1);
});

test("only the most recent turns are scanned", () => {
  const items = extractItems(
    [turn("`old/file.ts`", 1), turn("`mid/file.ts`", 2), turn("`new/file.ts`", 3)],
    { ...anyPath, turns: 2 },
  );

  assert.deepEqual(
    items.map((item) => item.text).sort(),
    ["mid/file.ts", "new/file.ts"],
  );
});

test("items are grouped by kind in a stable order", () => {
  const items = extractItems(
    [turn("A link https://a.test and `dir/file.ts` and `npm ci` and\n```js\nlet a;\n```")],
    anyPath,
  );

  assert.deepEqual(
    items.map((item) => item.kind),
    ["code", "command", "path", "link"],
  );
});

test("files the agent wrote to are listed, and reads are not", () => {
  // The parser only records write-class tools, so the item list follows.
  const items = extractItems([edited("Done.", [{ path: "/repo/src/a.ts", edits: 3 }])], {
    exists: () => true,
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.label, item.text, item.detail]),
    [["file", "src/a.ts", "/repo/src/a.ts", "×3"]],
  );
});

test("an edited file leads the panel and a single edit carries no count", () => {
  const turn1 = edited("Run `npm ci` and see https://a.test", [{ path: "/repo/src/a.ts", edits: 1 }]);
  const items = extractItems([turn1], { exists: () => true });

  assert.deepEqual(
    items.map((item) => item.kind),
    ["file", "command", "link"],
  );
  assert.equal(items[0]!.detail, undefined);
});

test("a file the agent edited is not listed a second time as a guessed path", () => {
  const text = "I changed `src/a.ts`; also look at `src/b.ts`.";
  const items = extractItems([edited(text, [{ path: "/repo/src/a.ts", edits: 1 }])], {
    exists: () => true,
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.text]),
    [
      ["file", "/repo/src/a.ts"],
      ["path", "src/b.ts"],
    ],
  );
});

test("a recorded file that is no longer on disk is dropped", () => {
  // The agent may have written it and then moved or removed it again.
  const items = extractItems([edited("Done.", [{ path: "/repo/gone.ts", edits: 1 }])], {
    exists: () => false,
  });

  assert.deepEqual(items, []);
});

test("a file outside the working directory keeps its full label", () => {
  const items = extractItems([edited("Done.", [{ path: "/etc/hosts", edits: 1 }])], {
    exists: () => true,
  });

  assert.equal(items[0]!.label, "/etc/hosts");
});

test("isPath accepts real paths and rejects prose and urls", () => {
  for (const value of ["~/a/b.txt", "./src/a.ts", "/etc/hosts", "src/a.ts", "dist/cli.js"]) {
    assert.ok(isPath(value), value);
  }
  for (const value of ["pane_id", "https://a.test/b", "a b/c", "plain"]) {
    assert.ok(!isPath(value), value);
  }
});

test("an anchor with nothing after it is not a path", () => {
  // These turn up whenever an answer explains path syntax.
  for (const value of ["~/", "./", "../", "/", "//", "~//"]) {
    assert.ok(!isPath(value), value);
  }
  for (const value of ["~/a", "./a", "/a", "~/.claude"]) {
    assert.ok(isPath(value), value);
  }
});

test("a bare two-word slash is prose, not a path", () => {
  // `j/k` is how a keybinding is written, not a file.
  for (const value of ["j/k", "and/or", "km/h", "owner/repo", "input/output"]) {
    assert.ok(!isPath(value), value);
  }
});

test("an unlabelled fence of console output is not listed as code", () => {
  const output = [
    "```",
    "✔ an overlay is never given a target pane",
    "✔ a split keeps its target pane",
    "```",
  ].join("\n");

  assert.deepEqual(extractItems([turn(output)]), []);
});

test("an unlabelled error message is not listed as code", () => {
  const text = '```\ninvalid_params: "overlay and popup panes target the active pane"\n```';
  assert.deepEqual(extractItems([turn(text)]), []);
});

test("an unlabelled fence that really is code is still listed", () => {
  const items = extractItems([turn("```\nfunction add(a, b) {\n  return a + b;\n}\n```")]);
  assert.deepEqual(
    items.map((item) => item.kind),
    ["code"],
  );
});

test("looksLikeCode recognises config assignments but not prose", () => {
  assert.ok(looksLikeCode('key = "value"'));
  assert.ok(looksLikeCode("const a = 1;"));
  assert.ok(!looksLikeCode("herdr server reload-config → status: applied"));
  assert.ok(!looksLikeCode("┌─ Fleece ──┐\n│ CODE     │"));
});

test("isCommand needs a known binary and an argument", () => {
  assert.ok(isCommand("git status"));
  assert.ok(!isCommand("git"));
  assert.ok(!isCommand("frobnicate --now"));
});

test("a command shown with its result is not runnable", () => {
  // Answers quote outcomes like this; copying one would paste the result too.
  assert.ok(!isCommand("herdr server reload-config → status: applied"));
  assert.ok(!isCommand("npm test ⇒ 70 passing"));
  assert.ok(!isCommand("herdr plugin list …"));
  assert.ok(isCommand("herdr server reload-config"));
});
