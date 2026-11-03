import assert from "node:assert/strict";
import { test } from "node:test";
import { clipboardEnv } from "./clipboard.js";

test("a UTF-8 locale is left alone", () => {
  const env = { LANG: "tr_TR.UTF-8", PATH: "/bin" };
  assert.equal(clipboardEnv(env), env);
});

test("no locale gets UTF-8, so pbcopy does not read the text as MacRoman", () => {
  const env = clipboardEnv({ PATH: "/bin" });
  assert.equal(env.LC_CTYPE, "UTF-8");
  assert.equal(env.PATH, "/bin");
});

test("a non-UTF-8 LC_ALL is dropped, since it would override LC_CTYPE", () => {
  const env = clipboardEnv({ LC_ALL: "C" });
  assert.equal(env.LC_ALL, undefined);
  assert.equal(env.LC_CTYPE, "UTF-8");
});
