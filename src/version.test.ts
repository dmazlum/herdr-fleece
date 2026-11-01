import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// The installed app mods' mod.json is how someone tells which release they have, so it
// has to match the package and plugin versions that the release is tagged with.
const root = new URL("../", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, root), "utf8");

test("the plugin and every app mod carry the package version", () => {
  const { version } = JSON.parse(text("package.json")) as { version: string };
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(/^version = "(.+)"$/m.exec(text("herdr-plugin.toml"))?.[1], version);
  const mods = readdirSync(new URL("app/mods/", root));
  assert.ok(mods.length > 0);
  for (const name of mods) {
    assert.equal((JSON.parse(text(`app/mods/${name}/mod.json`)) as { version?: string }).version, version, name);
  }
});
