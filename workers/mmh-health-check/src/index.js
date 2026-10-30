// workers/mmh-health-check/src/index.js — MMH メタバース HTTPS ヘルスチェック

/** @typedef {{ url: string; ok: boolean; status: number | null; error: string | null; checkedAt: string }} CheckResult */

const MONITOR_URLS = [
  "https://meta.mmh-virtual.jp/",
  "https://metair.mmh-virtual.jp/",
  "https://metadogo.mmh-virtual.jp/",
  "https://metapre.mmh-virtual.jp/",
];

const DISCORD_FAILURE_THUMB =
  "https://media.giphy.com/media/l0MYC0LajaoPoHM2g/giphy.gif";
const DISCORD_RESOLVED_THUMB =
  "https://media.giphy.com/media/111ebnsxDQ7o4/giphy.gif";

/** 同一障害中の失敗通知は最大 1 時間に 1 回（初回は即時） */
const FAILURE_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * 単一 URL を GET（Workers fetch はデフォルトで TLS 検証あり）
 * @param {string} url
 * @returns {Promise<CheckResult>}
 */
async function checkUrl(url) {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "mmh-health-check/1.0 (Cloudflare Worker)" },
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
 * @param {Env} env
 * @param {string} url
 */
async function wasPreviouslyFailed(env, url) {
  if (!env.HEALTH_STATE) return false;
  return (await env.HEALTH_STATE.get(kvKey(url))) === "1";
}

/**
 * @param {Env} env
 * @param {string} url
 * @param {boolean} failed
 */
async function setPreviouslyFailed(env, url, failed) {
  if (!env.HEALTH_STATE) return;
  await env.HEALTH_STATE.put(kvKey(url), failed ? "1" : "0");
}

/** @param {string} url */
function kvKey(url) {
  return `failed:${url}`;
}

/** @param {string} url */
function kvFailureNotifyKey(url) {
  return `failure_notify_at:${url}`;
}

/**
 * 失敗 Webhook を送るか（初回障害は即時、継続失敗は前回通知から 1 時間空ける）
 * @param {Env} env
 * @param {string} url
 * @param {boolean} prevFailed
 * @param {string} checkedAt ISO
 */
async function shouldSendFailureNotify(env, url, prevFailed, checkedAt) {
  if (!prevFailed) return true;
  if (!env.HEALTH_STATE) return true;
  const last = await env.HEALTH_STATE.get(kvFailureNotifyKey(url));
  if (!last) return true;
  const lastMs = Date.parse(last);
  const nowMs = Date.parse(checkedAt);
  if (Number.isNaN(lastMs) || Number.isNaN(nowMs)) return true;
  return nowMs - lastMs >= FAILURE_NOTIFY_COOLDOWN_MS;
}

/**
 * @param {Env} env
 * @param {string} url
 * @param {string} checkedAt ISO
 */
async function recordFailureNotify(env, url, checkedAt) {
  if (!env.HEALTH_STATE) return;
  await env.HEALTH_STATE.put(kvFailureNotifyKey(url), checkedAt);
}

/** @param {Env} env @param {string} url */
async function clearFailureNotify(env, url) {
  if (!env.HEALTH_STATE) return;
  await env.HEALTH_STATE.delete(kvFailureNotifyKey(url));
}

/**
 * @param {string} webhookUrl
 * @param {Record<string, unknown>} payload
 */
async function postWebhook(webhookUrl, payload) {
  const body = buildWebhookBody(webhookUrl, payload);
  const wh = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const alert = String(payload.alert ?? "unknown");
  if (!wh.ok) {
    console.error(
      `Webhook POST failed (${alert}): ${wh.status} ${(await wh.text()).slice(0, 500)}`,
    );
    return false;
  }
  console.log(`Webhook POST ok (${alert}): ${wh.status}`);
  return true;
}

/**
 * 全 URL をチェックし、失敗・復旧を WEBHOOK_URL へ通知
 * @param {Env} env
 */
async function runHealthChecks(env) {
  const results = await Promise.all(MONITOR_URLS.map((url) => checkUrl(url)));
  const webhookUrl = (env.WEBHOOK_URL || "").trim();

  if (webhookUrl) {
    for (const r of results) {
      const prevFailed = await wasPreviouslyFailed(env, r.url);

      if (!r.ok) {
        const notify = await shouldSendFailureNotify(
          env,
          r.url,
          prevFailed,
          r.checkedAt,
        );
        if (notify) {
          await postWebhook(webhookUrl, {
            url: r.url,
            status: r.status,
            error: r.error,
            timestamp: r.checkedAt,
            source: "mmh-health-check",
            alert: "health_check_failed",
            resolved: false,
          });
          await recordFailureNotify(env, r.url, r.checkedAt);
        }
        await setPreviouslyFailed(env, r.url, true);
      } else if (prevFailed) {
        await postWebhook(webhookUrl, {
          url: r.url,
          status: r.status,
          error: null,
          timestamp: r.checkedAt,
          source: "mmh-health-check",
          alert: "resolved",
          resolved: true,
        });
        await setPreviouslyFailed(env, r.url, false);
        await clearFailureNotify(env, r.url);
      } else {
        await setPreviouslyFailed(env, r.url, false);
      }
    }
  } else {
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      console.warn("Health check failures but WEBHOOK_URL is not set", failures);
    }
  }

  const failures = results.filter((r) => !r.ok);
  return { ok: failures.length === 0, results, failures };
}

/**
 * 通知フォーマット検証用（本番チェック結果は変えない）
 * @param {Env} env
 * @param {"failure"|"resolved"} kind
 */
async function sendWebhookTest(env, kind) {
  const webhookUrl = (env.WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    console.warn("webhookTest skipped: WEBHOOK_URL is not set");
    return false;
  }
  const now = new Date().toISOString();
  const sampleUrl = "https://metadogo.mmh-virtual.jp/";
  if (kind === "failure") {
    return postWebhook(webhookUrl, {
      url: sampleUrl,
      status: 526,
      error: "HTTP status 526",
      timestamp: now,
      source: "mmh-health-check",
      alert: "health_check_failed",
      resolved: false,
      test: true,
    });
  }
  return postWebhook(webhookUrl, {
    url: sampleUrl,
    status: 200,
    error: null,
    timestamp: now,
    source: "mmh-health-check",
    alert: "resolved",
    resolved: true,
    test: true,
  });
}

/** @param {string} iso */
function formatTimestampJa(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
}

/** @param {string | null | undefined} error @param {number | null | undefined} status */
function humanError(error, status) {
  if (status === 526 || (error && error.includes("526"))) {
    return "オリジン SSL 無効";
  }
  return error ?? "—";
}

/**
 * Discord Incoming Webhook
 * @param {string} webhookUrl
 * @param {Record<string, unknown>} payload
 */
function buildWebhookBody(webhookUrl, payload) {
  if (!webhookUrl.includes("discord.com/api/webhooks")) {
    return JSON.stringify(payload);
  }

  const alert = String(payload.alert ?? "");
  const ts = formatTimestampJa(String(payload.timestamp ?? ""));
  const isResolved = alert === "resolved" || payload.resolved === true;

  const content = isResolved
    ? [
        "@everyone",
        "✅ **MMH ヘルスチェック復旧**",
        `URL: ${payload.url}`,
        `ステータス: ${payload.status ?? 200}`,
        `時刻: ${ts}`,
      ].join("\n")
    : [
        "@everyone",
        "❌ **MMH ヘルスチェック失敗**",
        `URL: ${payload.url}`,
        `ステータス: ${payload.status ?? "—"}`,
        `エラー: ${humanError(
          payload.error != null ? String(payload.error) : null,
          typeof payload.status === "number" ? payload.status : null,
        )}`,
        `時刻: ${ts}`,
      ].join("\n");

  return JSON.stringify({
    content,
    allowed_mentions: { parse: ["everyone"] },
    embeds: [
      {
        color: isResolved ? 0x57f287 : 0xed4245,
        thumbnail: {
          url: isResolved ? DISCORD_RESOLVED_THUMB : DISCORD_FAILURE_THUMB,
        },
      },
    ],
  });
}

export default {
  /** Cron: 5分おき */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runHealthChecks(env));
  },

  /** GET / または GET /run。?webhookTest=failure|resolved で通知テスト */
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const path = reqUrl.pathname;
    if (path !== "/" && path !== "/run") {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const webhookTest = reqUrl.searchParams.get("webhookTest");
    if (webhookTest === "failure" || webhookTest === "resolved") {
      await sendWebhookTest(env, webhookTest);
    }

    const report = await runHealthChecks(env);
    return Response.json(report, {
      status: report.ok ? 200 : 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(request),
      },
    });
  },
};

/** @param {Request} request */
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allow =
    origin &&
    (origin.endsWith(".pages.dev") ||
      origin.endsWith(".workers.dev") ||
      origin.includes("mmh-virtual.jp"))
      ? origin
      : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
