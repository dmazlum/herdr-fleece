import assert from "node:assert/strict";
import { test } from "node:test";
import { type BuildIO, fingerprint, moduleFiles } from "./build.js";

/** A built tree in memory: paths to contents, directories inferred. */
function tree(files: Record<string, string>): BuildIO {
  return {
    list(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const seen = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) seen.set(rest, false);
        else seen.set(rest.slice(0, slash), true);
      }
      if (seen.size === 0) throw new Error(`no such directory: ${dir}`);
      return [...seen].map(([name, directory]) => ({ name, directory }));
    },
    read(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
  };
}

const build: Record<string, string> = {
  "/dist/dock.js": "dock v1",
  "/dist/extract.js": "extract v1",
  "/dist/extract.test.js": "tests are not shipped code",
  "/dist/dock.js.map": "a source map is not a module",
  "/dist/render/panel.js": "panel v1",
};

test("only built modules count, not tests or source maps", () => {
  assert.deepEqual(moduleFiles("/dist", tree(build)), [
    "/dist/dock.js",
    "/dist/extract.js",
    "/dist/render/panel.js",
  ]);
});

test("the same build fingerprints the same, however the directory is listed", () => {
  const shuffled = Object.fromEntries(Object.entries(build).reverse());

  assert.equal(fingerprint("/dist", tree(build)), fingerprint("/dist", tree(shuffled)));
});

test("a change in any module changes the fingerprint, not just the dock's own", () => {
  // Hashing dock.js alone would call this build fresh while it runs old code.
  const before = fingerprint("/dist", tree(build));
  const edited = fingerprint("/dist", tree({ ...build, "/dist/extract.js": "extract v2" }));

  assert.notEqual(edited, before);
});

test("recompiling identical output is not a change", () => {
  // `tsc` rewrites every file on every build, so mtimes cried wolf after a test run.
  assert.equal(fingerprint("/dist", tree(build)), fingerprint("/dist", tree({ ...build })));
});

test("a module appearing or vanishing counts as a changed build", () => {
  const base = fingerprint("/dist", tree(build));
  const without = { ...build };
  delete without["/dist/render/panel.js"];

  assert.notEqual(fingerprint("/dist", tree(without)), base);
  assert.notEqual(fingerprint("/dist", tree({ ...build, "/dist/new.js": "" })), base);
});

test("an unreadable build fingerprints as empty rather than as different", () => {
  // The dock treats "" as "cannot tell" and stays quiet: a check that cannot
  // tell must never claim the code is stale.
  assert.equal(fingerprint("/nowhere", tree(build)), "");

  const unreadable: BuildIO = {
    ...tree(build),
    read() {
      throw new Error("permission denied");
    },
  };
  assert.equal(fingerprint("/dist", unreadable), "");
});
