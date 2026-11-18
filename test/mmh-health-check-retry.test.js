// test/mmh-health-check-retry.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkUrlWithRetries,
  checkUrlOnce,
  CHECK_EXTRA_RETRIES,
} from "../workers/mmh-health-check/src/check-url.js";

describe("checkUrlWithRetries", () => {
  const url = "https://meta.mmh-virtual.jp/";

  it("succeeds on first attempt without delay", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return { status: 200, ok: true };
    };
    const delays = [];
    const result = await checkUrlWithRetries(url, {
      fetchImpl,
      delayFn: async (ms) => {
        delays.push(ms);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(delays.length, 0);
  });

  it("retries twice after failures then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) {
        return { status: 503, ok: false };
      }
      return { status: 200, ok: true };
    };
    const delays = [];
    const result = await checkUrlWithRetries(url, {
      fetchImpl,
      delayMs: 1,
      delayFn: async (ms) => {
        delays.push(ms);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
    assert.equal(delays.length, CHECK_EXTRA_RETRIES);
  });

  it("fails after 1 + CHECK_EXTRA_RETRIES attempts", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error("connection refused");
    };
    const result = await checkUrlWithRetries(url, {
      fetchImpl,
      delayMs: 0,
      delayFn: async () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1 + CHECK_EXTRA_RETRIES);
    assert.equal(calls, 1 + CHECK_EXTRA_RETRIES);
    assert.match(result.error ?? "", /connection refused/);
  });
});

describe("checkUrlOnce", () => {
  it("maps non-200 to failure", async () => {
    const r = await checkUrlOnce("https://example.test/", {
      fetchImpl: async () => ({ status: 526, ok: false }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 526);
  });
});