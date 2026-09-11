import assert from "node:assert/strict";
import { test } from "node:test";
import { StatusLine, STATUS_MS } from "./status.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a receipt clears itself and asks for one redraw", async () => {
  let redraws = 0;
  const line = new StatusLine(() => redraws++, 10);

  line.show("copied code · 1.2 KB");
  assert.equal(line.value, "copied code · 1.2 KB");
  assert.equal(redraws, 0, "showing must not redraw; the caller already does");

  await wait(40);
  assert.equal(line.value, undefined);
  assert.equal(redraws, 1);
});

test("a held message waits for the reader instead of expiring", async () => {
  let redraws = 0;
  const line = new StatusLine(() => redraws++, 10);

  line.hold("send → w1:p1 · pick an item, esc cancels");

  await wait(40);
  assert.match(line.value ?? "", /pick an item/);
  assert.equal(redraws, 0);
});

test("a second receipt restarts the clock rather than stacking timers", async () => {
  let redraws = 0;
  const line = new StatusLine(() => redraws++, 30);

  line.show("copied");
  await wait(20);
  line.show("saved");
  await wait(20);

  // The first receipt's timer must be gone, or "saved" would vanish early.
  assert.equal(line.value, "saved");
  await wait(40);
  assert.equal(line.value, undefined);
  assert.equal(redraws, 1);
});

test("clearing cancels a pending expiry, so no stray redraw arrives", async () => {
  let redraws = 0;
  const line = new StatusLine(() => redraws++, 10);

  line.show("copied");
  line.clear();

  assert.equal(line.value, undefined);
  await wait(40);
  assert.equal(redraws, 0, "a cleared receipt must not repaint over later work");
});

test("holding after a receipt cancels the receipt's expiry", async () => {
  let redraws = 0;
  const line = new StatusLine(() => redraws++, 10);

  line.show("copied");
  line.hold("send → w1:p1");

  await wait(40);
  assert.equal(line.value, "send → w1:p1");
  assert.equal(redraws, 0);
});

test("showing nothing is the same as clearing", () => {
  const line = new StatusLine(() => undefined, 10);
  line.show("copied");
  line.show(undefined);
  assert.equal(line.value, undefined);
});

test("the default receipt lasts three seconds", () => {
  assert.equal(STATUS_MS, 3000);
});
