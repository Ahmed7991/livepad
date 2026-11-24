// livepad — one shared live text pad, synced over WebSocket via a Durable Object.
import { DurableObject } from "cloudflare:workers";
import { PAGE, LOGIN } from "./html.js";
import { icon } from "./icons.js";

const COOKIE = "lp";
const TEN_YEARS = 60 * 60 * 24 * 365 * 10;
const CHUNK = 512 * 1024; // UTF-16 code units, stored as bytes so a split surrogate pair survives

const enc = new TextEncoder();

function packUtf16(s) {
  const u = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
function unpackUtf16(buf) {
  const u = new Uint16Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return s;
}

async function sessionToken(env) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Includes the password: changing PAD_PASS logs every device out.
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`v1:${env.PAD_USER}:${env.PAD_PASS}`));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Secret path the installed app posts shared text to. It only allows appending to the pad,
// and is only handed out in the manifest of a logged-in browser, so it needs no cookie.
// Not tied to the password: changing PAD_PASS must not break an installed app's share button.
async function sharePath(env) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("share:v1"));
  return "/share/" + [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Apps differ: some send the text as `text`, some as `title`, some as a .txt file.
async function sharedText(req) {
  const form = await req.formData();
  const parts = [];
  for (const k of ["title", "text", "url", "files"]) {
    for (const v of form.getAll(k)) {
      const s = (typeof v === "string" ? v : await v.text()).replace(/\r\n?/g, "\n").trim();
      if (s && !parts.some(p => p.includes(s))) parts.push(s);
    }
  }
  // Drop a title that the body already contains.
  return parts.filter((p, i) => !parts.some((q, j) => j !== i && q.includes(p))).join("\n");
}

function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function getCookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? m[1] : null;
}

async function authed(req, env) {
  const c = getCookie(req, COOKIE);
  return !!c && safeEqual(c, await sessionToken(env));
}

const html = (body, status = 200) => new Response(body, {
  status,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/login" && req.method === "POST") {
      const { success } = await env.LOGIN_LIMIT.limit({ key: req.headers.get("CF-Connecting-IP") || "local" });
      if (!success) return html(LOGIN.replace("<!--ERR-->", '<p class="err">Too many attempts. Wait a minute.</p>'), 429);
      const form = await req.formData();
      const ok = safeEqual(String(form.get("user") || "").trim().toLowerCase(), env.PAD_USER.toLowerCase())
        && safeEqual(String(form.get("pass") || ""), env.PAD_PASS);
      if (!ok) {
        await new Promise(r => setTimeout(r, 800));
        return html(LOGIN.replace("<!--ERR-->", '<p class="err">Wrong username or password</p>'), 401);
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${await sessionToken(env)}; Max-Age=${TEN_YEARS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (url.pathname === "/manifest.json") {
      const m = {
        id: "/", name: "Pad", short_name: "Pad", start_url: "/", scope: "/", display: "standalone",
        background_color: "#111111", theme_color: "#111111",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      };
      if (await authed(req, env)) {
        m.share_target = {
          action: await sharePath(env), method: "POST", enctype: "multipart/form-data",
          params: { title: "title", text: "text", url: "url",
            files: [{ name: "files", accept: ["text/plain", ".txt"] }] },
        };
      }
      return Response.json(m, { headers: { "Cache-Control": "no-store", "Vary": "Cookie" } });
    }
    const size = { "/icon-192.png": 192, "/icon-512.png": 512 }[url.pathname];
    if (size) {
      return new Response(await icon(size),
        { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });
    }
    if (url.pathname.startsWith("/share/")) {
      if (!safeEqual(url.pathname, await sharePath(env))) return new Response("not found", { status: 404 });
      let ok = false;
      if (req.method === "POST") {
        const text = await sharedText(req);
        if (text) { await env.PAD.get(env.PAD.idFromName("main")).append(text); ok = true; }
      }
      return new Response(null, { status: 303, headers: { Location: ok ? "/?shared=1" : "/?shared=0", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/icon.svg") {
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2563eb"/><path d="M28 30h44M28 46h44M28 62h28" stroke="#fff" stroke-width="8" stroke-linecap="round"/></svg>`,
        { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
    }

    if (!(await authed(req, env))) {
      if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) return new Response("unauthorized", { status: 401 });
      return html(LOGIN);
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      return env.PAD.get(env.PAD.idFromName("main")).fetch(req);
    }

    if (url.pathname === "/api/me") return new Response(null, { status: 204 });

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303, headers: { Location: "/", "Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` },
      });
    }

    return html(PAGE);
  },
};

// Server is authoritative. Each client sends one splice at a time against the
// version it last saw; a stale splice is rejected and the client rebases.
export class Pad extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS chunks (i INTEGER PRIMARY KEY, s BLOB NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const rows = this.sql.exec("SELECT s FROM chunks ORDER BY i").toArray();
    this.text = rows.map(r => typeof r.s === "string" ? r.s : unpackUtf16(r.s)).join("");
    const v = this.sql.exec("SELECT v FROM meta WHERE k='ver'").toArray();
    this.ver = v.length ? v[0].v : 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: "init", text: this.text, ver: this.ver }));
    return new Response(null, { status: 101, webSocket: client });
  }

  persist(from) {
    const first = Math.floor(from / CHUNK);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chunks WHERE i >= ?", first);
      for (let i = first; i * CHUNK < this.text.length; i++) {
        this.sql.exec("INSERT INTO chunks (i, s) VALUES (?, ?)", i, packUtf16(this.text.slice(i * CHUNK, (i + 1) * CHUNK)));
      }
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('ver', ?)", this.ver);
    });
  }

  // Add a block at the end, separated from what is there by a blank line.
  append(block) {
    const at = this.text.length;
    const sep = !at || this.text.endsWith("\n\n") ? "" : this.text.endsWith("\n") ? "\n" : "\n\n";
    const text = sep + block + "\n";
    this.text += text;
    this.ver++;
    this.persist(at);
    const out = JSON.stringify({ t: "op", ver: this.ver, from: at, to: at, text });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(out); } catch {} }
  }

  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== "op") return;
    const { base, from, to, text } = m;
    if (base !== this.ver) {
      ws.send(JSON.stringify({ t: "reject", ver: this.ver }));
      return;
    }
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= this.text.length
      && typeof text === "string")) {
      ws.send(JSON.stringify({ t: "init", text: this.text, ver: this.ver }));
      return;
    }
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.ver++;
    this.persist(from);
    ws.send(JSON.stringify({ t: "ack", ver: this.ver }));
    const out = JSON.stringify({ t: "op", ver: this.ver, from, to, text });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(out); } catch {} }
    }
  }

  async webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
  async webSocketError() {}
}
