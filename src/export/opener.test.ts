import assert from "node:assert/strict";
import { test } from "node:test";
import { launch, openArgs, parseCommand } from "./opener.js";

test("files and links go to the platform's own opener by default", () => {
  assert.deepEqual(openArgs("/repo/a.ts", { platform: "darwin" }), ["open", "/repo/a.ts"]);
  assert.deepEqual(openArgs("https://a.test", { link: true, platform: "linux" }), [
    "xdg-open",
    "https://a.test",
  ]);
  assert.equal(openArgs("/repo/a.ts", { platform: "win32" }), null);
});

test("open_command takes files, but a link still goes to the browser", () => {
  const command = parseCommand("  code   -r ");
  assert.deepEqual(command, ["code", "-r"]);

  assert.deepEqual(openArgs("/repo/a b.ts", { command, platform: "darwin" }), [
    "code",
    "-r",
    "/repo/a b.ts",
  ]);
  assert.deepEqual(openArgs("https://a.test", { link: true, command, platform: "darwin" }), [
    "open",
    "https://a.test",
  ]);
});

test("a blank open_command means the system opener", () => {
  assert.equal(parseCommand("   "), undefined);
  assert.equal(parseCommand(undefined), undefined);
});

test("a command that cannot start is reported rather than swallowed", async () => {
  await assert.rejects(launch(["fleece-no-such-opener-binary"]));
  await assert.doesNotReject(launch(["true"]));
});
