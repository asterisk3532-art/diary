/* 日記アプリのロック（パスワード＋Face ID）
   ・パスワードは端末内に「ハッシュ（PBKDF2）」だけ保存。パスワードそのものは保存しない
   ・Face IDは端末のパスキー（WebAuthn）で本人確認する
   ・アプリを開いたとき、1分以上ほかのアプリに切り替えて戻ってきたときにロック
   ・パスワードを忘れたら、端末内の日記データとログイン情報を消して最初からやり直す（ドライブの日記は消えない） */
(() => {
  "use strict";
  const KEY = "diary.lock", RELOCK_MS = 60 * 1000, ITER = 150000, MAX_TRY = 5, WAIT_MS = 30 * 1000;
  const $ = s => document.querySelector(s);
  const enc = new TextEncoder();
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  const store = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} };

  async function hashPw(pw, saltB64, iter) {
    const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
    return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, k, 256));
  }
  const faceSupported = async () => {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
  };
  async function registerFace() {
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: "日記", id: location.hostname },
      user: { id: rand(16), name: "diary-lock", displayName: "日記のロック" },
      challenge: rand(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000, attestation: "none"
    }});
    return b64(cred.rawId);
  }
  async function checkFace(credId) {
    const a = await navigator.credentials.get({ publicKey: {
      challenge: rand(32), timeout: 60000, userVerification: "required", rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64(credId), transports: ["internal", "hybrid"] }]
    }});
    return !!a; // 端末が本人確認（Face ID）を通したときだけ返ってくる
  }

  /* ---------- 画面 ---------- */
  const el = $("#lock");
  let state = "locked", hiddenAt = 0, fails = 0, waitUntil = 0;
  const show = html => { el.hidden = false; el.innerHTML = `<div class="lock-in">${html}</div>`; document.documentElement.classList.add("locked"); };
  const hide = () => { el.hidden = true; el.innerHTML = ""; document.documentElement.classList.remove("locked"); state = "open"; };
  const msg = (t, bad) => { const m = $("#lockMsg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } };

  function setupScreen(changing) {
    state = "setup";
    show(`<h1>${changing ? "パスワードを変える" : "ロックをかける"}</h1>
      <p class="lock-sub">日記を開くときのパスワードを決めてください（4文字以上）。</p>
      <input id="pw1" type="password" autocomplete="new-password" placeholder="パスワード">
      <input id="pw2" type="password" autocomplete="new-password" placeholder="もう一度">
      <p id="lockMsg" class="lock-msg"></p>
      <button class="btn primary" id="pwSave">決める</button>
      ${changing ? `<button class="btn quiet" id="pwCancel">やめる</button>` : ""}`);
    $("#pw1").focus();
    if (changing) $("#pwCancel").onclick = hide;
    $("#pwSave").onclick = async () => {
      const a = $("#pw1").value, b = $("#pw2").value;
      if (a.length < 4) return msg("4文字以上にしてください", true);
      if (a !== b) return msg("2回の入力が違います", true);
      const old = load() || {}, salt = b64(rand(16));
      store({ ...old, salt, iter: ITER, hash: await hashPw(a, salt, ITER) });
      if (!old.credId && await faceSupported()) faceOfferScreen(); else { hide(); toast("パスワードを設定しました"); }
    };
  }
  function faceOfferScreen() {
    show(`<h1>Face IDも使う？</h1>
      <p class="lock-sub">オンにすると、次からFace IDで開けます。パスワードでも開けます。<br>iPhoneに「日記のロック」というパスキーが保存されます。</p>
      <p id="lockMsg" class="lock-msg"></p>
      <button class="btn primary" id="faceOn">Face IDを使う</button>
      <button class="btn quiet" id="faceSkip">使わない</button>`);
    $("#faceSkip").onclick = () => { hide(); toast("パスワードを設定しました"); };
    $("#faceOn").onclick = async () => {
      try { const credId = await registerFace(); store({ ...load(), credId }); hide(); toast("Face IDをオンにしました"); }
      catch { msg("Face IDを登録できませんでした。あとで「記録」画面からもう一度できます", true); }
    };
  }
  function lockScreen() {
    state = "locked";
    const cfg = load(), face = !!(cfg && cfg.credId);
    show(`<h1>日記</h1>
      <p class="lock-sub">ロックされています</p>
      ${face ? `<button class="btn primary lock-face" id="faceBtn"><svg viewBox="0 0 24 24"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16c1.5 1 3.5 1 5 0"/></svg>Face IDで開く</button>` : ""}
      <input id="pw" type="password" autocomplete="current-password" placeholder="パスワード" enterkeyhint="go">
      <p id="lockMsg" class="lock-msg"></p>
      <button class="btn ${face ? "" : "primary"}" id="pwOpen">開く</button>
      <button class="lock-forgot" id="forgot">パスワードを忘れた</button>`);
    $("#pwOpen").onclick = tryPw;
    $("#pw").addEventListener("keydown", e => { if (e.key === "Enter") tryPw(); });
    $("#forgot").onclick = forgot;
    if (face) { $("#faceBtn").onclick = tryFace; tryFace(true); }
  }
  async function tryFace(auto) {
    const cfg = load(); if (!cfg || !cfg.credId || state !== "locked") return;
    try { if (await checkFace(cfg.credId)) hide(); }
    catch { if (!auto) msg("Face IDで開けませんでした。パスワードを入れてください", true); }
  }
  async function tryPw() {
    if (Date.now() < waitUntil) return msg(`しばらく待ってからもう一度（あと${Math.ceil((waitUntil - Date.now()) / 1000)}秒）`, true);
    const cfg = load(), pw = $("#pw").value;
    if (!pw) return;
    if (await hashPw(pw, cfg.salt, cfg.iter || ITER) === cfg.hash) { fails = 0; hide(); return; }
    fails++; $("#pw").value = "";
    if (fails >= MAX_TRY) { fails = 0; waitUntil = Date.now() + WAIT_MS; msg("間違いが続いたので30秒待ってください", true); }
    else msg("パスワードが違います", true);
  }
  async function forgot() {
    if (!confirm("この端末に保存した日記とログイン情報を消して、最初からやり直します。ドライブの日記は消えません。続けますか？")) return;
    try { Object.keys(localStorage).filter(k => k.startsWith("diary.")).forEach(k => localStorage.removeItem(k)); } catch {}
    try { await new Promise(r => { const q = indexedDB.deleteDatabase("diary"); q.onsuccess = q.onerror = q.onblocked = r; }); } catch {}
    location.replace(location.pathname);
  }
  const toast = t => { const x = $("#toast"); if (!x) return; x.textContent = t; x.classList.add("on"); setTimeout(() => x.classList.remove("on"), 2000); };

  /* ---------- 起動・切り替え ---------- */
  function start() { if (load() && load().hash) lockScreen(); else setupScreen(false); }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (state === "open") { hiddenAt = Date.now(); state = "covered"; show(`<h1>日記</h1>`); } // アプリ切替画面に中身を映さない
    } else if (state === "covered") {
      if (Date.now() - hiddenAt < RELOCK_MS) hide(); else lockScreen();
    }
  });

  // 「記録」画面の設定ボタン
  window.DiaryLock = {
    changePassword: () => setupScreen(true),
    toggleFace: async () => {
      const cfg = load(); if (!cfg) return;
      if (cfg.credId) { delete cfg.credId; store(cfg); toast("Face IDをオフにしました"); renderSettings(); return; }
      if (!await faceSupported()) { toast("この端末ではFace IDが使えません"); return; }
      try { cfg.credId = await registerFace(); store(cfg); toast("Face IDをオンにしました"); } catch { toast("Face IDを登録できませんでした"); }
      renderSettings();
    },
    lockNow: () => lockScreen()
  };
  function renderSettings() {
    const b = $("#faceToggle"); if (b) b.textContent = (load() || {}).credId ? "Face IDをオフにする" : "Face IDをオンにする";
  }
  document.addEventListener("click", e => {
    if (e.target.id === "pwChange") DiaryLock.changePassword();
    else if (e.target.id === "faceToggle") DiaryLock.toggleFace();
    else if (e.target.id === "lockNow") DiaryLock.lockNow();
  });
  renderSettings();
  start();
})();
