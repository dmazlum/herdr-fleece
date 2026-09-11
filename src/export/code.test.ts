import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, extractCodeBlocks } from "./code.js";

test("extracts fenced blocks with their language", () => {
  const markdown = [
    "Here is the fix:",
    "```php",
    "public function up(): void",
    "```",
    "and a shell step:",
    "```sh",
    "php artisan migrate",
    "```",
  ].join("\n");

  assert.deepEqual(extractCodeBlocks(markdown), [
    { lang: "php", code: "public function up(): void" },
    { lang: "sh", code: "php artisan migrate" },
  ]);
});

test("keeps a nested tilde fence inside a backtick block", () => {
  const markdown = ["```md", "~~~js", "const a = 1;", "~~~", "```"].join("\n");
  const blocks = extractCodeBlocks(markdown);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.code, "~~~js\nconst a = 1;\n~~~");
});

test("recovers code from an unterminated fence", () => {
  const blocks = extractCodeBlocks("```ts\nconst x = 1;");
  assert.deepEqual(blocks, [{ lang: "ts", code: "const x = 1;" }]);
});

test("codeOnly joins blocks and drops prose", () => {
  const markdown = "intro\n```\na\n```\nmiddle\n```\nb\n```\noutro";
  assert.equal(codeOnly(markdown), "a\n\nb");
});

test("codeOnly is empty when there is no code", () => {
  assert.equal(codeOnly("just prose, no fences"), "");
});
