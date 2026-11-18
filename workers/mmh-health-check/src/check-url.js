// workers/mmh-health-check/src/check-url.js — 単発 GET とリトライ付きチェック

/** 初回失敗後の追加リトライ回数（合計 1 + 2 = 3 回） */
export const CHECK_EXTRA_RETRIES = 2;

/** リトライ間隔（ミリ秒）。誤検知抑制のため短すぎない値 */
export const CHECK_RETRY_DELAY_MS = 15_000;

/**
 * @param {number} ms
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 単一 URL を 1 回だけ GET
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, checkedAt?: string }} [options]
 * @returns {Promise<{ url: string; ok: boolean; status: number | null; error: string | null; checkedAt: string }>}
 */
export async function checkUrlOnce(url, options = {}) {
  const fetchFn = options.fetchImpl ?? fetch;
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "mmh-health-check/1.1 (Cloudflare Worker)" },
    });
    if (res.status !== 200) {
      return {
        url,
        ok: false,
        status: res.status,
        error: `HTTP status ${res.status}`,
        checkedAt,
      };
    }
    return { url, ok: true, status: 200, error: null, checkedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      ok: false,
      status: null,
      error: message,
      checkedAt,
    };
  }
}

/**
 * 接続失敗時に CHECK_EXTRA_RETRIES 回まで再試行する
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch; delayMs?: number; delayFn?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ url: string; ok: boolean; status: number | null; error: string | null; checkedAt: string; attempts: number }>}
 */
export async function checkUrlWithRetries(url, options = {}) {
  const delayMs = options.delayMs ?? CHECK_RETRY_DELAY_MS;
  const delayFn = options.delayFn ?? delay;
  const maxAttempts = 1 + CHECK_EXTRA_RETRIES;

  let last = await checkUrlOnce(url, { fetchImpl: options.fetchImpl });
  if (last.ok) {
    return { ...last, attempts: 1 };
  }

  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    await delayFn(delayMs);
    const next = await checkUrlOnce(url, { fetchImpl: options.fetchImpl });
    if (next.ok) {
      return { ...next, attempts: attempt };
    }
    last = next;
  }

  return { ...last, attempts: maxAttempts };
}