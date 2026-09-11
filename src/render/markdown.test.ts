import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInline, renderMarkdown, renderSpans, wrapSpans } from "./markdown.js";
import { displayWidth, ESC } from "./text.js";

/** The reader's view of a styled line: markup applied, escapes gone. */
function seen(line: string): string {
  return line.split(new RegExp(`${ESC}\\[[0-9;]*m`)).join("");
}

test("bold, italic and inline code lose their markers", () => {
  const spans = parseInline("a **bold** and *slanted* and `code` bit");
  assert.equal(spans.map((span) => span.text).join(""), "a bold and slanted and code bit");
  assert.deepEqual(spans.find((span) => span.text === "bold")?.style, { bold: true });
  assert.deepEqual(spans.find((span) => span.text === "slanted")?.style, { italic: true });
  assert.deepEqual(spans.find((span) => span.text === "code")?.style, { code: true });
});

test("underscores inside identifiers are left alone", () => {
  for (const source of ["pane_id", "HERDR_PANE_ID", "agent_status_changed"]) {
    assert.deepEqual(parseInline(source), [{ text: source, style: {} }], source);
  }
});

test("asterisks used as arithmetic are left alone", () => {
  assert.equal(
    parseInline("2 * 3 * 4")
      .map((span) => span.text)
      .join(""),
    "2 * 3 * 4",
  );
});

test("styles nest", () => {
  const spans = parseInline("**bold with `code` inside**");
  assert.deepEqual(spans.find((span) => span.text === "code")?.style, { bold: true, code: true });
});

test("a backslash escapes a marker", () => {
  assert.equal(
    parseInline("\\*not italic\\*")
      .map((span) => span.text)
      .join(""),
    "*not italic*",
  );
});

test("a link keeps its text and shows the url dimmed", () => {
  const spans = parseInline("see [the docs](https://herdr.dev/x)");
  assert.equal(spans.find((span) => span.text === "the docs")?.style.underline, true);
  assert.equal(spans.find((span) => span.text.includes("herdr.dev"))?.style.dim, true);
});

test("wrapping measures the visible text, not the escape codes", () => {
  const lines = wrapSpans(parseInline("**aaaa** bbbb cccc dddd eeee"), 10);

  for (const line of lines) {
    assert.ok(displayWidth(line) <= 10, `"${seen(line)}" is ${displayWidth(line)} wide`);
  }
  assert.equal(lines.map(seen).join(" "), "aaaa bbbb cccc dddd eeee");
});

test("a style that spans a line break survives on both lines", () => {
  const lines = wrapSpans(parseInline("**one two three four**"), 8);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.includes(`${ESC}[1m`), seen(line));
});

test("a word longer than the line is split, not dropped", () => {
  const lines = wrapSpans(parseInline("abcdefghijklmnop"), 6);
  assert.equal(lines.map(seen).join(""), "abcdefghijklmnop");
  for (const line of lines) assert.ok(displayWidth(line) <= 6);
});

test("headings drop their hashes and bullets become dots", () => {
  const out = renderMarkdown("## Title\n\n- first\n- second", 40).map(seen);
  assert.deepEqual(out, ["Title", "• first", "• second"]);
});

test("a heading provides its own separation", () => {
  assert.deepEqual(renderMarkdown("# Title\n\nprose", 40).map(seen), ["Title", "prose"]);
});

test("paragraphs keep one blank line between them", () => {
  assert.deepEqual(renderMarkdown("one\n\ntwo", 40).map(seen), ["one", "", "two"]);
});

test("repeated blank lines never stack up", () => {
  assert.deepEqual(renderMarkdown("one\n\n\n\n\ntwo", 40).map(seen), ["one", "", "two"]);
});

test("a rule needs no blank line around it", () => {
  assert.deepEqual(renderMarkdown("one\n\n---\n\ntwo", 8).map(seen), ["one", "────────", "two"]);
});

test("a wrapping table rules its rows off", () => {
  const source = [
    "| Key | Value |",
    "| --- | --- |",
    "| a | a value long enough to wrap across lines |",
    "| b | short |",
  ];
  const out = renderMarkdown(source.join("\n"), 30).map(seen);
  const rules = out.filter((line) => line.includes("┼")).length;

  assert.equal(rules, 2, out.join("\n"));
});

test("a table that fits on single lines stays compact", () => {
  const source = ["| Key | Value |", "| --- | --- |", "| a | 1 |", "| b | 2 |"];
  const out = renderMarkdown(source.join("\n"), 40).map(seen);

  assert.equal(out.filter((line) => line.includes("┼")).length, 1);
  assert.equal(out.length, 4);
});

test("a horizontal rule fills the width", () => {
  assert.equal(renderMarkdown("---", 12).map(seen)[0], "────────────");
});

test("a blockquote gets a gutter", () => {
  assert.equal(renderMarkdown("> quoted line", 40).map(seen)[0], "│ quoted line");
});

test("code fences are not re-wrapped", () => {
  const source = ["```php", "public function averyLongFunctionNameThatWouldWrap(): void", "```"];
  const out = renderMarkdown(source.join("\n"), 20).map(seen);

  assert.equal(out.length, 3);
  assert.match(out[1]!, /^│ public function/);
});

test("a table is laid out in aligned columns", () => {
  const source = ["| Key | Value |", "| --- | ----: |", "| a | 1 |", "| bbbb | 22 |"];
  const out = renderMarkdown(source.join("\n"), 40).map(seen);

  assert.equal(out[0], "Key  │ Value");
  assert.equal(out[1], "─────┼──────");
  assert.equal(out[2], "a    │     1");
  assert.equal(out[3], "bbbb │    22");
});

test("every rendered line fits the requested width", () => {
  const source = [
    "# A heading that is quite long indeed",
    "",
    "Some **bold** prose with `inline_code` and a [link](https://example.com/a/b/c).",
    "",
    "| Column one | Column two | Column three |",
    "| --- | --- | --- |",
    "| a fairly long value | another long value | third |",
    "",
    "- a bullet that runs on for a while to force wrapping",
    "",
    "> quoted text that also runs on for a while",
  ].join("\n");

  for (const width of [20, 40, 104]) {
    for (const line of renderMarkdown(source, width)) {
      assert.ok(displayWidth(line) <= width, `width ${width}: "${seen(line)}"`);
    }
  }
});

test("renderSpans emits nothing extra when there is no style", () => {
  assert.equal(renderSpans([{ text: "plain", style: {} }]), "plain");
});

test("OSC 52 in the answer never reaches the pane", () => {
  const BEL = String.fromCharCode(7);
  const out = renderMarkdown(`safe${ESC}]52;c;YWJj${BEL}text`, 40).join("\n");

  assert.equal(out.includes(`${ESC}]52`), false);
  assert.equal(out.includes(BEL), false);
  assert.match(out, /safetext|safe.*text/);
});

test("renderSpans coalesces adjacent runs of the same style", () => {
  const line = wrapSpans(parseInline("**three bold words**"), 40)[0]!;

  assert.equal(seen(line), "three bold words");
  assert.equal(line.split(`${ESC}[1m`).length - 1, 1, line);
});
