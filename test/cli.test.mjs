import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../cli/lib.mjs";

test("parseArgs separates flags and positional values", () => {
  assert.deepEqual(
    parseArgs(["cx_123", "fix", "tests", "--repo", "https://example.com/repo.git", "--json"]),
    {
      positional: ["cx_123", "fix", "tests"],
      flags: { repo: "https://example.com/repo.git", json: true }
    }
  );
});

test("parseArgs supports equals syntax", () => {
  assert.deepEqual(parseArgs(["--ref=feature/test", "do work"]), {
    positional: ["do work"],
    flags: { ref: "feature/test" }
  });
});

test("parseArgs rejects a flag without a value", () => {
  assert.throws(() => parseArgs(["--repo"]), /needs a value/);
});
