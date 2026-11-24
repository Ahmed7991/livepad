const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#111111">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Pad">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon-192.png">
<style>
:root { --bg:#fafafa; --fg:#111; --muted:#666; --line:#e2e2e2; --btn:#fff; --accent:#2563eb; --ok:#16a34a; --warn:#d97706; --bad:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --line:#2a2a2a; --btn:#1c1c1c; } }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--fg);
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
button { font:inherit; color:var(--fg); background:var(--btn); border:1px solid var(--line);
  border-radius:10px; padding:8px 14px; cursor:pointer; -webkit-tap-highlight-color:transparent; }
button:active { transform: scale(.97); }
</style>`;

export const LOGIN = `<!doctype html><html lang="en"><head>${HEAD}<title>Pad · login</title>
<style>
body { display:grid; place-items:center; padding:16px; }
form { width:100%; max-width:320px; display:grid; gap:12px; }
h1 { margin:0 0 8px; font-size:24px; }
input { font:inherit; padding:12px; border-radius:10px; border:1px solid var(--line); background:var(--btn); color:var(--fg); }
button { padding:12px; background:var(--accent); color:#fff; border:0; font-weight:600; }
.err { color:var(--bad); margin:0; }
.hint { color:var(--muted); font-size:14px; margin:0; }
</style></head><body>
<form method="post" action="/login">
  <h1>Pad</h1>
  <!--ERR-->
  <input name="user" placeholder="Username" autocomplete="username" autocapitalize="none" autocorrect="off" required autofocus>
  <input name="pass" type="password" placeholder="Password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
  <p class="hint">You stay logged in on this device.</p>
</form></body></html>`;

export const PAGE = `<!doctype html><html lang="en"><head>${HEAD}<link rel="manifest" href="/manifest.json" crossorigin="use-credentials"><title>Pad</title>
<style>
body { display:flex; flex-direction:column; height:100dvh; }
header { display:flex; align-items:center; gap:8px; padding:8px 12px; padding-top:max(8px, env(safe-area-inset-top));
  border-bottom:1px solid var(--line); flex-wrap:wrap; }
#status { display:flex; align-items:center; gap:6px; font-size:14px; color:var(--muted); margin-right:auto; }
#dot { width:10px; height:10px; border-radius:50%; background:var(--warn); }
#dot.live { background:var(--ok); }
#dot.off { background:var(--bad); }
#copy { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
#clear.armed { background:var(--bad); color:#fff; border-color:var(--bad); }
textarea { flex:1; width:100%; border:0; outline:0; resize:none; padding:14px;
  padding-bottom:max(14px, env(safe-area-inset-bottom)); background:var(--bg); color:var(--fg);
  font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
#toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:var(--fg); color:var(--bg);
  padding:8px 16px; border-radius:20px; font-size:14px; opacity:0; transition:opacity .2s; pointer-events:none; }
#toast.show { opacity:1; }
</style></head><body>
<header>
  <div id="status"><span id="dot"></span><span id="label">Connecting…</span><span id="size"></span></div>
  <button id="paste">Paste</button>
  <button id="clear">Clear</button>
  <button id="copy">Copy all</button>
</header>
<textarea id="ta" placeholder="Type or paste here. It shows up on your other devices instantly." spellcheck="false" disabled></textarea>
<div id="toast"></div>
<script>
const ta = document.getElementById("ta"), dot = document.getElementById("dot"),
  label = document.getElementById("label"), size = document.getElementById("size");

let ws = null, ver = 0, confirmed = null, inflight = null, backoff = 500, lastMsg = 0, live = false;

// Single splice turning a into b (common prefix/suffix).
function diff(a, b) {
  if (a === b) return null;
  let p = 0; const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { from: p, to: a.length - s, text: b.slice(p, b.length - s) };
}
const apply = (str, op) => str.slice(0, op.from) + op.text + str.slice(op.to);

// Rebase local splice L over remote splice R (both against the same base).
function transform(L, R) {
  const d = R.text.length - (R.to - R.from);
  if (R.to <= L.from) return { from: L.from + d, to: L.to + d, text: L.text };
  if (R.from >= L.to) return L;
  if (L.from < R.from) return { from: L.from, to: R.from, text: L.text };
  const p = R.from + R.text.length;
  return { from: p, to: Math.max(p, L.to + d), text: L.text };
}

// Replace textarea content, keeping the caret where the user expects it.
function setValue(v) {
  const old = ta.value;
  if (old === v) return;
  const d = diff(old, v), delta = d.text.length - (d.to - d.from);
  const map = pos => pos <= d.from ? pos : pos >= d.to ? pos + delta : d.from + d.text.length;
  const focused = document.activeElement === ta;
  const ss = ta.selectionStart, se = ta.selectionEnd, st = ta.scrollTop;
  ta.value = v;
  if (focused) ta.setSelectionRange(map(ss), map(se));
  ta.scrollTop = st;
}

function fmtSize(n) { return n < 1000 ? n + " chars" : n < 1e6 ? (n / 1000).toFixed(1) + "k chars" : (n / 1e6).toFixed(2) + "M chars"; }

function render() {
  dot.className = live ? (inflight || (confirmed !== null && ta.value !== confirmed) ? "" : "live") : "off";
  label.textContent = !live ? "Offline, reconnecting…" : (inflight || ta.value !== confirmed) ? "Syncing…" : "Live";
  size.textContent = "· " + fmtSize(ta.value.length);
}

function flush() {
  render();
  if (!live || inflight || confirmed === null) return;
  const d = diff(confirmed, ta.value);
  if (!d) return;
  inflight = { result: ta.value };
  ws.send(JSON.stringify({ t: "op", base: ver, ...d }));
  render();
}

function onMessage(e) {
  lastMsg = Date.now();
  if (e.data === "pong") return;
  const m = JSON.parse(e.data);
  if (m.t === "init") {
    if (confirmed === null) {
      confirmed = m.text; ver = m.ver; ta.value = m.text; ta.disabled = false;
    } else {
      // Reconnect: merge whatever we typed offline onto the server's text.
      const base = inflight && m.text === inflight.result ? inflight.result : confirmed;
      const local = diff(base, ta.value), remote = diff(base, m.text);
      confirmed = m.text; ver = m.ver;
      setValue(local ? apply(confirmed, remote ? transform(local, remote) : local) : confirmed);
    }
    inflight = null; live = true; backoff = 500;
    flush();
    if (shared !== null) showShared();
  } else if (m.t === "ack") {
    confirmed = inflight.result; ver = m.ver; inflight = null;
    flush();
  } else if (m.t === "reject") {
    inflight = null; // our op was stale; a remote op already arrived and was merged
    flush();
  } else if (m.t === "op") {
    if (m.ver !== ver + 1) { ws.close(); return; } // out of order: resync
    const local = diff(confirmed, ta.value);
    confirmed = apply(confirmed, m); ver = m.ver;
    setValue(local ? apply(confirmed, transform(local, m)) : confirmed);
    render();
  }
}

// Opened from Android's share button: the server has already added the text.
let shared = new URLSearchParams(location.search).get("shared");
function showShared() {
  const ok = shared === "1"; shared = null;
  history.replaceState(null, "", "/");
  if (ok) ta.scrollTop = ta.scrollHeight;
  toast(ok ? "Shared text added" : "Nothing to add: the share had no text");
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onmessage = onMessage;
  ws.onclose = async () => {
    live = false; render(); // keep inflight: init needs it to spot an applied but unacked op
    try { const r = await fetch("/api/me", { cache: "no-store" }); if (r.status === 401) return location.reload(); } catch {}
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 5000);
  };
}

// Heartbeat: phones silently kill sockets in the background.
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastMsg > 40000) { ws.close(); return; }
  ws.send("ping");
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!ws || ws.readyState !== 1) return connect();
  const sent = Date.now(); ws.send("ping");
  setTimeout(() => { if (lastMsg < sent && ws.readyState === 1) ws.close(); }, 3000);
});
window.addEventListener("online", connect);

ta.addEventListener("input", flush);

function toast(t) { const el = document.getElementById("toast"); el.textContent = t; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 1500); }

document.getElementById("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); document.execCommand("copy"); }
  toast("Copied " + fmtSize(ta.value.length));
};
document.getElementById("paste").onclick = async () => {
  try {
    const t = await navigator.clipboard.readText();
    ta.focus(); ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, "end");
    flush(); toast("Pasted");
  } catch { toast("Clipboard blocked: long-press the text box and paste"); }
};
const clear = document.getElementById("clear");
clear.onclick = () => {
  if (!clear.classList.contains("armed")) {
    clear.classList.add("armed"); clear.textContent = "Tap to confirm";
    clearTimeout(clear.t); clear.t = setTimeout(() => { clear.classList.remove("armed"); clear.textContent = "Clear"; }, 3000);
    return;
  }
  clear.classList.remove("armed"); clear.textContent = "Clear";
  ta.value = ""; flush(); toast("Cleared");
};

connect();
</script></body></html>`;
