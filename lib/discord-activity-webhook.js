// lib/discord-activity-webhook.js — ログイン・ログアウト・チャットを Discord へ（平文、console 用とは別 URL）

const DISCORD_CONTENT_MAX = 2000;

/** @returns {string} */
function activityServiceLabel() {
  return (
    process.env.PROXY_SERVICE_DOMAIN?.trim() ||
    process.env.METAVERSE_ACTIVITY_SERVICE_LABEL?.trim() ||
    "metaverse"
  );
}

/**
 * @param {'login' | 'logout' | 'chat'} eventType
 * @param {{
 *   userId: string;
 *   userName: string;
 *   chatMessage?: string;
 *   chatWarning?: boolean;
 *   room?: string;
 * }} fields
 */
export function notifyDiscordActivity(eventType, fields) {
  const url = (process.env.METAVERSE_ACTIVITY_DISCORD_WEBHOOK_URL || "").trim();
  if (!url) return;

  const userId = String(fields.userId ?? "").trim() || "—";
  const userName = String(fields.userName ?? "").trim() || "—";

  const eventJa =
    eventType === "login"
      ? "ログイン"
      : eventType === "logout"
        ? "ログアウト"
        : "チャット";

  const lines = [
    `[${activityServiceLabel()}] ${eventJa}`,
    `ユーザーID: ${userId}`,
    `ユーザー名: ${userName}`,
  ];

  if (eventType === "chat") {
    lines.push(
      `チャット警告: ${fields.chatWarning === true ? "あり" : "なし"}`,
    );
    if (fields.chatMessage) {
      lines.push(`内容: ${fields.chatMessage}`);
    }
  }

  if (fields.room) {
    lines.push(`ルーム: ${fields.room}`);
  }

  const content = lines.join("\n").slice(0, DISCORD_CONTENT_MAX);

  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[discord-activity-webhook] POST error: ${message}`);
  });
}
