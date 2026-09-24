(() => {
  "use strict";
  const CFG = window.DIARY_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
  const $ = s => document.querySelector(s);
  const WD = ["日","月","火","水","木","金","土"];
  const pad = n => String(n).padStart(2,"0");
  const key = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const parse = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y, m-1, d); };
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate()+n); return key(d); };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const toast = msg => { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2000); };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  /* ================= 祝日 ================= */
  const HOL = (() => {
    const nthMon = (y, m, n) => { const d = new Date(y, m-1, 1); const off = (8 - d.getDay()) % 7; return 1 + off + (n-1)*7; };
    const equinox = (y, spring) => Math.floor((spring ? 20.8431 : 23.2488) + 0.242194*(y-1980) - Math.floor((y-1980)/4));
    const cache = new Map();
    const build = y => {
      const m = new Map(), set = (mo, d, name) => m.set(`${y}-${pad(mo)}-${pad(d)}`, name);
      set(1,1,"元日"); set(1,nthMon(y,1,2),"成人の日"); set(2,11,"建国記念の日"); set(2,23,"天皇誕生日");
      set(3,equinox(y,true),"春分の日"); set(4,29,"昭和の日"); set(5,3,"憲法記念日"); set(5,4,"みどりの日"); set(5,5,"こどもの日");
      set(7,nthMon(y,7,3),"海の日"); set(8,11,"山の日");
      const keiro = nthMon(y,9,3), shubun = equinox(y,false);
      set(9,keiro,"敬老の日"); set(9,shubun,"秋分の日"); if (shubun - keiro === 2) set(9, keiro+1, "国民の休日");
      set(10,nthMon(y,10,2),"スポーツの日"); set(11,3,"文化の日"); set(11,23,"勤労感謝の日");
      [...m.keys()].sort().forEach(k => { if (parse(k).getDay() !== 0) return; let n = addDays(k, 1); while (m.has(n)) n = addDays(n, 1); m.set(n, "振替休日"); });
      return m;
    };
    return k => { const y = +k.slice(0,4); if (!cache.has(y)) cache.set(y, build(y)); return cache.get(y).get(k) || null; };
  })();

  /* ================= 端末内キャッシュ（IndexedDB） ================= */
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("diary", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files", { keyPath: "id" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
      const t = db.transaction("files", mode), s = t.objectStore("files"), out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error);
    }); };
    return {
      all: () => tx("readonly", s => s.getAll()),
      put: rec => tx("readwrite", s => s.put(rec)),
      del: id => tx("readwrite", s => s.delete(id)),
      clear: () => tx("readwrite", s => s.clear())
    };
  })();

  /* ================= 認証（リダイレクト方式：ホーム画面アプリでも動く） ================= */
  const TK = "diary.token";
  const redirectUri = location.origin + location.pathname;
  const readToken = () => { try { const t = JSON.parse(localStorage.getItem(TK)); return t && t.exp > Date.now() + 60000 ? t.access_token : null; } catch { return null; } };
  const saveToken = (tok, sec) => { try { localStorage.setItem(TK, JSON.stringify({ access_token: tok, exp: Date.now() + sec*1000 })); } catch {} };
  const clearToken = () => { try { localStorage.removeItem(TK); } catch {} };

  function signIn(silent) {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("YOUR_")) { toast("config.js の CLIENT_ID が未設定です"); return; }
    const p = new URLSearchParams({
      client_id: CFG.CLIENT_ID, redirect_uri: redirectUri, response_type: "token",
      scope: SCOPES, include_granted_scopes: "true", state: silent ? "silent" : "interactive"
    });
    if (CFG.LOGIN_HINT) p.set("login_hint", CFG.LOGIN_HINT);
    if (silent) p.set("prompt", "none");
    try { sessionStorage.setItem("diary.silentAt", String(Date.now())); } catch {}
    location.replace("https://accounts.google.com/o/oauth2/v2/auth?" + p);
  }
  // 戻ってきたとき
  let authError = null;
  if (location.hash.length > 1) {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("access_token")) saveToken(h.get("access_token"), +h.get("expires_in") || 3600);
    else if (h.get("error")) authError = h.get("error");
    history.replaceState(null, "", location.pathname + location.search);
  }
  const recentlyTriedSilent = () => { const t = +(sessionStorage.getItem("diary.silentAt") || 0); return Date.now() - t < 120000; };

  /* ================= Drive ================= */
  async function api(url, opt = {}) {
    const tok = readToken();
    if (!tok) throw Object.assign(new Error("no token"), { code: 401 });
    const r = await fetch(url, { ...opt, headers: { ...(opt.headers||{}), Authorization: "Bearer " + tok } });
    if (r.status === 401) { clearToken(); throw Object.assign(new Error("unauthorized"), { code: 401 }); }
    if (!r.ok) throw Object.assign(new Error("drive " + r.status), { code: r.status });
    return r;
  }
  async function listFolder() {
    let files = [], pageToken = "";
    do {
      const q = encodeURIComponent(`'${CFG.FOLDER_ID}' in parents and trashed=false`);
      const r = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime)&pageSize=1000${pageToken ? "&pageToken=" + pageToken : ""}`);
      const j = await r.json(); files = files.concat(j.files || []); pageToken = j.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  const state = { files: new Map(), entries: new Map(), month: (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })(), day: null, editing: false, syncing: false };

  const ENTRY_RE = /^(\d{4}-\d{2}-\d{2})\.json$/, MEMO_RE = /^(\d{4}-\d{2}-\d{2})\.memo\..+\.json$/;
  function rebuild() {
    const entries = new Map(), memos = new Map();
    const sorted = [...state.files.values()].sort((a,b) => a.modifiedTime.localeCompare(b.modifiedTime));
    for (const f of sorted) {
      let m;
      if ((m = f.name.match(ENTRY_RE)) && f.data) entries.set(m[1], { ...f.data, date: m[1] }); // 同名は新しい方が勝つ
      else if ((m = f.name.match(MEMO_RE)) && f.data) { if (!memos.has(m[1])) memos.set(m[1], []); memos.get(m[1]).push(f.data); }
    }
    for (const [d, list] of memos) {
      const e = entries.get(d) || { date: d, title: "", oneLine: "", body: "", tags: [], people: [], notes: [] };
      e.notes = [...(e.notes||[]), ...list.map(x => ({ text: x.text, at: x.at }))].sort((a,b) => (a.at||"").localeCompare(b.at||""));
      e.formatted = false; entries.set(d, e);
    }
    state.entries = entries;
  }

  async function loadCache() {
    try { (await idb.all()).forEach(f => state.files.set(f.id, f)); } catch {}
    rebuild();
  }
  function setSync(html) { $("#sync").innerHTML = html; }

  async function sync({ full = false } = {}) {
    if (state.syncing) return;
    if (!navigator.onLine) { setSync(`オフライン：端末に保存済みの日記を表示しています`); return; }
    if (!readToken()) { needAuth(); return; }
    state.syncing = true; setSync("同期中…");
    try {
      if (full) { await idb.clear(); state.files.clear(); }
      const remote = await listFolder(), seen = new Set();
      for (const f of remote) {
        seen.add(f.id);
        if (!ENTRY_RE.test(f.name) && !MEMO_RE.test(f.name)) continue;
        const cached = state.files.get(f.id);
        if (cached && cached.modifiedTime === f.modifiedTime) continue;
        const r = await api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
        let data = null; try { data = await r.json(); } catch {}
        const rec = { id: f.id, name: f.name, modifiedTime: f.modifiedTime, data };
        state.files.set(f.id, rec); await idb.put(rec);
      }
      for (const id of [...state.files.keys()]) if (!seen.has(id)) { state.files.delete(id); await idb.del(id); }
      rebuild(); rerenderAll();
      const t = new Date(); setSync(`${t.getHours()}:${pad(t.getMinutes())} に同期 <button id="syncNow">再同期</button>`);
    } catch (e) {
      if (e.code === 401) needAuth();
      else setSync(`同期できませんでした <button id="syncNow">再試行</button>`);
    } finally { state.syncing = false; }
  }
  document.addEventListener("click", e => { if (e.target.id === "syncNow") sync(); });

  function needAuth() {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.startsWith("YOUR_")) { setSync("config.js の CLIENT_ID が未設定です"); return; }
    if (navigator.onLine && !recentlyTriedSilent()) { signIn(true); return; }
    if (state.entries.size) setSync(`ログインの有効期限が切れました <button id="reauth">ログイン</button>`);
    else showView("login");
  }
  document.addEventListener("click", e => { if (e.target.id === "reauth") signIn(false); });
  $("#signIn").onclick = () => signIn(false);
  $("#signOut").onclick = async () => { clearToken(); await idb.clear(); state.files.clear(); rebuild(); showView("login"); };
  $("#resync").onclick = () => { showView("cal"); sync({ full: true }); };

  async function uploadMemo(date, text) {
    const at = new Date().toISOString();
    const meta = { name: `${date}.memo.${Date.now()}.json`, parents: [CFG.FOLDER_ID], mimeType: "application/json" };
    const body = JSON.stringify({ date, text, at });
    const b = "diary" + Math.random().toString(36).slice(2);
    const payload = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    const r = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime", {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body: payload
    });
    const f = await r.json();
    const rec = { id: f.id, name: f.name, modifiedTime: f.modifiedTime, data: { date, text, at } };
    state.files.set(f.id, rec); await idb.put(rec); rebuild();
  }

  /* ================= 表示 ================= */
  const fmtTime = iso => { if (!iso) return ""; const d = new Date(iso); return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const md = src => (window.marked && window.DOMPurify) ? DOMPurify.sanitize(marked.parse(src || "", { gfm: true })) : `<p style="white-space:pre-wrap">${esc(src)}</p>`;
  const plain = e => [e.title, e.oneLine, (e.body||"").replace(/[#*>\-\[\]`|]/g," "), ...(e.notes||[]).map(n=>n.text)].join(" ");

  function renderCal() {
    const m = state.month, y = m.getFullYear(), mo = m.getMonth();
    $("#monthLabel").innerHTML = `<small>${y}</small>${mo+1}月`;
    const first = new Date(y, mo, 1).getDay(), days = new Date(y, mo+1, 0).getDate(), today = key(new Date());
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(`<div class="cell out"></div>`);
    for (let d = 1; d <= days; d++) {
      const k = `${y}-${pad(mo+1)}-${pad(d)}`, e = state.entries.get(k), wd = (first + d - 1) % 7, hol = HOL(k);
      const cls = ["cell", e ? "has" : "", e && e.formatted === false ? "raw" : "", k === today ? "today" : "", wd === 0 ? "sun" : wd === 6 ? "sat" : "", hol ? "hol" : ""].join(" ");
      const sub = e && e.title ? `<span class="t">${esc(e.title)}</span>` : hol ? `<span class="hn">${esc(hol)}</span>` : "";
      cells.push(`<button class="${cls}" data-k="${k}" aria-label="${mo+1}月${d}日${hol ? "、" + hol : ""}${e ? "、日記あり" : ""}"><span class="n">${d}</span>${sub}</button>`);
    }
    while (cells.length % 7) cells.push(`<div class="cell out"></div>`);
    $("#grid").innerHTML = cells.join("");
  }
  function renderFeed() {
    const m = state.month, y = m.getFullYear(), mo = m.getMonth();
    $("#feedLabel").innerHTML = `<small>${y}</small>${mo+1}月`;
    const list = [...state.entries.values()].filter(e => e.date.startsWith(`${y}-${pad(mo+1)}`)).sort((a,b) => a.date.localeCompare(b.date));
    $("#listH").textContent = `${mo+1}月の日記（${list.length}日）`;
    $("#monthList").innerHTML = list.length ? list.map(e => { const d = parse(e.date);
      return `<button class="row" data-k="${e.date}"><span class="d">${d.getDate()}日（${WD[d.getDay()]}）</span><span class="tt">${esc(e.title || "（メモのみ）")}</span>${e.formatted === false ? `<span class="raw-mark">未整形</span>` : ""}</button>`;
    }).join("") : `<div class="empty">この月はまだ記録がありません。</div>`;
  }
  $("#monthList").addEventListener("click", ev => { const b = ev.target.closest("[data-k]"); if (b) openDay(b.dataset.k); });
  const shiftMonth = n => { state.month = new Date(state.month.getFullYear(), state.month.getMonth()+n, 1); };
  $("#fPrevM").onclick = () => { shiftMonth(-1); renderFeed(); window.scrollTo(0,0); };
  $("#fNextM").onclick = () => { shiftMonth(1); renderFeed(); window.scrollTo(0,0); };
  $("#grid").addEventListener("click", ev => { const b = ev.target.closest("[data-k]"); if (b) openDay(b.dataset.k); });
  $("#prevM").onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth()-1, 1); renderCal(); };
  $("#nextM").onclick = () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth()+1, 1); renderCal(); };
  $("#todayBtn").onclick = () => { const d = new Date(); state.month = new Date(d.getFullYear(), d.getMonth(), 1); renderCal(); };

  function openDay(k, dir) { state.day = k; state.editing = false; $("#sheet").hidden = false; document.body.style.overflow = "hidden"; renderDay(dir); }
  function closeDay() {
    $("#sheet").hidden = true; document.body.style.overflow = "";
    if (state.day) { const d = parse(state.day); state.month = new Date(d.getFullYear(), d.getMonth(), 1); }
    state.day = null; rerenderAll();
  }
  $("#closeSheet").onclick = closeDay;
  $("#prevD").onclick = () => go(-1);
  $("#nextD").onclick = () => go(1);
  $("#editBtn").onclick = () => { state.editing = true; renderDay(); };
  function go(n) { if (state.editing) return; state.day = addDays(state.day, n); renderDay(n > 0 ? "l" : "r"); $("#sheetBody").scrollTop = 0; }
  document.addEventListener("keydown", e => {
    if ($("#sheet").hidden || state.editing) return;
    if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); else if (e.key === "Escape") closeDay();
  });
  let sx = 0, sy = 0, st = 0;
  const sb = $("#sheetBody");
  sb.addEventListener("touchstart", e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
  sb.addEventListener("touchend", e => {
    if (state.editing) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && Date.now() - st < 700) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  function renderDay(dir) {
    const k = state.day, d = parse(k), e = state.entries.get(k), hol = HOL(k), page = $("#page");
    page.className = "page" + (dir === "l" ? " slide-l" : dir === "r" ? " slide-r" : "");
    $("#editBtn").hidden = state.editing;
    const head = `<h1 class="date-h"><span class="yr">${d.getFullYear()}</span>${d.getMonth()+1}月${d.getDate()}日<span class="wd">${WD[d.getDay()]}曜日${hol ? "・" + esc(hol) : ""}</span></h1>`;
    if (state.editing) {
      page.innerHTML = head + `<div class="editor"><label for="fText">メモ</label>
        <textarea id="fText" placeholder="思いついたことをそのまま。次にClaudeと話すとき、日記の本文にまとめます。"></textarea>
        <p class="help">メモはドライブに「未整形」として保存され、カレンダーでは点線の印になります。</p>
        <div class="actions"><button class="btn primary" id="save">保存する</button><button class="btn" id="cancel">やめる</button></div></div>`;
      $("#cancel").onclick = () => { state.editing = false; renderDay(); };
      $("#save").onclick = async () => {
        const text = $("#fText").value.trim(); if (!text) { toast("メモが空です"); return; }
        if (!navigator.onLine) { toast("オフラインでは保存できません"); return; }
        $("#save").disabled = true;
        try { await uploadMemo(k, text); toast("メモを保存しました"); state.editing = false; renderDay(); renderCal(); }
        catch (err) { $("#save").disabled = false; if (err.code === 401) { toast("ログインし直してください"); needAuth(); } else toast("保存できませんでした。もう一度試してください"); }
      };
      setTimeout(() => $("#fText").focus(), 50);
      return;
    }
    if (!e) {
      page.innerHTML = head + `<div class="blank"><p>この日の日記はまだありません。</p><button class="btn primary" id="startNote">メモを書く</button></div>`;
      $("#startNote").onclick = () => { state.editing = true; renderDay(); };
      return;
    }
    const tags = (e.tags||[]).map(t => `<button class="tag" data-q="#${esc(t)}">#${esc(t)}</button>`).join("");
    const people = (e.people||[]).map(p => `<button class="tag" data-q="${esc(p)}">${esc(p)}</button>`).join("");
    const notes = (e.notes||[]).length ? `<div class="notes"><h2 class="section-h">手書きメモ</h2>${e.notes.map(n => `<div class="note"><time>${esc(fmtTime(n.at))}</time>${esc(n.text)}</div>`).join("")}</div>` : "";
    page.innerHTML = head + (e.title ? `<h2 class="entry-title">${esc(e.title)}</h2>` : "") +
      `<div class="meta">${people ? `<div><span class="lbl">人</span>${people}</div>` : ""}${tags ? `<div>${tags}</div>` : ""}</div>` +
      (e.formatted === false ? `<p class="raw-hint">未整形のメモがあります。次にClaudeと話すときに日記へまとめられます。</p>` : "") +
      (e.oneLine ? `<div class="oneline">${esc(e.oneLine)}</div>` : "") + `<div class="md">${md(e.body)}</div>` + notes;
    page.querySelectorAll("[data-q]").forEach(b => b.onclick = () => { closeDay(); showView("search"); $("#q").value = b.dataset.q; runSearch(); });
  }

  const count = arr => { const m = new Map(); arr.forEach(x => m.set(x, (m.get(x)||0)+1)); return [...m].sort((a,b) => b[1]-a[1]); };
  function runSearch() {
    const raw = $("#q").value.trim(), all = [...state.entries.values()].sort((a,b) => b.date.localeCompare(a.date));
    $("#tagcloud").innerHTML = count(all.flatMap(e => e.tags||[])).slice(0, 24).map(([t,n]) => `<button data-q="#${esc(t)}">#${esc(t)}<span>${n}</span></button>`).join("");
    if (!raw) { $("#hits").innerHTML = ""; return; }
    const terms = raw.split(/\s+/).filter(Boolean), words = terms.filter(t => !t.startsWith("#"));
    const hits = all.filter(e => terms.every(t => t.startsWith("#")
      ? (e.tags||[]).some(x => x.includes(t.slice(1)))
      : (plain(e) + " " + (e.people||[]).join(" ") + " " + (e.tags||[]).join(" ")).toLowerCase().includes(t.toLowerCase())));
    $("#hits").innerHTML = hits.length ? `<div class="empty">${hits.length}件</div>` + hits.map(e => {
      const d = parse(e.date), txt = plain(e).replace(/\s+/g," ");
      const i = words.length ? txt.toLowerCase().indexOf(words[0].toLowerCase()) : -1;
      let sn = esc(i >= 0 ? txt.slice(Math.max(0, i-24), i+70) : (e.oneLine || txt.slice(0, 80)));
      words.forEach(w => { sn = sn.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g,"\\$&"), "gi"), m => `<mark>${m}</mark>`); });
      return `<button class="hit" data-k="${e.date}"><div class="hd"><span class="d">${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}（${WD[d.getDay()]}）</span><span class="tt">${esc(e.title||"（メモのみ）")}</span></div><div class="sn">${sn}</div></button>`;
    }).join("") : `<div class="empty">「${esc(raw)}」を含む日記は見つかりませんでした。</div>`;
  }
  $("#tagcloud").addEventListener("click", ev => { const b = ev.target.closest("[data-q]"); if (b) { $("#q").value = b.dataset.q; runSearch(); } });
  $("#q").addEventListener("input", runSearch);
  $("#hits").addEventListener("click", ev => { const b = ev.target.closest("[data-k]"); if (b) openDay(b.dataset.k); });

  function renderStats() {
    const dates = [...state.entries.keys()].sort(), set = new Set(dates), today = key(new Date());
    let cur = 0, c = set.has(today) ? today : addDays(today, -1); while (set.has(c)) { cur++; c = addDays(c, -1); }
    let best = 0, run = 0, prev = null; dates.forEach(d => { run = (prev && addDays(prev, 1) === d) ? run + 1 : 1; best = Math.max(best, run); prev = d; });
    const now = new Date(), ym = `${now.getFullYear()}-${pad(now.getMonth()+1)}`;
    $("#kv").innerHTML = `<div><b>${dates.length}</b><span>記録した日数</span></div><div><b>${dates.filter(d => d.startsWith(ym)).length}</b><span>今月（${now.getMonth()+1}月）</span></div><div><b>${cur}</b><span>いまの連続日数</span></div><div><b>${best}</b><span>最長の連続日数</span></div>`;
    const months = []; for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth()-i, 1));
    const counts = months.map(d => dates.filter(x => x.startsWith(`${d.getFullYear()}-${pad(d.getMonth()+1)}`)).length), max = Math.max(1, ...counts);
    $("#bars").innerHTML = counts.map((n,i) => `<div class="bar${n?"":" zero"}" style="height:${n ? Math.max(4, n/max*100) : 1}%" title="${months[i].getMonth()+1}月 ${n}日"></div>`).join("");
    $("#barlbl").innerHTML = months.map(d => `<span>${d.getMonth()+1}</span>`).join("");
    const rank = (el, pairs, prefix) => { const mx = pairs.length ? pairs[0][1] : 1;
      el.innerHTML = pairs.length ? pairs.slice(0, 10).map(([n,c]) => `<button class="r" data-q="${prefix}${esc(n)}"><span class="nm">${prefix}${esc(n)}</span><span class="ln"><i style="width:${c/mx*100}%"></i></span><span class="c">${c}</span></button>`).join("") : `<div class="empty">まだありません。</div>`; };
    const all = [...state.entries.values()];
    rank($("#rankPeople"), count(all.flatMap(e => e.people||[])), "");
    rank($("#rankTags"), count(all.flatMap(e => e.tags||[])), "#");
  }
  document.querySelectorAll(".rank").forEach(el => el.addEventListener("click", ev => { const b = ev.target.closest("[data-q]"); if (!b) return; showView("search"); $("#q").value = b.dataset.q; runSearch(); }));

  function showView(v) {
    ["cal","feed","search","stats","login"].forEach(x => $("#v-"+x).hidden = x !== v);
    $("#tabs").hidden = v === "login";
    document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-current", t.dataset.view === v ? "true" : "false"));
    if (v === "cal") renderCal(); if (v === "feed") renderFeed(); if (v === "search") runSearch(); if (v === "stats") renderStats();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));
  function rerenderAll() {
    if (!$("#v-login").hidden) showView("cal");
    if (!$("#v-cal").hidden) renderCal(); if (!$("#v-feed").hidden) renderFeed(); if (!$("#v-search").hidden) runSearch(); if (!$("#v-stats").hidden) renderStats();
    if (!$("#sheet").hidden && !state.editing) renderDay();
  }

  /* ================= 起動 ================= */
  (async () => {
    await loadCache();
    showView(state.entries.size || readToken() ? "cal" : "login");
    if (authError && !state.entries.size) showView("login");
    if (authError) { needAuthAfterError(); return; }
    sync();
  })();
  function needAuthAfterError() {
    if (state.entries.size) setSync(`ログインが必要です <button id="reauth">ログイン</button>`);
    else showView("login");
  }
  window.addEventListener("online", () => sync());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && readToken()) sync(); });
})();
