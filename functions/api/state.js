const COOKIE_NAME = "signup_visitor";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10;

function tokenFromRequest(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;\\s*)" + COOKIE_NAME + "=([A-Za-z0-9_-]{43})(?:;|$)"));
  return match ? match[1] : null;
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return Response.json({ error: "数据库尚未绑定，请检查 Cloudflare Pages 设置。" }, { status: 503 });
  try {
    let token = tokenFromRequest(request);
    let isNew = false;
    if (!token) {
      token = newToken();
      isNew = true;
    }
    const visitorHash = await hashToken(token);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM registrations"
    ).first();
    const registered = await env.DB.prepare(
      "SELECT 1 AS found FROM registrations WHERE visitor_hash = ? LIMIT 1"
    ).bind(visitorHash).first();

    const headers = new Headers({
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    });
    if (isNew) {
      headers.append("Set-Cookie",
        COOKIE_NAME + "=" + token + "; Path=/; Max-Age=" + COOKIE_MAX_AGE + "; HttpOnly; Secure; SameSite=Lax");
    }
    return Response.json(
      { count: Number(row?.count || 0), registered: Boolean(registered), updatedAt: Date.now() },
      { headers }
    );
  } catch (error) {
    return Response.json({ error: "暂时无法读取报名人数，请稍后重试。" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
