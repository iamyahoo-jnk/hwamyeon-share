// 화면 공유기
// - 방 연결: PeerJS 공개 신호 서버. 방마다 '허브' 한 명이 참여자 목록과 알림을 중계한다.
//   허브가 나가면 남은 사람 중 한 명이 자동으로 허브를 이어받는다.
// - 영상: 공유자 → 직접 SHARER_FANOUT 명, 넘치면 이미 보고 있는 사람이 RELAY_FANOUT 명씩 다시 넘겨준다(릴레이).
//   릴레이 배치는 공유자가 정하고, 중계자가 나가면 그 아래 사람을 다시 배치한다.

const PREFIX = "hwamyeon-share-v1-";
const TEST_FANOUT = Number(new URLSearchParams(location.search).get("fanout")) || 0; // 시험용: 직접 받는 인원을 줄여 릴레이 확인
const SHARER_FANOUT = TEST_FANOUT || 6;
const RELAY_FANOUT = 3;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const randStr = (n, chars = "abcdefghijkmnpqrstuvwxyz23456789") =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), b => chars[b % chars.length]).join("");
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

if (qs.get("room") && qs.get("name")) startApp(qs.get("room").toUpperCase(), qs.get("name"));
else startJoin();

/* ───────── 입장 화면 ───────── */

function startJoin() {
  $("join").hidden = false;
  $("name").value = store.get("hws-name") || "";
  $("room").value = (qs.get("room") || "").toUpperCase();
  $("new-room").onclick = () => { $("room").value = randStr(6, CODE_CHARS); };
  let last = null;
  $("join-form").onsubmit = e => {
    e.preventDefault();
    const name = $("name").value.trim(), room = $("room").value.trim().toUpperCase();
    if (!name || !/^[A-Z0-9]{4,6}$/.test(room)) { $("room").focus(); return; }
    store.set("hws-name", name);
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    last = { room, name };
    openApp(room, name);
  };
  $("reopen").onclick = () => last && openApp(last.room, last.name);
}

function openApp(room, name) {
  const url = `${location.pathname}?room=${room}&name=${encodeURIComponent(name)}`;
  const r = rightHalf();
  const win = window.open(url, "hwamyeon-" + room, `popup=yes,left=${r.x},top=${r.y},width=${r.w},height=${r.h}`);
  if (!win) { location.href = url; return; } // 팝업 차단 시 이 탭에서 진행
  $("join-form").hidden = true;
  $("opened").hidden = false;
}

function rightHalf() {
  const sw = screen.availWidth, sh = screen.availHeight;
  const w = Math.round(sw / 2);
  return { x: (screen.availLeft || 0) + sw - w, y: screen.availTop || 0, w, h: sh };
}

/* ───────── 공유기 창 ───────── */

function startApp(room, name) {
  document.title = `화면 공유기 · ${room}`;
  $("app").hidden = false;
  $("room-code").textContent = room;

  const hubId = PREFIX + room;
  const me = { id: null, name };
  let peer, hubConn = null, hubPeer = null, reconnecting = false;
  let members = [];
  // 입장 승인: 방장이 승인하면 방 비밀값(pass)을 받는다. 방장이 바뀌어도 pass가 있으면 다시 승인받지 않는다.
  let pass = null, admitted = false, triedOnce = false, denied = false;
  const approvalToasts = new Map();

  // 공유자 상태
  let myStream = null, myShareKey = null;
  const parentOf = new Map(); // viewerId → parentId
  const ready = new Set();    // 영상을 받고 있는 사람(중계 가능)

  // 시청자 상태
  let viewing = null;         // { sharerId, name, key }
  let inCall = null, remoteStream = null;
  const myKids = new Set();   // 내가 중계해 주는 사람

  const outCalls = new Map(); // 내가 영상을 보내는 상대 → call
  const pendingToasts = new Map();

  /* 창 배치 */
  const snap = () => { const r = rightHalf(); try { window.moveTo(r.x, r.y); window.resizeTo(r.w, r.h); } catch {} };
  if (window.opener) snap();
  $("snap").onclick = snap;

  $("copy-room").onclick = async () => {
    try { await navigator.clipboard.writeText(room); info("방 코드를 복사했습니다."); }
    catch { info(`방 코드: ${room}`); }
  };
  $("members-btn").onclick = () => { $("members").hidden = !$("members").hidden; };

  /* ── 연결 ── */
  peer = new Peer(PREFIX + room + "-" + randStr(8));
  peer.on("open", id => { me.id = id; joinRoom(); });
  peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
  peer.on("error", e => {
    if (e.type === "peer-unavailable") return; // 허브 탐색 중 흔히 생김
    if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) setStatus("인터넷 연결을 확인해 주세요");
  });
  peer.on("call", onIncomingCall);
  addEventListener("beforeunload", () => { endShare(true); peer.destroy(); hubPeer?.destroy(); });

  async function joinRoom() {
    setStatus("방에 연결 중…");
    if (denied) return;
    // 승인받지 않은 사람은 처음 한 번만 방장 자리를 시도한다(방장이 잠깐 비었을 때 끼어들지 못하게).
    if (!hubPeer && (admitted || !triedOnce)) await claimHub();
    triedOnce = true;
    const c = peer.connect(hubId, { reliable: true });
    let opened = false;
    const timer = setTimeout(() => { if (!opened) { c.close(); hubLost(); } }, 7000);
    c.on("open", () => {
      opened = true; clearTimeout(timer); hubConn = c;
      c.send({ t: "hello", name: me.name, pass, sharing: myStream ? myShareKey : null });
    });
    c.on("data", onMsg);
    c.on("close", () => { if (hubConn === c) hubLost(); });
    c.on("error", () => { if (hubConn === c) hubLost(); });
  }

  function hubLost() {
    if (reconnecting || denied) return;
    reconnecting = true; hubConn = null;
    setStatus("다시 연결 중…");
    setTimeout(() => { reconnecting = false; joinRoom(); }, 400 + Math.random() * 1600);
  }

  function claimHub() {
    return new Promise(resolve => {
      const hp = new Peer(hubId);
      let done = false;
      hp.on("open", () => { done = true; hubPeer = hp; runHub(hp); resolve(true); });
      hp.on("error", () => { if (!done) { done = true; hp.destroy(); resolve(false); } });
      setTimeout(() => { if (!done) { done = true; hp.destroy(); resolve(false); } }, 5000);
    });
  }

  const send = m => { try { hubConn?.send(m); } catch {} };
  const sendTo = (to, msg) => send({ t: "to", to, msg });

  /* ── 허브(방장 역할) ── */
  function runHub(hp) {
    const ms = new Map(); // peerId → { name, conn }  (승인된 사람만)
    const waiting = new Map(); // 승인 대기
    const roomPass = pass || randStr(16);
    pass = roomPass;
    let share = null;     // { sharerId, name, key }
    const all = m => ms.forEach(x => { try { x.conn.send(m); } catch {} });
    const list = () => all({ t: "members", list: [...ms].map(([id, x]) => ({ id, name: x.name })) });

    function admit(from, conn, m) {
      ms.set(from, { name: m.name, conn });
      conn.send({ t: "welcome", pass: roomPass });
      if (m.sharing && !share) share = { sharerId: from, name: m.name, key: m.sharing }; // 방장 교체 후 복구
      conn.send({ t: "state", share });
      list();
    }

    hp.on("disconnected", () => { if (!hp.destroyed) hp.reconnect(); });
    hp.on("connection", conn => {
      conn.on("data", m => {
        const from = conn.peer;
        if (m.t === "hello") {
          if (from === me.id || m.pass === roomPass) admit(from, conn, m);
          else {
            waiting.set(from, conn);
            conn.send({ t: "wait" });
            askApproval(from, m.name, ok => {
              if (!waiting.has(from)) return;
              waiting.delete(from);
              if (ok) admit(from, conn, m);
              else { try { conn.send({ t: "denied" }); } catch {} setTimeout(() => conn.close(), 500); }
            });
          }
          return;
        }
        if (!ms.has(from)) return; // 승인 전에는 아무것도 못 함
        if (m.t === "share-req") {
          if (share && share.sharerId !== from) conn.send({ t: "busy", name: share.name });
          else { share = { sharerId: from, name: m.name, key: m.key }; all({ t: "share-start", ...share }); }
        } else if (m.t === "share-end") {
          if (share?.sharerId === from) { all({ t: "share-end", ...share }); share = null; }
        } else if (m.t === "to") {
          try { ms.get(m.to)?.conn.send({ ...m.msg, from }); } catch {}
        }
      });
      conn.on("close", () => {
        const from = conn.peer;
        if (waiting.get(from) === conn) { waiting.delete(from); cancelApproval(from); }
        if (ms.get(from)?.conn !== conn) return;
        ms.delete(from);
        all({ t: "left", id: from });
        if (share?.sharerId === from) { all({ t: "share-end", ...share }); share = null; }
        list();
      });
    });
  }

  /* ── 방 메시지 ── */
  function onMsg(m) {
    switch (m.t) {
      case "wait":
        setStatus("방장의 승인을 기다리는 중…"); break;
      case "welcome":
        pass = m.pass; admitted = true;
        setStatus(hubPeer ? "연결됨 · 방장" : "연결됨"); render(); break;
      case "denied":
        denied = true; hubConn = null;
        setStatus("입장 거절됨");
        $("empty").innerHTML = '<p class="big-text">입장이 거절되었습니다</p><p class="muted">방장에게 문의해 주세요. 이 창은 닫아도 됩니다.</p>';
        setTimeout(() => peer.destroy(), 300);
        break;
      case "members":
        members = m.list; renderMembers(); break;
      case "state":
        if (m.share && m.share.sharerId !== me.id && viewing?.key !== m.share.key) offerShare(m.share, true);
        break;
      case "share-start":
        if (m.sharerId === me.id) { render(); break; }
        offerShare(m, false); break;
      case "busy":
        info(`지금은 ${m.name} 님이 공유 중입니다. 끝난 뒤에 신청해 주세요.`);
        stopMyStream(); render(); break;
      case "share-end":
        dropToast(m.key);
        if (viewing?.key === m.key) { stopViewing(false); info(`${m.name} 님이 공유를 종료했습니다.`); }
        break;
      case "left":
        if (myStream) removeViewer(m.id);
        if (myKids.has(m.id)) { myKids.delete(m.id); closeOut(m.id); renderRelay(); }
        break;
      // 공유자가 받는 것
      case "accept": if (myStream && m.key === myShareKey) addViewer(m.from); break;
      case "unview": if (myStream) removeViewer(m.from); break;
      case "got": if (myStream && parentOf.has(m.from)) { ready.add(m.from); renderStats(); } break;
      // 중계자가 받는 것
      case "assign":
        if (viewing?.key === m.key) { myKids.add(m.viewerId); if (remoteStream) relayTo(m.viewerId); renderRelay(); }
        break;
      case "unassign":
        if (myKids.delete(m.viewerId)) { closeOut(m.viewerId); renderRelay(); }
        break;
    }
  }

  /* ── 공유하기 ── */
  $("share-btn").onclick = async () => {
    if (myStream) return;
    if (!hubConn || !admitted) { info("아직 방에 들어오지 않았습니다. 방장의 승인 후 다시 눌러 주세요."); return; }
    try {
      myStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    } catch {
      info("공유를 취소했습니다. 맥에서 처음이라면 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록에서 브라우저를 켜 주세요.");
      return;
    }
    if (viewing) stopViewing(true);
    const track = myStream.getVideoTracks()[0];
    track.contentHint = "detail"; // 글씨 선명도 우선
    track.onended = () => endShare();
    myShareKey = me.id + "-" + Date.now();
    send({ t: "share-req", name: me.name, key: myShareKey });
    render();
  };
  $("end-share").onclick = () => endShare();

  function endShare(silent) {
    if (!myStream) return;
    send({ t: "share-end" });
    stopMyStream();
    if (!silent) info("공유를 종료했습니다.");
    render();
  }
  function stopMyStream() {
    myStream?.getTracks().forEach(t => t.stop());
    myStream = null; myShareKey = null;
    outCalls.forEach(c => c.close()); outCalls.clear();
    parentOf.clear(); ready.clear();
  }

  const kidsOf = id => [...parentOf].filter(([, p]) => p === id).map(([c]) => c);

  function pickParent(v) {
    if (kidsOf(me.id).length < SHARER_FANOUT) return me.id;
    let level = kidsOf(me.id);
    while (level.length) {
      const cands = level.filter(n => n !== v && ready.has(n) && kidsOf(n).length < RELAY_FANOUT);
      if (cands.length) return cands.reduce((a, b) => (kidsOf(b).length < kidsOf(a).length ? b : a));
      level = level.flatMap(kidsOf);
    }
    return me.id; // 중계할 사람이 아직 없으면 일단 직접
  }

  function addViewer(v) {
    if (parentOf.has(v)) return;
    const p = pickParent(v);
    parentOf.set(v, p);
    if (p === me.id) callOut(v, myStream, myShareKey);
    else sendTo(p, { t: "assign", viewerId: v, key: myShareKey });
    renderStats();
  }

  function removeViewer(v) {
    if (!parentOf.has(v)) return;
    const p = parentOf.get(v);
    if (p === me.id) closeOut(v);
    else sendTo(p, { t: "unassign", viewerId: v });
    parentOf.delete(v); ready.delete(v);
    for (const o of kidsOf(v)) { parentOf.delete(o); addViewer(o); } // 그 아래 사람을 다시 배치
    renderStats();
  }

  /* ── 영상 보내기 (공유자·중계자 공통) ── */
  function callOut(v, stream, key) {
    closeOut(v);
    const c = peer.call(v, stream, { metadata: { key } });
    if (!c) return;
    outCalls.set(v, c);
    c.on("close", () => { if (outCalls.get(v) === c) outCalls.delete(v); });
    setTimeout(() => tuneSender(c), 1500);
  }
  function closeOut(v) { outCalls.get(v)?.close(); outCalls.delete(v); }
  function tuneSender(c) {
    try {
      c.peerConnection?.getSenders().forEach(s => {
        if (s.track?.kind !== "video") return;
        const p = s.getParameters();
        p.degradationPreference = "maintain-resolution";
        if (p.encodings?.[0]) p.encodings[0].maxBitrate = 1_500_000;
        s.setParameters(p).catch(() => {});
      });
    } catch {}
  }
  function relayTo(v) { callOut(v, remoteStream, viewing.key); }

  /* ── 입장 승인 (방장 화면) ── */
  function askApproval(id, who, decide) {
    const el = toast(`<b>${esc(who)} 님</b>이 입장을 요청합니다.`, [
      ["거절", () => { cancelApproval(id); decide(false); }],
      ["승인", () => { cancelApproval(id); decide(true); }, "primary"],
    ]);
    approvalToasts.set(id, el);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification("화면 공유기", { body: `${who} 님이 입장을 요청합니다.`, tag: "knock-" + id });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }
  function cancelApproval(id) { approvalToasts.get(id)?.remove(); approvalToasts.delete(id); }

  /* ── 보기 ── */
  function offerShare(s, late) {
    if (myStream || viewing?.key === s.key || pendingToasts.has(s.key)) return;
    const text = late ? `<b>${esc(s.name)} 님</b>이 화면을 공유하고 있습니다.` : `<b>${esc(s.name)} 님</b>이 화면 공유를 신청했습니다.`;
    const el = toast(text, [
      ["거절", () => dropToast(s.key)],
      ["수락", () => { dropToast(s.key); acceptShare(s); }, "primary"],
    ]);
    pendingToasts.set(s.key, el);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification("화면 공유기", { body: `${s.name} 님이 화면 공유를 신청했습니다.`, tag: s.key });
      n.onclick = () => { window.focus(); n.close(); };
    }
  }

  function acceptShare(s) {
    if (viewing) stopViewing(true);
    viewing = { sharerId: s.sharerId, name: s.name, key: s.key };
    sendTo(s.sharerId, { t: "accept", key: s.key });
    render();
  }

  function onIncomingCall(call) {
    if (!viewing || call.metadata?.key !== viewing.key) { call.close(); return; }
    if (inCall && inCall !== call) inCall.close();
    inCall = call;
    call.answer();
    let gotOnce = false;
    call.on("stream", s => {
      if (inCall !== call) return;
      remoteStream = s;
      $("remote").srcObject = s;
      $("viewer-wait").hidden = true;
      if (!gotOnce) { gotOnce = true; sendTo(viewing.sharerId, { t: "got" }); }
      myKids.forEach(relayTo); // 새 영상으로 내 아래 사람들도 다시 연결
    });
    call.on("close", () => {
      if (inCall !== call || !viewing) return;
      inCall = null; remoteStream = null;
      $("viewer-wait").hidden = false;
      $("viewer-wait").textContent = "연결이 바뀌는 중…";
      const key = viewing.key;
      setTimeout(() => { // 다른 중계자에게 다시 붙지 못하면 정리
        if (viewing?.key === key && !inCall) { stopViewing(true); info("공유 화면 연결이 끊겼습니다."); }
      }, 12000);
    });
  }

  $("close-view").onclick = () => stopViewing(true);

  function stopViewing(notify) {
    if (!viewing) return;
    if (notify) sendTo(viewing.sharerId, { t: "unview" });
    inCall?.close(); inCall = null; remoteStream = null;
    myKids.forEach(closeOut); myKids.clear();
    $("remote").srcObject = null;
    viewing = null;
    render();
  }

  /* ── 화면 그리기 ── */
  function render() {
    $("share-btn").disabled = !!myStream;
    $("share-btn").textContent = myStream ? "공유 중" : "공유 신청";
    $("sharing").hidden = !myStream;
    $("viewer").hidden = !viewing || !!myStream;
    $("empty").hidden = !!myStream || !!viewing;
    if (myStream) $("preview").srcObject = myStream;
    if (viewing) {
      $("viewer-who").textContent = viewing.name;
      if (!remoteStream) { $("viewer-wait").hidden = false; $("viewer-wait").textContent = "화면을 받아 오는 중…"; }
    }
    renderStats(); renderRelay();
  }
  function renderStats() {
    if (!myStream) return;
    const total = parentOf.size, direct = kidsOf(me.id).length;
    $("share-stats").textContent = total
      ? `보는 사람 ${total}명 · 직접 ${direct}명 · 중계 거쳐 ${total - direct}명`
      : "수락한 사람이 아직 없습니다.";
  }
  function renderRelay() {
    $("relay-info").hidden = !myKids.size;
    $("relay-info").textContent = `내가 ${myKids.size}명에게 중계 중`;
  }
  function renderMembers() {
    $("member-count").textContent = members.length;
    $("members").innerHTML = members
      .map(x => `<li class="${x.id === me.id ? "me" : ""}">${esc(x.name)}${x.id === me.id ? " (나)" : ""}</li>`).join("");
  }
  function setStatus(t) { $("status").textContent = t; }

  function toast(html, actions = []) {
    const el = document.createElement("div");
    el.className = "toast" + (actions.length ? "" : " info");
    el.innerHTML = `<div>${html}</div>`;
    if (actions.length) {
      const row = document.createElement("div"); row.className = "acts";
      for (const [label, fn, cls] of actions) {
        const b = document.createElement("button");
        b.className = "btn" + (cls ? " " + cls : ""); b.textContent = label; b.onclick = fn;
        row.append(b);
      }
      el.append(row);
    }
    $("toasts").append(el);
    return el;
  }
  function dropToast(key) { pendingToasts.get(key)?.remove(); pendingToasts.delete(key); }
  function info(text) { const el = toast(esc(text)); setTimeout(() => el.remove(), 4000); }

  render();
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
