import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCrashPoint, multiplierAt } from "../src/crash";

test("multiplier is monotone, starts at 1 and doubles in six seconds", () => {
  assert.equal(multiplierAt(0), 1);
  assert.equal(multiplierAt(6000), 2);
  let previous = 1;
  for (let ms = 0; ms < 60_000; ms += 79) {
    const current = multiplierAt(ms);
    assert.ok(current >= previous && current <= 1000);
    previous = current;
  }
});

test("crash distribution approximates 7% edge for common cashout targets", () => {
  const n = 100_000;
  const targets = [1.01, 2, 5];
  const wins = targets.map(() => 0);
  for (let i = 0; i < n; i++) {
    const point = generateCrashPoint();
    assert.ok(point >= 1 && point <= 1000);
    targets.forEach((x, j) => { if (point >= x) wins[j]++; });
  }
  targets.forEach((x, j) => assert.ok(Math.abs(wins[j] / n - 0.93 / x) < 0.012,
    `${x}x: ${wins[j] / n} versus ${0.93 / x}`));
});
