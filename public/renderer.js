// ╔══════════════════════════════════════════════════════════╗
// ║  NexLink P2P Messenger — Renderer v2.0                  ║
// ╚══════════════════════════════════════════════════════════╝
'use strict';

/* ─── GLOBAL STATE ────────────────────────────────────────── */
let socket = null;
let myUserId = null;
let myHiddenId = null;
let myRadminIp = null;
let localIps = [];
let identityInfo = null;
let sessionToken = null;

let activePeer = null;
let peerConnections = {};
let dataChannels    = {};
let localStream     = null;
let remoteStream    = null;

let incomingCallData = null;
let callMode         = null;
let isMuted          = false;
let isCamOff         = false;

let chatTabs = new Map();
let onlinePeers = [];
let currentNavTab = 'peers';

const FILE_CHUNK = 32 * 1024;
let incomingFiles = {};

let userConfig = {
  username:             'User',
  avatarPath:           null,
  audioInputDeviceId:   null,
  audioOutputDeviceId:  null,
  noiseSuppression:     true,
  echoCancellation:     true,
  autoGainControl:      true,
  speechThreshold:      0.05,
  lastServer:           null,
  autoConnect:          true,
};

const RTC_CONFIG = {
  iceServers: [],
  iceTransportPolicy: 'all',
};

/* ─── DOM ─────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

const serverStatusTxt  = $('server-status-txt');
const tbStatus         = $('tb-status');
const sidebarContent   = $('sidebar-content');
const serverRailEl     = $('server-rail-list');
const welcomeScreen    = $('welcome-screen');
const chatView         = $('chat-view');
const chatAvatar       = $('chat-avatar');
const chatPeerName     = $('chat-peer-name');
const chatPeerSub      = $('chat-peer-sub');
const messagesEl       = $('messages');
const msgInput         = $('msg-input');
const sendBtn          = $('send-btn');
const videoOverlay     = $('video-overlay');
const localVideo       = $('local-video');
const remoteVideo      = $('remote-video');
const remoteLabel      = $('remote-label');
const callBanner       = $('call-banner');
const bannerFrom       = $('banner-from');
const myIpTxt          = $('my-ip-txt');
const hostIpsTxt       = $('host-ips-txt');
const myNameEl         = $('my-name-el');
const myStatusEl       = $('my-status-el');
const myAvatarEl       = $('my-avatar-el');
const myAvatarImg      = $('my-avatar-img');
const myAvatarInitials = $('my-avatar-initials');
const audioCallBtn     = $('audio-call-btn');
const videoCallBtn     = $('video-call-btn');
const serverIpInp      = $('server-ip-inp');
const serverPortInp    = $('server-port-inp');
const hostPortInp      = $('host-port-inp');
const usernameInp      = $('username-inp');
const hostStopBtn      = $('host-stop-btn');
const settingsModal    = $('settings-modal');
const audioInputSelect = $('audio-input-select');
const audioOutputSelect= $('audio-output-select');
const muteBtn          = $('mute-btn');
const camBtn           = $('cam-btn');
const fileInput        = $('file-input');
const remoteVideoWrap  = $('remote-video-wrap');
const localVideoWrap   = $('local-video-wrap');
const navMicBtn        = $('nav-mic-toggle');
const navHeadphonesBtn = $('nav-headphones-toggle');
const noiseSuppToggle  = $('noise-suppression-toggle');
const echoCancToggle   = $('echo-cancellation-toggle');
const autoGainToggle   = $('auto-gain-toggle');
const speechThreshRange= $('speech-threshold-range');

let localAudioCtx  = null, localAnalyser  = null, localAudioRaf  = null;
let remoteAudioCtx = null, remoteAnalyser = null, remoteAudioRaf = null;

let isHeadphonesMuted = false;
let outgoingRing = null;
let incomingRing = null;

let overlayDrag = { active: false, offsetX: 0, offsetY: 0 };

let discoveredServers = [];
let discoveryUnsub = null;
let autoConnectInFlight = false;
let serverBaseUrl = '';
let currentServerKey = null;

// ── Reconnect loop (keeps trying forever) ───────────────────
let reconnectTimer = null;
let reconnectAttempt = 0;
let connectInFlight = false;

// ── Chat receipts state ─────────────────────────────────────
// Track which incoming messageIds we've already reported as "read"
const readSentIds = new Set();

let callOverlayDetached = false;
let callOverlayUnsubOpened = null;
let callOverlayUnsubClosed = null;

// ── Overlay frame capture (for detached window) ────────────
let frameCapTimer = null;
const _overlayCanvas = document.createElement('canvas');
let _overlayCtx = null;

function startFrameCapture() {
  if (frameCapTimer) return;
  _overlayCtx = _overlayCanvas.getContext('2d');
  frameCapTimer = setInterval(() => {
    if (!callOverlayDetached || !window.electronAPI?.sendCallOverlayFrame) return;
    const vid = remoteVideo;
    const hasRemote = vid && vid.srcObject && vid.videoWidth > 0;
    const lVid = localVideo;
    const hasLocal = lVid && lVid.srcObject && lVid.videoWidth > 0;
    if (!hasRemote && !hasLocal) return;
    const w = hasRemote ? vid.videoWidth : lVid.videoWidth;
    const h = hasRemote ? vid.videoHeight : lVid.videoHeight;
    if (!w || !h) return;
    _overlayCanvas.width = w;
    _overlayCanvas.height = h;
    if (hasRemote) {
      _overlayCtx.drawImage(vid, 0, 0, w, h);
    } else {
      _overlayCtx.drawImage(lVid, 0, 0, w, h);
    }
    // PiP for local video when remote is shown
    if (hasRemote && hasLocal) {
      const pipW = Math.round(w * 0.26);
      const pipH = Math.round(h * 0.26);
      _overlayCtx.drawImage(lVid, w - pipW - 8, h - pipH - 8, pipW, pipH);
    }
    const dataUrl = _overlayCanvas.toDataURL('image/jpeg', 0.72);
    window.electronAPI.sendCallOverlayFrame(dataUrl);
  }, Math.round(1000 / 24));
}

function stopFrameCapture() {
  if (frameCapTimer) { clearInterval(frameCapTimer); frameCapTimer = null; }
  callOverlayDetached = false;
}

/* ─── UTILS ───────────────────────────────────────────────── */
function toast(msg, duration = 3000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

function timeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function initials(name) {
  const w = (name||'?').trim().split(/\s+/);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  return (name||'?').slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function genId() {
  return Math.random().toString(36).slice(2,10);
}

/** Returns human-readable display name for a peer object */
function peerDisplayName(peer) {
  if (!peer) return 'Пользователь';
  return peer.nickname || peer.name || 'Пользователь';
}

/** Looks up display name by userId or hiddenId */
function lookupName(userId) {
  if (!userId) return 'Пользователь';
  const found = onlinePeers.find(p => p.userId === userId || p.hiddenId === userId);
  if (found?.nickname) return found.nickname;
  const tab = chatTabs.get(userId);
  if (tab?.peer?.nickname) return tab.peer.nickname;
  return userConfig.username || 'Пользователь';
}

function normalizePeerKey(id) {
  if (!id) return null;
  const found = onlinePeers.find(p => p.hiddenId === id || p.userId === id);
  return found?.hiddenId || id;
}

/* ─── CONFIG PERSISTENCE ─────────────────────────────────── */
async function loadUserConfig() {
  try {
    const cfg = await window.electronAPI?.loadConfig?.();
    if (cfg && typeof cfg === 'object' && !cfg.__error) {
      userConfig = { ...userConfig, ...cfg };
    }
  } catch {}
}

async function saveUserConfig(patch) {
  userConfig = { ...userConfig, ...(patch || {}) };
  try { await window.electronAPI?.saveConfig?.(userConfig); } catch {}
}

/* ─── AVATAR ─────────────────────────────────────────────── */
function applyAvatar() {
  const name = userConfig.username || usernameInp?.value || 'User';
  if (myAvatarInitials) myAvatarInitials.textContent = initials(name);

  if (myAvatarEl) {
    if (userConfig.avatarPath) {
      myAvatarEl.classList.add('has-img');
      if (myAvatarImg) myAvatarImg.src = userConfig.avatarPath;
    } else {
      myAvatarEl.classList.remove('has-img');
      if (myAvatarImg) myAvatarImg.removeAttribute('src');
    }
  }

  const previewEl  = $('profile-avatar-preview');
  const previewImg = $('profile-avatar-img');
  const previewIni = $('profile-avatar-ini');
  if (previewIni) previewIni.textContent = initials(name);
  if (previewEl && previewImg) {
    if (userConfig.avatarPath) {
      previewEl.classList.add('has-img');
      previewImg.src = userConfig.avatarPath;
    } else {
      previewEl.classList.remove('has-img');
      previewImg.removeAttribute('src');
    }
  }
}

function applyConfigToUI() {
  if (userConfig.username) {
    if (usernameInp) usernameInp.value = userConfig.username;
    myNameEl.textContent = userConfig.username;
  }
  applyAvatar();
}

async function openAvatarPicker() {
  try {
    const filePath = await window.electronAPI?.pickAvatarFile?.();
    if (!filePath) return;
    const url = 'file:///' + String(filePath).replace(/\\/g, '/');
    let avatarDataUrl = null;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      avatarDataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
    } catch {}
    await saveUserConfig({ avatarPath: url, avatarDataUrl: avatarDataUrl || userConfig.avatarDataUrl || null });
    applyAvatar();
    toast('Аватар обновлён');
  } catch { toast('Не удалось загрузить аватар'); }
}

/* ─── PROFILE MODAL ──────────────────────────────────────── */
function openProfileModal() {
  applyAvatar();
  if (usernameInp) usernameInp.value = userConfig.username || 'User';
  $('profile-modal').classList.add('visible');
}
function closeProfileModal() {
  $('profile-modal').classList.remove('visible');
}
async function saveProfile() {
  const username = usernameInp.value.trim() || 'User';
  await saveUserConfig({ username });
  myNameEl.textContent = username;
  applyAvatar();
  closeProfileModal();
  toast('Профиль сохранён');
  if (socket && socket.connected) {
    socket.emit('register', {
      userId: myUserId,
      radminIp: myRadminIp,
      identityPublicKey: identityInfo?.publicKey || null,
      sessionToken,
      nickname: username,
      avatarUrl: userConfig.avatarDataUrl || null,
    });
  }
}

/* ─── CONNECT MODAL ──────────────────────────────────────── */
function openConnectModal() {
  $('connect-modal').classList.add('visible');
}
function closeConnectModal() {
  $('connect-modal').classList.remove('visible');
}

/* ─── IP DETECTION ───────────────────────────────────────── */
function isPrivateLanIp(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}
function pickBestLocalIp(ips) {
  return (
    ips.find(ip => ip.startsWith('26.')) ||
    ips.find(isPrivateLanIp) ||
    ips.find(ip => ip !== '127.0.0.1') ||
    '127.0.0.1'
  );
}
async function refreshLocalIps() {
  try { localIps = (await window.electronAPI?.getLocalIPs?.()) || ['127.0.0.1']; }
  catch { localIps = ['127.0.0.1']; }
  const unique = Array.from(new Set(localIps));
  if (hostIpsTxt) hostIpsTxt.textContent = unique.join(', ');
  const saved = localStorage.getItem('my-advertised-ip');
  myRadminIp = saved || pickBestLocalIp(unique);
  if (myIpTxt) myIpTxt.textContent = myRadminIp;
}

/* ─── NAV TABS ───────────────────────────────────────────── */
function setNavTab(tab) {
  currentNavTab = tab;
  renderServerTabs();
  renderSidebar();
}

function renderSidebar() {
  renderOnlinePeers();
}

function renderServerTabs() {
  if (!serverRailEl) return;
  serverRailEl.innerHTML = '';
  const servers = [];
  if (userConfig.lastServer?.ip && userConfig.lastServer?.port) {
    servers.push({
      key: `${userConfig.lastServer.ip}:${userConfig.lastServer.port}`,
      host: userConfig.lastServer.ip,
      port: userConfig.lastServer.port,
    });
  }
  if (!servers.length && currentServerKey) {
    const [host, port] = currentServerKey.split(':');
    servers.push({ key: currentServerKey, host, port });
  }
  servers.forEach(srv => {
    const el = document.createElement('button');
    el.className = 'rail-btn' + (srv.key === currentServerKey ? ' active' : '');
    el.innerHTML = `
      <i class="fas fa-server"></i>
      <span class="rail-tooltip">${escapeHtml(srv.host)}:${srv.port}</span>
    `;
    el.addEventListener('click', () => {
      if (serverIpInp) serverIpInp.value = srv.host;
      if (serverPortInp) serverPortInp.value = String(srv.port);
      connectToServer();
    });
    serverRailEl.appendChild(el);
  });
}

function renderChatTabs() {
  sidebarContent.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sec-label';
  label.textContent = 'Чаты';
  sidebarContent.appendChild(label);

  if (chatTabs.size === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);padding:8px 4px';
    empty.textContent = 'Нет активных чатов';
    sidebarContent.appendChild(empty);
    return;
  }

  chatTabs.forEach((tab, uid) => {
    const displayName = peerDisplayName(tab.peer);
    const el = document.createElement('div');
    el.className = 'chat-tab' + (activePeer?.userId === uid ? ' active' : '');
    el.dataset.uid = uid;

    const resolvedAvatar = resolveAvatarUrl(tab.peer.avatarUrl);
    const avatarHtml = resolvedAvatar
      ? `<img src="${escapeHtml(resolvedAvatar)}" alt="${escapeHtml(displayName)}" />`
      : initials(displayName);

    const rtcState = peerConnections[uid]?.connectionState || 'new';
    const stateColor = { connected:'var(--green)', connecting:'var(--yellow)', failed:'var(--red)', disconnected:'var(--red)', new:'var(--text-tertiary)', closed:'var(--text-tertiary)' };

    el.innerHTML = `
      <div class="tab-avatar">${avatarHtml}<div class="tab-online-dot" style="background:${stateColor[rtcState]||'var(--text-tertiary)'}"></div></div>
      <div class="tab-info">
        <div class="tab-name">${escapeHtml(displayName)}</div>
        <div class="tab-sub">${escapeHtml(tab.peer.radminIp)} · ${rtcState}</div>
      </div>
      <div class="peer-actions-row">
        <button class="small-icon-btn" title="Голос" onclick="event.stopPropagation();quickCall('${escapeHtml(uid)}','audio')"><i class="fas fa-microphone"></i></button>
        <button class="small-icon-btn" title="Видео" onclick="event.stopPropagation();quickCall('${escapeHtml(uid)}','video')"><i class="fas fa-video"></i></button>
      </div>
      <button class="tab-close" title="Закрыть" onclick="event.stopPropagation();closeTab('${escapeHtml(uid)}')"><i class="fas fa-xmark"></i></button>
    `;
    el.addEventListener('click', () => openTab(uid));
    sidebarContent.appendChild(el);
  });
}

function renderOnlinePeers() {
  sidebarContent.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sec-label';
  label.textContent = 'Онлайн';
  sidebarContent.appendChild(label);

  const peers = onlinePeers.filter(p => p.userId !== myUserId);
  if (!peers.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);padding:10px 12px;line-height:1.4';
    empty.innerHTML = socket?.connected
      ? 'Пока никого нет. Все, кто подключён к этому серверу, появятся здесь.'
      : 'Подключитесь к серверу — здесь появятся все, кто на том же порту.';
    sidebarContent.appendChild(empty);
    return;
  }

  peers.forEach(peer => {
    const displayName = peerDisplayName(peer);
    const el = document.createElement('div');
    const isActive = activePeer && (activePeer.hiddenId === (peer.hiddenId || peer.userId));
    el.className = 'chat-tab' + (isActive ? ' active' : '');

    // Show avatar image if available, otherwise initials
    const resolvedAvatar = resolveAvatarUrl(peer.avatarUrl);
    const avatarHtml = resolvedAvatar
      ? `<img src="${escapeHtml(resolvedAvatar)}" alt="${escapeHtml(displayName)}" />`
      : initials(displayName);

    el.innerHTML = `
      <div class="tab-avatar">${avatarHtml}<div class="tab-online-dot"></div></div>
      <div class="tab-info">
        <div class="tab-name">${escapeHtml(displayName)}</div>
        <div class="tab-sub">${escapeHtml(peer.radminIp)}</div>
      </div>
      <div class="peer-actions-row">
        <button class="small-icon-btn" title="Написать" onclick="event.stopPropagation();selectPeer(${JSON.stringify(peer).replace(/"/g,"'")})"><i class="fas fa-message"></i></button>
      </div>
    `;
    el.addEventListener('click', () => selectPeer(peer));
    sidebarContent.appendChild(el);
  });
}

function openTab(userId) {
  const tab = chatTabs.get(userId);
  if (!tab) return;
  selectPeer(tab.peer);
}

function closeTab(userId) {
  chatTabs.delete(userId);
  if (activePeer && (activePeer.hiddenId === userId || activePeer.userId === userId)) {
    activePeer = null;
    welcomeScreen.classList.remove('hidden');
    chatView.classList.add('hidden');
  }
  const pc = peerConnections[userId];
  if (pc) { pc.close(); delete peerConnections[userId]; }
  delete dataChannels[userId];
  persistChatTabs();
  renderSidebar();
}

function quickCall(userId, mode) {
  const tab = chatTabs.get(userId);
  if (tab) selectPeer(tab.peer);
  startCall(mode);
}

/* ─── SPEAKING DETECTION ─────────────────────────────────── */
function stopSpeakingDetection() {
  if (localAudioRaf) cancelAnimationFrame(localAudioRaf);
  if (remoteAudioRaf) cancelAnimationFrame(remoteAudioRaf);
  localAudioRaf = remoteAudioRaf = null;
  try { localAudioCtx?.close(); } catch {}
  try { remoteAudioCtx?.close(); } catch {}
  localAudioCtx = localAnalyser = remoteAudioCtx = remoteAnalyser = null;
  [myAvatarEl, chatAvatar, localVideoWrap, remoteVideoWrap]
    .forEach(el => el?.classList.remove('speaking'));
}

function createRingAudio() {
  try {
    const a = new Audio('musics/playing.mp3');
    a.loop = true; a.volume = 0.7;
    return a;
  } catch { return null; }
}

function startOutgoingRing() {
  if (outgoingRing) return;
  const a = createRingAudio();
  if (!a) return;
  outgoingRing = a;
  outgoingRing.play().catch(() => {});
}
function stopOutgoingRing() {
  if (!outgoingRing) return;
  try { outgoingRing.pause(); outgoingRing.currentTime = 0; } catch {}
  outgoingRing = null;
}
function startIncomingRing() {
  if (incomingRing) return;
  const a = createRingAudio();
  if (!a) return;
  incomingRing = a;
  incomingRing.play().catch(() => {});
}
function stopIncomingRing() {
  if (!incomingRing) return;
  try { incomingRing.pause(); incomingRing.currentTime = 0; } catch {}
  incomingRing = null;
}

function startSpeakingDetection(stream, isLocal) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !stream) return;
  try {
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const threshold = typeof userConfig.speechThreshold === 'number' ? userConfig.speechThreshold : 0.05;
    const releaseMs = 350;
    let speaking = false, lastAbove = 0;
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v=(data[i]-128)/128; sum+=v*v; }
      const level = Math.sqrt(sum/data.length);
      const now = performance.now();
      if (level > threshold) { speaking = true; lastAbove = now; }
      else if (speaking && (now - lastAbove) > releaseMs) { speaking = false; }
      if (isLocal) {
        myAvatarEl?.classList.toggle('speaking', speaking);
        localVideoWrap?.classList.toggle('speaking', speaking);
        localAudioRaf = requestAnimationFrame(loop);
      } else {
        chatAvatar?.classList.toggle('speaking', speaking);
        remoteVideoWrap?.classList.toggle('speaking', speaking);
        remoteAudioRaf = requestAnimationFrame(loop);
      }
    };
    if (isLocal) { if (localAudioCtx) localAudioCtx.close(); localAudioCtx=ctx; localAnalyser=analyser; localAudioRaf=requestAnimationFrame(loop); }
    else          { if (remoteAudioCtx) remoteAudioCtx.close(); remoteAudioCtx=ctx; remoteAnalyser=analyser; remoteAudioRaf=requestAnimationFrame(loop); }
  } catch {}
}

function connectToFoundServer(srv) {
  if (!srv?.ip || !srv?.port) return;
  if (serverIpInp) serverIpInp.value = srv.ip;
  if (serverPortInp) serverPortInp.value = String(srv.port);
  syncFooterPort();
  connectToServer();
}

function syncFooterPort() {
  const port = serverPortInp?.value || hostPortInp?.value || '7345';
  const footerPort = $('footer-port-inp');
  if (footerPort && footerPort.value !== port) footerPort.value = port;
}

function quickReconnectByPort() {
  const footerPort = $('footer-port-inp');
  const port = footerPort ? Number(footerPort.value) || 7345 : 7345;
  if (serverPortInp) serverPortInp.value = String(port);
  if (hostPortInp) hostPortInp.value = String(port);
  const ip = userConfig.lastServer?.ip || '127.0.0.1';
  if (serverIpInp) serverIpInp.value = ip;
  connectToServer();
}

function clearReconnectLoop() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
}

function scheduleReconnectLoop(reason) {
  if (userConfig.autoConnect === false) return;
  if (socket?.connected) return;
  if (connectInFlight) return;
  if (reconnectTimer) return;
  try { window.electronAPI?.scanDiscovery?.(); } catch {}
  serverStatusTxt.textContent = 'переподключение...';
  // If socket.io instance exists, let it handle reconnection
  if (socket && typeof socket.connect === 'function') {
    try { socket.connect(); } catch {}
    return;
  }
  // Exponential backoff up to 15s
  const delay = Math.min(15000, Math.round(1000 * Math.pow(1.6, reconnectAttempt)));
  reconnectAttempt++;
  serverStatusTxt.textContent = `переподключение через ${Math.ceil(delay / 1000)}с...`;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToServer().catch(() => {});
  }, delay);
}

async function ensureLocalServerAndConnect() {
  if (autoConnectInFlight) return;
  autoConnectInFlight = true;
  try {
    const footerPort = $('footer-port-inp');
    const portStr = footerPort?.value || hostPortInp?.value || serverPortInp?.value || '7345';
    const desired = Number(String(portStr).trim()) || 7345;
    const res = await window.electronAPI?.startSignalingServer?.(desired);
    if (!res?.ok) { toast(`✗ Сервер не запустился: ${res?.error||'ошибка'}`); return; }
    if (hostStopBtn) hostStopBtn.disabled = false;
    if (serverIpInp)  serverIpInp.value  = '127.0.0.1';
    if (serverPortInp) serverPortInp.value = String(res.port);
    if (hostPortInp) hostPortInp.value = String(res.port);
    const fp = $('footer-port-inp');
    if (fp) fp.value = String(res.port);
    toast(`✓ Сервер создан на порту :${res.port}`);
    connectToServer();
  } finally { autoConnectInFlight = false; }
}

/* ─── CONNECT TO SERVER ──────────────────────────────────── */
async function connectToServer() {
  const username  = (usernameInp?.value || userConfig.username || 'User').trim();
  const serverIp  = serverIpInp?.value.trim()   || '127.0.0.1';
  const port      = Number(serverPortInp?.value.trim() || 7345) || 7345;
  const serverUrl = `http://${serverIp}:${port}`;

  if (connectInFlight) return;
  connectInFlight = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  currentServerKey = `${serverIp}:${port}`;
  const hidKey = `nexlink-hidden-id-${currentServerKey}`;
  let storedHiddenId = null;
  try { storedHiddenId = localStorage.getItem(hidKey); } catch {}
  if (!storedHiddenId || typeof storedHiddenId !== 'string' || storedHiddenId.length < 8) {
    const buf = new Uint8Array(8);
    window.crypto.getRandomValues(buf);
    storedHiddenId = Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
    try { localStorage.setItem(hidKey, storedHiddenId); } catch {}
  }
  myHiddenId = storedHiddenId;

  if (!identityInfo) {
    try { identityInfo = await window.electronAPI?.getIdentity?.(); } catch {}
  }
  if (!sessionToken) {
    const buf = new Uint8Array(16);
    window.crypto.getRandomValues(buf);
    sessionToken = Array.from(buf).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  if (socket) { socket.disconnect(); socket = null; }

  if (identityInfo?.userId) myUserId = identityInfo.userId;
  else if (!myUserId) myUserId = 'u_' + genId();

  await saveUserConfig({ username, lastServer: { ip: serverIp, port }, autoConnect: true });
  localStorage.setItem('my-advertised-ip', myRadminIp);

  const connectBtn = $('connect-btn');
  if (connectBtn) connectBtn.disabled = true;
  serverStatusTxt.textContent = 'подключение...';
  tbStatus.classList.remove('connected');

  loadScript(`http://${serverIp}:${port}/socket.io/socket.io.js`, (err) => {
    if (err) {
      connectInFlight = false;
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      scheduleReconnectLoop('script_load_failed');
      return;
    }
    if (typeof io !== 'function') {
      serverStatusTxt.textContent = 'socket.io не загружен';
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      toast('✗ Не удалось подключиться: socket.io не загружен с сервера');
      connectInFlight = false;
      scheduleReconnectLoop('io_missing');
      return;
    }
    socket = io(serverUrl, {
      transports: ['websocket'],
      timeout: 6000,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.35,
    });
    serverBaseUrl = serverUrl;

    socket.on('connect', () => {
      connectInFlight = false;
      clearReconnectLoop();
      serverStatusTxt.textContent = `${serverIp}:${port}`;
      tbStatus.classList.add('connected');
      if (connectBtn) connectBtn.disabled = false;
      syncFooterPort();

      const inCall = videoOverlay?.classList?.contains?.('visible') || false;
      socket.emit('register', {
        userId: myUserId,
        hiddenId: myHiddenId,
        radminIp: myRadminIp,
        identityPublicKey: identityInfo?.publicKey || null,
        sessionToken,
        nickname: username,
        avatarUrl: userConfig.avatarDataUrl || null,
        inCall,
      });

      myNameEl.textContent  = username;
      myStatusEl.textContent = '● online';
      myStatusEl.className   = 'my-av-status online';
      applyAvatar();
      closeConnectModal();
      toast(`✓ Подключён как ${username}`);
      renderServerTabs();
    });

    socket.on('connect_error', () => {
      serverStatusTxt.textContent = 'ошибка';
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      toast('✗ Не удалось подключиться к серверу');
      connectInFlight = false;
      scheduleReconnectLoop('connect_error');
    });

    socket.on('disconnect', () => {
      serverStatusTxt.textContent = 'отключён';
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      myStatusEl.textContent = '● offline';
      myStatusEl.className   = 'my-av-status';
      onlinePeers = [];
      activePeer = null;
      chatView.classList.add('hidden');
      welcomeScreen.classList.remove('hidden');
      // Close all RTC connections
      Object.values(peerConnections).forEach(pc => { try { pc.close(); } catch {} });
      peerConnections = {};
      dataChannels = {};
      renderServerTabs();
      renderSidebar();
      connectInFlight = false;
      scheduleReconnectLoop('disconnect');
    });

    socket.on('peers-update', (peers) => {
      onlinePeers = (peers || []).map(p => ({
        ...p,
        hiddenId: p.hiddenId || p.userId,
      }));
      onlinePeers.forEach(p => {
        const key = p.hiddenId || p.userId;
        const tab = chatTabs.get(key);
        if (tab) {
          tab.peer.nickname = p.nickname || tab.peer.nickname;
          tab.peer.radminIp = p.radminIp || tab.peer.radminIp;
          tab.peer.avatarUrl = p.avatarUrl || tab.peer.avatarUrl;
          tab.peer.inCall = p.inCall;
        }
      });
      updateJoinCallBanner();
      if (currentNavTab === 'peers') renderSidebar();
    });

    socket.on('peer-offline', (peer) => {
      const name = lookupName(peer.userId);
      if (activePeer?.userId === peer.userId) addSystemMsg(`${name} отключился`);
    });

    socket.on('offer', async ({ offer, from }) => {
      const pc = peerConnections[from?.userId];
      const inCallWithPeer = activePeer?.userId === from?.userId && videoOverlay?.classList?.contains?.('visible');
      if (inCallWithPeer && pc && pc.signalingState !== 'closed') {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          // Применяем отложенные ICE-кандидаты
          const pend = pendingIce[from.userId] || [];
          for (const c of pend) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.error(e); }
          }
          pendingIce[from.userId] = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('answer', { to: from.userId, answer: pc.localDescription });
          callMode = offer.sdp?.includes('m=video') ? 'video' : 'audio';
        } catch (e) { console.error('renegotiation error', e); }
        return;
      }
      incomingCallData = { offer, from };
      callMode = (offer.sdp?.includes('m=video')) ? 'video' : 'audio';
      const displayName = peerDisplayName(from);
      bannerFrom.textContent = `от ${displayName} (${from.radminIp})`;
      callBanner.classList.add('visible');
      window.electronAPI?.notifyCall?.({ from });
      startIncomingRing();
    });

    socket.on('answer', async ({ answer }) => {
      const pc = peerConnections[activePeer?.userId];
      if (pc) { try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch(e){console.error(e);} }
      stopOutgoingRing();
    });

    const pendingIce = {};

    socket.on('ice-candidate', async ({ candidate, from }) => {
      const uid = from || activePeer?.userId;
      const pc = peerConnections[uid];
      if (!candidate || !uid) return;
      if (!pc || !pc.remoteDescription) {
        // Очередь кандидатов до установки remoteDescription
        (pendingIce[uid] ||= []).push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error(e);
      }
    });

    socket.on('call-end', ({ from }) => {
      const name = from?.nickname || lookupName(from?.userId) || 'Собеседник';
      addSystemMsg(`${name} завершил звонок`);
      cleanupCall();
    });

    socket.on('chat-new', (msg) => {
      if (msg.roomType !== 'dm') return;
      const senderHidden = normalizePeerKey(msg.senderHiddenId || msg.sender);
      const peerHidden = normalizePeerKey(msg.peerHiddenId || msg.to || null);
      if (!senderHidden) return;
      let uid;
      if (senderHidden === myHiddenId) { uid = peerHidden; }
      else { uid = senderHidden; }
      if (!uid) return;
      const legacy = window.NexLinkCrypto?.decodeLegacyPayload?.(msg.ciphertext, msg.iv);
      const text = legacy?.text;
      const id = legacy?.id || msg.id;
      if (!text) return;
      storeAndShowMessage(uid, { id, text, sender: senderHidden, time: msg.time, me: senderHidden === myHiddenId });

      // Delivery confirmation: if server echoed our message, mark as delivered
      if (senderHidden === myHiddenId && id) {
        setMessageStatus(uid, id, 'delivered');
      }

      // Read receipt: if we're currently viewing this chat, mark incoming as read
      if (senderHidden !== myHiddenId && activePeerKey() === uid) {
        sendReadReceiptsForActiveChat();
      }

      // Windows toast notification for incoming messages (when not focused)
      try {
        if (senderHidden !== myHiddenId && window.electronAPI?.notifyMessage) {
          const title = lookupName(senderHidden);
          window.electronAPI.notifyMessage({ title, body: text });
        }
      } catch {}
    });

    socket.on('chat-read', ({ roomType, peerHiddenId, messageIds } = {}) => {
      if (roomType && roomType !== 'dm') return;
      const uid = normalizePeerKey(peerHiddenId);
      if (!uid || !Array.isArray(messageIds)) return;
      for (const mid of messageIds) setMessageStatus(uid, mid, 'read');
    });
  });
}

function resolveAvatarUrl(url) {
  if (!url) return url;
  if (url.startsWith('data:')) return url;
  return url.startsWith('/') ? (serverBaseUrl + url) : url;
}

function loadScript(src, cb) {
  if (document.querySelector(`script[src="${src}"]`)) { cb?.(null); return; }
  const s = document.createElement('script');
  s.src = src;
  s.onload = () => cb?.(null);
  s.onerror = () => {
    toast('✗ Не удалось загрузить socket.io с сервера');
    cb?.(new Error('socket.io script load failed'));
  };
  document.head.appendChild(s);
}

/* ─── LOCAL SERVER ───────────────────────────────────────── */
async function startLocalHost() {
  const port = Number((hostPortInp?.value || serverPortInp?.value || '7345').trim()) || 7345;
  const res  = await window.electronAPI?.startSignalingServer?.(port);
  if (!res?.ok) { toast(`✗ Сервер не запустился: ${res?.error||'ошибка'}`); return; }
  if (hostStopBtn) hostStopBtn.disabled = false;
  if (serverIpInp)  serverIpInp.value  = '127.0.0.1';
  if (serverPortInp) serverPortInp.value = String(res.port);
  toast(`✓ Чат создан на порту :${res.port}`);
  connectToServer();
}

async function stopLocalHost() {
  const res = await window.electronAPI?.stopSignalingServer?.();
  if (!res?.ok) { toast(`✗ ${res?.error||'ошибка'}`); return; }
  if (hostStopBtn) hostStopBtn.disabled = true;
  if (socket) { socket.disconnect(); socket = null; }
  serverStatusTxt.textContent = 'не подключён';
  tbStatus.classList.remove('connected');
  toast('Сервер остановлен');
}

/* ─── RTC CONNECTION ─────────────────────────────────────── */
function createPeerConnection(peer) {
  const uid = peer.userId;
  if (peerConnections[uid] && peerConnections[uid].connectionState !== 'closed') {
    return peerConnections[uid];
  }
  if (peerConnections[uid]) { try { peerConnections[uid].close(); } catch {} }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[uid] = pc;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate && socket) socket.emit('ice-candidate', { to: uid, candidate });
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (activePeer?.userId === uid) {
      chatPeerSub.textContent = `${peer.radminIp} · ${state}`;
    }
    if (state === 'connected') {
      const tab = chatTabs.get(uid);
      if (tab) tab.connected = true;
      if (activePeer?.userId === uid) {
        msgInput.disabled = !socket?.connected;
        sendBtn.disabled  = !socket?.connected;
      }
    }
    if (state === 'failed' || state === 'disconnected') {
      if (activePeer?.userId === uid) {
        msgInput.disabled = !socket?.connected;
        sendBtn.disabled  = !socket?.connected;
      }
    }
    renderSidebar();
  };

  pc.ontrack = ({ streams }) => {
    remoteStream = streams[0];
    remoteVideo.srcObject = remoteStream;
    videoOverlay.classList.add('visible');
    startSpeakingDetection(remoteStream, false);
  };

  pc.ondatachannel = ({ channel }) => {
    dataChannels[uid] = channel;
    setupDataChannel(channel, uid);
  };

  return pc;
}

function setupDataChannel(ch, uid) {
  ch.onopen = () => {
    if (activePeer?.userId === uid) {
      msgInput.disabled = !socket?.connected;
      sendBtn.disabled  = !socket?.connected;
      const key = activePeer.hiddenId || activePeer.userId;
      fetchChatHistoryFromServer(key);
    }
    renderSidebar();
  };
  ch.onclose = () => {
    if (activePeer?.userId === uid) {
      msgInput.disabled = true;
      sendBtn.disabled  = true;
    }
    renderSidebar();
  };
  ch.onmessage = ({ data }) => handleDataChannelMessage(data, uid);
}

function handleDataChannelMessage(data, uid) {
  try {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'chat':
        storeAndShowMessage(uid, { id: msg.id, text: msg.text, sender: msg.sender, time: msg.time || timeStr(), me: false });
        break;
      case 'file-start':
        incomingFiles[msg.transferId] = {
          name: msg.name, mime: msg.mime,
          size: msg.size, totalChunks: msg.totalChunks,
          chunks: [], received: 0,
          sender: msg.sender, uid,
          progressMsgId: 'fp_' + msg.transferId,
        };
        if (activePeer?.userId === uid) addFileProgressMsg(msg, uid);
        break;
      case 'file-chunk': {
        const ft = incomingFiles[msg.transferId];
        if (!ft) break;
        ft.chunks[msg.index] = msg.data;
        ft.received++;
        updateFileProgress(msg.transferId, ft.received, ft.totalChunks);
        if (ft.received === ft.totalChunks) finalizeFile(msg.transferId, ft);
        break;
      }
    }
  } catch(e) { console.error('DC msg error', e); }
}

/* ─── MESSAGE STORAGE & DISPLAY ─────────────────────────── */
function activePeerKey() {
  return activePeer ? (activePeer.hiddenId || activePeer.userId) : null;
}

function normalizeMsgStatus(status) {
  if (status === 'pending' || status === 'delivered' || status === 'read') return status;
  return null;
}

function statusGlyph(status) {
  switch (status) {
    case 'pending':   return '○';
    case 'delivered': return '✓';
    case 'read':      return '✓✓';
    default:          return '';
  }
}

function setMessageStatus(uid, msgId, status) {
  const st = normalizeMsgStatus(status);
  if (!uid || !msgId || !st) return;
  const tab = chatTabs.get(uid);
  if (!tab?.messages?.length) return;
  const m = tab.messages.find(x => x?.id === msgId && x?.me);
  if (!m) return;
  const cur = normalizeMsgStatus(m.status);
  const rank = { pending: 0, delivered: 1, read: 2 };
  if (cur && rank[cur] >= rank[st]) return;
  m.status = st;
  persistChatTabs();
  if (activePeerKey() === uid) {
    const el = messagesEl?.querySelector?.(`.msg[data-msg-id="${CSS.escape(String(msgId))}"] .msg-status`);
    if (el) el.textContent = statusGlyph(st);
  }
}

function sendReadReceiptsForActiveChat() {
  const uid = activePeerKey();
  if (!uid || !socket?.connected) return;
  const tab = chatTabs.get(uid);
  if (!tab?.messages?.length) return;
  const ids = [];
  for (const m of tab.messages) {
    if (!m || m.me) continue;
    if (!m.id) continue;
    const key = `${uid}:${m.id}`;
    if (readSentIds.has(key)) continue;
    readSentIds.add(key);
    ids.push(m.id);
  }
  if (!ids.length) return;
  socket.emit('chat-read', { peerHiddenId: uid, messageIds: ids });
}
function storeAndShowMessage(uid, msgObj) {
  let tab = chatTabs.get(uid);
  if (!tab) {
    const peer = onlinePeers.find(p => (p.hiddenId || p.userId) === uid) || { userId: uid, hiddenId: uid, radminIp: 'unknown' };
    tab = { peer, messages:[], connected:false };
    chatTabs.set(uid, tab);
  }
  if (msgObj.id && tab.messages.some(m => m.id === msgObj.id)) return;
  // Default status for outgoing messages loaded from server/history
  if (msgObj.me && !msgObj.status) msgObj.status = 'delivered';
  tab.messages.push(msgObj);
  persistChatTabs();
  if (activePeerKey() === uid) appendMessageEl(msgObj.text, msgObj.me, msgObj.sender, msgObj.time, msgObj.id, msgObj.status);
  renderSidebar();
}

function fetchChatHistoryFromServer(uid) {
  if (!socket?.connected) return;
  socket.emit('chat-history', { roomType: 'dm', with: uid }, (serverMessages) => {
    if (!Array.isArray(serverMessages)) return;
    let tab = chatTabs.get(uid);
    if (!tab) {
      const peer = onlinePeers.find(p=> (p.hiddenId || p.userId)===uid) || { userId:uid, hiddenId:uid, radminIp:'unknown' };
      tab = { peer, messages:[], connected:false };
      chatTabs.set(uid, tab);
    }
    const ids = new Set(tab.messages.map(m => m.id).filter(Boolean));
    serverMessages.forEach(m => {
      if (m.id && ids.has(m.id)) return;
      let text = m.text;
      if (!text && m.ciphertext && window.NexLinkCrypto?.decodeLegacyPayload) {
        const legacy = window.NexLinkCrypto.decodeLegacyPayload(m.ciphertext, m.iv);
        if (legacy) text = legacy.text;
      }
      if (!text) return;
      if (m.id) ids.add(m.id);
      const me = (m.sender === myHiddenId);
      tab.messages.push({ id: m.id, text, sender: m.sender, time: m.time, me, status: me ? 'delivered' : undefined });
    });
    tab.messages.sort((a, b) => {
      const ta = (a && a.time) ? String(a.time) : '';
      const tb = (b && b.time) ? String(b.time) : '';
      return ta.localeCompare(tb);
    });
    persistChatTabs();
    if (activePeerKey() === uid) renderMessages(uid);
    renderSidebar();
  });
}

const CHAT_STORAGE_KEY = 'nexlink-chat-tabs-v1';

function persistChatTabs() {
  try {
    const arr = Array.from(chatTabs.entries()).map(([uid, tab]) => ({
      peerHiddenId: uid,
      peer: {
        userId: tab.peer.userId,
        hiddenId: tab.peer.hiddenId || uid,
        radminIp: tab.peer.radminIp,
        nickname: tab.peer.nickname || null,
        avatarUrl: tab.peer.avatarUrl || null,
      },
      messages: tab.messages || [],
    }));
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(arr));
  } catch {}
}

function loadChatTabsFromStorage() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    arr.forEach(entry => {
      const key = entry.peerHiddenId || entry.userId;
      if (!entry || !key || !entry.peer) return;
      chatTabs.set(key, {
        peer: {
          userId: entry.peer.userId,
          hiddenId: entry.peer.hiddenId || key,
          radminIp: entry.peer.radminIp || 'unknown',
          nickname: entry.peer.nickname || null,
          avatarUrl: entry.peer.avatarUrl || null,
        },
        messages: Array.isArray(entry.messages) ? entry.messages : [],
        connected: false,
      });
    });
  } catch {}
}

/* ─── SELECT PEER / OPEN CHAT ────────────────────────────── */
function selectPeer(peer) {
  const key = peer.hiddenId || peer.userId;
  activePeer = { ...peer, hiddenId: key };

  if (!chatTabs.has(key)) {
    chatTabs.set(key, { peer: activePeer, messages:[], connected:false });
  }

  welcomeScreen.classList.add('hidden');
  chatView.classList.remove('hidden');

  const resolvedAvatar = resolveAvatarUrl(peer.avatarUrl);
  chatAvatar.innerHTML = resolvedAvatar
    ? `<img src="${escapeHtml(resolvedAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : initials(peerDisplayName(peer));
  chatPeerName.textContent = peerDisplayName(peer);
  chatPeerSub.textContent  = peer.radminIp + ' · WebRTC';
  if (remoteLabel) remoteLabel.textContent = peerDisplayName(peer);

  messagesEl.innerHTML = '';
  const tab = chatTabs.get(key);
  (tab?.messages || []).forEach(m => {
    if (m.fileMsg) appendFileMessageEl(m.fileMsg, m.me);
    else appendMessageEl(m.text, m.me, m.sender, m.time, m.id, m.status);
  });

  msgInput.disabled = !socket?.connected;
  sendBtn.disabled  = !socket?.connected;

  if (!peerConnections[peer.userId] || peerConnections[peer.userId].connectionState === 'closed') {
    initDataChannel(peer);
  }

  fetchChatHistoryFromServer(key);
  // If we opened a DM with someone, mark incoming messages as "read"
  sendReadReceiptsForActiveChat();
  updateJoinCallBanner();
  renderSidebar();
}

function updateJoinCallBanner() {
  const banner = $('join-call-banner');
  if (!banner) return;
  const peer = onlinePeers.find(p => (p.hiddenId || p.userId) === activePeer?.hiddenId);
  const peerInCall = peer?.inCall === true;
  const weInCall = videoOverlay?.classList?.contains?.('visible');
  banner.classList.toggle('hidden', !activePeer || !peerInCall || weInCall);
}

function joinPeerCall() {
  if (!activePeer) return;
  startCall('video');
}

/* ─── INIT DATA CHANNEL ──────────────────────────────────── */
async function initDataChannel(peer) {
  if (!socket) { toast('Сначала подключитесь к серверу'); return; }
  const pc = createPeerConnection(peer);

  const dc = pc.createDataChannel('chat', { ordered: true });
  dataChannels[peer.userId] = dc;
  setupDataChannel(dc, peer.userId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: peer.userId, offer: pc.localDescription, from: myUserId });
  addSystemMsg(`Устанавливаем соединение с ${peerDisplayName(peer)}...`);
}

/* ─── CALL ───────────────────────────────────────────────── */
async function startCall(mode) {
  if (!activePeer) { toast('Выберите собеседника'); return; }
  if (!socket) { toast('Нет подключения к серверу'); return; }
  callMode = mode;

  const audioDeviceId = userConfig.audioInputDeviceId;
  const audioConstraintsBase = {
    noiseSuppression: !!userConfig.noiseSuppression,
    echoCancellation: !!userConfig.echoCancellation,
    autoGainControl: !!userConfig.autoGainControl,
  };

  try {
    if (mode === 'screen') {
      let displayStream = null;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      } catch (err) {
        if (window.electronAPI?.getDesktopSources) {
          const sources = await window.electronAPI.getDesktopSources({ types: ['screen', 'window'] });
          const source = sources.find(s => s.id) || sources[0];
          if (source?.id) {
            displayStream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
            });
          }
        }
        if (!displayStream) throw err;
      }
      let audioStream = null;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({
          audio: audioDeviceId ? { deviceId:{ exact:audioDeviceId }, ...audioConstraintsBase } : audioConstraintsBase,
          video: false,
        });
      } catch {}
      localStream = audioStream
        ? new MediaStream([...displayStream.getVideoTracks(), ...audioStream.getAudioTracks()])
        : displayStream;
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, ...audioConstraintsBase } : audioConstraintsBase,
        video: mode === 'video' ? { width:1280, height:720 } : false,
      });
    }
  } catch (err) {
    const msg = err?.name === 'NotAllowedError'
      ? 'Доступ запрещён. Разрешите захват в настройках системы.'
      : (err?.message || 'Нет доступа к камере/микрофону/экрану');
    toast('✗ ' + msg);
    return;
  }

  localVideo.srcObject = localStream;
  videoOverlay.classList.add('visible');
  if (isMuted) applyMicMuteStateToStreams();
  startSpeakingDetection(localStream, true);
  socket?.emit?.('call-state', { inCall: true });

  const pc = createPeerConnection(activePeer);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const existingDc = dataChannels[activePeer.userId];
  if (!existingDc || existingDc.readyState === 'closed') {
    const dc = pc.createDataChannel('chat', { ordered: true });
    dataChannels[activePeer.userId] = dc;
    setupDataChannel(dc, activePeer.userId);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: activePeer.userId, offer: pc.localDescription, from: myUserId });

  audioCallBtn?.classList.add('active');
  videoCallBtn?.classList.add('active');
  updateCallModeButtons();
  startOutgoingRing();
}

function updateCallModeButtons() {
  ['audio', 'video', 'screen'].forEach(m => {
    const btn = $('mode-' + m + '-btn');
    if (btn) btn.classList.toggle('active', callMode === m);
  });
}

async function acceptCall() {
  callBanner.classList.remove('visible');
  stopIncomingRing();
  if (!incomingCallData) return;
  const { offer, from } = incomingCallData;

  const key = from.hiddenId || from.userId;
  if (!activePeer || activePeer.hiddenId !== key) {
    activePeer = { ...from, hiddenId: key };
    if (!chatTabs.has(key)) chatTabs.set(key, { peer: activePeer, messages:[], connected:false });
    welcomeScreen.classList.add('hidden');
    chatView.classList.remove('hidden');
    const displayName = peerDisplayName(activePeer);
    chatAvatar.innerHTML = initials(displayName);
    chatPeerName.textContent = displayName;
    chatPeerSub.textContent  = activePeer.radminIp;
    if (remoteLabel) remoteLabel.textContent = displayName;
  }

  const hasVideo = offer.sdp?.includes('m=video');
  const audioDeviceId = userConfig.audioInputDeviceId;
  const audioConstraintsBase = {
    noiseSuppression: !!userConfig.noiseSuppression,
    echoCancellation: !!userConfig.echoCancellation,
    autoGainControl: !!userConfig.autoGainControl,
  };
  const constraints = {
    audio: audioDeviceId ? { deviceId:{ exact:audioDeviceId }, ...audioConstraintsBase } : audioConstraintsBase,
    video: hasVideo,
  };
  try { localStream = await navigator.mediaDevices.getUserMedia(constraints); }
  catch { try { localStream = await navigator.mediaDevices.getUserMedia({ audio:true }); } catch {} }

  if (localStream) {
    localVideo.srcObject = localStream;
    if (isMuted) applyMicMuteStateToStreams();
    startSpeakingDetection(localStream, true);
  }

  const pc = createPeerConnection(activePeer);
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: activePeer.userId, answer: pc.localDescription });

  videoOverlay.classList.add('visible');
  socket?.emit?.('call-state', { inCall: true });
  updateCallModeButtons();
  addSystemMsg(`Принят звонок от ${peerDisplayName(from)}`);
  incomingCallData = null;
  renderSidebar();
}

function rejectCall() {
  callBanner.classList.remove('visible');
  if (incomingCallData) {
    socket?.emit('call-end', { to: incomingCallData.from.userId });
    incomingCallData = null;
  }
  stopIncomingRing();
}

function endCall() {
  if (activePeer && socket) socket.emit('call-end', { to: activePeer.userId });
  cleanupCall();
}

function detachCallOverlay() {
  if (!window.electronAPI?.openCallOverlay) {
    toast('Функция недоступна');
    return;
  }
  callOverlayDetached = true;
  window.electronAPI.openCallOverlay();
  // Start frame capture after overlay window opens
  setTimeout(startFrameCapture, 600);
}

function cleanupCall() {
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteStream = null;
  stopSpeakingDetection();
  stopFrameCapture();
  videoOverlay.classList.remove('visible');
  // Reset overlay position/size
  videoOverlay.style.left = '';
  videoOverlay.style.top = '';
  videoOverlay.style.bottom = '';
  videoOverlay.style.width = '';
  videoOverlay.style.height = '';
  audioCallBtn?.classList.remove('active');
  videoCallBtn?.classList.remove('active');
  isMuted = false; isCamOff = false;
  const miIcon = muteBtn?.querySelector('i');
  if (miIcon) miIcon.className = 'fas fa-microphone';
  const camIcon = camBtn?.querySelector('i');
  if (camIcon) camIcon.className = 'fas fa-video';
  stopOutgoingRing();
  stopIncomingRing();
  window.electronAPI?.closeCallOverlay?.();
  socket?.emit?.('call-state', { inCall: false });
  updateJoinCallBanner();
}

function toggleMute() { setMicMuted(!isMuted); }

function applyMicMuteStateToStreams() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
}

function updateMicIcons() {
  const cls = isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
  const overlayIcon = muteBtn?.querySelector('i');
  const navIcon     = navMicBtn?.querySelector('i');
  if (overlayIcon) overlayIcon.className = cls;
  if (navIcon)     navIcon.className     = cls;
}

function setMicMuted(muted) {
  isMuted = muted;
  applyMicMuteStateToStreams();
  updateMicIcons();
  if (navMicBtn) navMicBtn.classList.toggle('muted', isMuted);
}

function toggleGlobalMic() { setMicMuted(!isMuted); }

function toggleCamera() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const icon = camBtn?.querySelector('i');
  if (icon) icon.className = isCamOff ? 'fas fa-video-slash' : 'fas fa-video';
}

async function switchCallMode(mode) {
  if (!activePeer || !localStream) return;
  if (callMode === mode) return;
  const pc = peerConnections[activePeer.userId];
  if (!pc || pc.connectionState !== 'connected') return;
  const audioDeviceId = userConfig.audioInputDeviceId;
  const audioConstraintsBase = {
    noiseSuppression: !!userConfig.noiseSuppression,
    echoCancellation: !!userConfig.echoCancellation,
    autoGainControl: !!userConfig.autoGainControl,
  };
  const oldStream = localStream;
  try {
    let newStream = null;
    if (mode === 'screen') {
      let displayStream = null;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      } catch (err) {
        if (window.electronAPI?.getDesktopSources) {
          const sources = await window.electronAPI.getDesktopSources({ types: ['screen', 'window'] });
          const src = sources.find(s => s.id) || sources[0];
          if (src?.id) {
            displayStream = await navigator.mediaDevices.getUserMedia({
              video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id } },
              audio: false,
            });
          }
        }
        if (!displayStream) throw err;
      }
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, ...audioConstraintsBase } : audioConstraintsBase,
        video: false,
      }).catch(() => null);
      newStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...(audioStream ? audioStream.getAudioTracks() : []),
      ]);
    } else {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: audioDeviceId ? { deviceId: { exact: audioDeviceId }, ...audioConstraintsBase } : audioConstraintsBase,
        video: mode === 'video' ? { width: 1280, height: 720 } : false,
      });
    }

    // Не убиваем старые треки, пока не переренегицируем соединение
    localStream = newStream;
    localVideo.srcObject = localStream;
    if (isMuted) applyMicMuteStateToStreams();
    startSpeakingDetection(localStream, true);
    const senders = pc.getSenders();
    const audioTrack = localStream.getAudioTracks()[0];
    const videoTrack = localStream.getVideoTracks()[0];
    const audioSender = senders.find(s => s.track?.kind === 'audio');
    const videoSender = senders.find(s => s.track?.kind === 'video');
    if (audioSender && audioTrack) await audioSender.replaceTrack(audioTrack);
    if (videoSender && videoTrack) await videoSender.replaceTrack(videoTrack);
    else if (videoTrack && !videoSender) await pc.addTrack(videoTrack, localStream);
    else if (!videoTrack && videoSender) await pc.removeTrack(videoSender);

    const offer = await pc.createOffer({ iceRestart: mode === 'screen' });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: activePeer.userId, offer: pc.localDescription, from: myUserId });
    callMode = mode;
    updateCallModeButtons();
    // Теперь можно безопасно остановить старые треки
    if (oldStream && oldStream !== localStream) {
      oldStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    }
  } catch (err) {
    toast('✗ ' + (err?.message || 'Не удалось переключить режим'));
  }
}

function toggleHeadphones() {
  isHeadphonesMuted = !isHeadphonesMuted;
  if (remoteVideo) {
    remoteVideo.muted = isHeadphonesMuted;
    remoteVideo.volume = isHeadphonesMuted ? 0 : 1;
  }
  const icon = navHeadphonesBtn?.querySelector('i');
  if (icon) icon.className = isHeadphonesMuted ? 'fas fa-headphones-simple' : 'fas fa-headphones';
  if (navHeadphonesBtn) navHeadphonesBtn.classList.toggle('muted', isHeadphonesMuted);
}

function toggleScreenShare() {
  if (!socket || !socket.connected) { toast('Нет подключения к серверу'); return; }
  if (!activePeer) { toast('Выберите собеседника'); return; }
  const inCall = videoOverlay?.classList?.contains?.('visible');
  if (!inCall) { startCall('screen'); return; }
  if (callMode === 'screen') switchCallMode('audio');
  else switchCallMode('screen');
}

function toggleFocusRemote() {
  if (!videoOverlay) return;
  videoOverlay.classList.toggle('focus-remote');
}

/* ─── CHAT SEND ───────────────────────────────────────────── */
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !activePeer) return;
  if (!socket || !socket.connected) { toast('Нет подключения к серверу'); return; }

  const msgId = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const msgObj = { id: msgId, text, me: true, sender: myHiddenId, time: timeStr(), status: 'pending' };
  const peerKey = activePeer.hiddenId || activePeer.userId;
  const tab = chatTabs.get(peerKey);
  if (tab) { tab.messages.push(msgObj); persistChatTabs(); }

  let ciphertext = '';
  try { ciphertext = btoa(JSON.stringify({ text, id: msgId })); } catch { ciphertext = ''; }
  const ivBytes = new Uint8Array(12);
  const iv = btoa(String.fromCharCode(...ivBytes));
  socket?.emit?.('chat-send', { roomType: 'dm', roomId: peerKey, to: peerKey, ciphertext, iv, clientMsgId: msgId }, (ack) => {
    if (ack?.ok) setMessageStatus(peerKey, msgId, 'delivered');
  });
  appendMessageEl(text, true, myHiddenId, msgObj.time, msgId, msgObj.status);
  msgInput.value = '';
  msgInput.style.height = 'auto';
}

function handleMsgKey(e) {
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

/* ─── FILE TRANSFER ──────────────────────────────────────── */
function openFilePicker() {
  if (!fileInput) return;
  fileInput.value = '';
  fileInput.click();
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (!fileInput.files?.length) return;
    Array.from(fileInput.files).forEach(sendFile);
  });
}

async function sendFile(file) {
  if (!activePeer) return;
  const dc = dataChannels[activePeer.userId];
  if (!dc || dc.readyState !== 'open') { toast('Нет активного P2P соединения'); return; }

  const MAX_SIZE = 50 * 1024 * 1024;
  if (file.size > MAX_SIZE) { toast('Файл слишком большой (макс 50MB)'); return; }

  const transferId = genId();
  const totalChunks = Math.ceil(file.size / FILE_CHUNK);
  const dataUrl = await readFileAsDataURL(file);

  dc.send(JSON.stringify({
    type: 'file-start', transferId, sender: myUserId,
    name: file.name, mime: file.type || 'application/octet-stream',
    size: file.size, totalChunks,
  }));

  const base64 = dataUrl.split(',')[1];
  for (let i = 0; i < totalChunks; i++) {
    const chunk = base64.slice(i * Math.ceil(base64.length / totalChunks), (i+1) * Math.ceil(base64.length / totalChunks));
    dc.send(JSON.stringify({ type: 'file-chunk', transferId, index: i, data: chunk }));
    if (i % 20 === 0) await new Promise(r => setTimeout(r, 0));
  }

  const fileMsg = { transferId, sender: myUserId, name: file.name, mime: file.type, size: file.size, dataUrl };
  const msgObj = { fileMsg, me: true, time: timeStr() };
  const tab = chatTabs.get(activePeer.hiddenId || activePeer.userId);
  if (tab) { tab.messages.push(msgObj); persistChatTabs(); }
  appendFileMessageEl(fileMsg, true);
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

function addFileProgressMsg(msg, uid) {
  const div = document.createElement('div');
  div.id = 'fp_' + msg.transferId;
  div.className = 'msg';
  div.innerHTML = `
    <div class="msg-av">${initials(msg.sender)}</div>
    <div class="msg-body">
      <div class="file-progress-wrap">
        <div class="file-progress-name">${escapeHtml(msg.name)}</div>
        <div class="file-progress-bar-bg"><div class="file-progress-bar" id="fpb_${msg.transferId}" style="width:0%"></div></div>
        <div class="file-progress-pct" id="fpp_${msg.transferId}">0%</div>
      </div>
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateFileProgress(transferId, received, total) {
  const bar = $('fpb_' + transferId);
  const pct = $('fpp_' + transferId);
  const p = Math.round(received / total * 100);
  if (bar) bar.style.width = p + '%';
  if (pct) pct.textContent = p + '%';
}

function finalizeFile(transferId, ft) {
  const base64 = ft.chunks.join('');
  const dataUrl = `data:${ft.mime};base64,${base64}`;
  const fileMsg = { transferId, sender: ft.sender, name: ft.name, mime: ft.mime, size: ft.size, dataUrl };
  const el = $('fp_' + transferId);
  if (el) el.remove();
  appendFileMessageEl(fileMsg, false);
  const tab = chatTabs.get(ft.uid);
  if (tab) { tab.messages.push({ fileMsg, me: false, time: timeStr() }); persistChatTabs(); }
  delete incomingFiles[transferId];
}

/* ─── RENDER MESSAGES ────────────────────────────────────── */
function renderMessages(uid) {
  if (!messagesEl || activePeerKey() !== uid) return;
  messagesEl.innerHTML = '';
  const tab = chatTabs.get(uid);
  (tab?.messages || []).forEach(m => {
    if (m.fileMsg) appendFileMessageEl(m.fileMsg, m.me);
    else appendMessageEl(m.text, m.me, m.sender, m.time, m.id, m.status);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessageEl(text, isMe, sender, time, msgId, status) {
  const div = document.createElement('div');
  div.className = 'msg' + (isMe ? ' me' : '');
  if (msgId) div.dataset.msgId = String(msgId);

  let avatarHtml;
  if (isMe) {
    if (userConfig.avatarPath) {
      avatarHtml = `<img src="${escapeHtml(userConfig.avatarPath)}" alt="me">`;
    } else {
      avatarHtml = initials(userConfig.username || 'Я');
    }
  } else {
    // Try to get peer avatar
    const peerUid = sender || activePeer?.hiddenId || activePeer?.userId;
    const tab = peerUid ? chatTabs.get(peerUid) : null;
    const peer = tab?.peer || onlinePeers.find(p => (p.hiddenId || p.userId) === peerUid);
    const peerAvatar = resolveAvatarUrl(peer?.avatarUrl);
    if (peerAvatar) {
      avatarHtml = `<img src="${escapeHtml(peerAvatar)}" alt="peer">`;
    } else {
      avatarHtml = initials(peerDisplayName(peer) || (activePeer ? peerDisplayName(activePeer) : '?'));
    }
  }

  const effStatus = isMe ? (normalizeMsgStatus(status) || 'delivered') : null;
  const statusHtml = isMe ? `<span class="msg-status">${escapeHtml(statusGlyph(effStatus))}</span>` : '';

  div.innerHTML = `
    <div class="msg-av">${avatarHtml}</div>
    <div class="msg-body">
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <div class="msg-meta">${escapeHtml(time || timeStr())}${statusHtml}</div>
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendFileMessageEl(fileMsg, isMe) {
  const div = document.createElement('div');
  div.className = 'msg' + (isMe ? ' me' : '');

  let avatarHtml;
  if (isMe) {
    if (userConfig.avatarPath) {
      avatarHtml = `<img src="${escapeHtml(userConfig.avatarPath)}" alt="me">`;
    } else {
      avatarHtml = initials(userConfig.username || 'Я');
    }
  } else {
    const peer = activePeer;
    const peerAvatar = resolveAvatarUrl(peer?.avatarUrl);
    if (peerAvatar) {
      avatarHtml = `<img src="${escapeHtml(peerAvatar)}" alt="peer">`;
    } else {
      avatarHtml = initials(peerDisplayName(peer) || '?');
    }
  }

  const isImage = (fileMsg.mime||'').startsWith('image/');
  const safeName = escapeHtml(fileMsg.name || 'file');
  const url = fileMsg.dataUrl || '#';
  const sizeStr = fileMsg.size ? ` · ${(fileMsg.size/1024).toFixed(1)} KB` : '';

  let preview;
  if (isImage) {
    preview = `<img src="${url}" alt="${safeName}" class="file-img" onclick="openLightbox(this.src)" />`;
  } else {
    const iconMap = { 'application/pdf':'fa-file-pdf', 'application/zip':'fa-file-zipper', 'text/plain':'fa-file-lines' };
    const iconClass = iconMap[fileMsg.mime] || 'fa-file';
    preview = `<i class="fas ${iconClass}" style="font-size:24px;margin-bottom:6px;display:block"></i>`;
  }

  div.innerHTML = `
    <div class="msg-av">${avatarHtml}</div>
    <div class="msg-body">
      <div class="msg-bubble file">
        <a class="file-link" href="${url}" download="${safeName}">${preview}</a>
        <div class="file-meta">${safeName}${sizeStr}</div>
      </div>
      <div class="msg-meta">${timeStr()}</div>
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg-system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ─── LIGHTBOX ───────────────────────────────────────────── */
function openLightbox(src) {
  const lb = $('lightbox');
  const img = $('lightbox-img');
  if (!lb || !img) return;
  img.src = src;
  lb.classList.add('visible');
}
function closeLightbox() {
  $('lightbox')?.classList.remove('visible');
}

/* ─── SETTINGS ───────────────────────────────────────────── */
async function openSettings() {
  await fillAudioDeviceLists();
  settingsModal?.classList.add('visible');
}
function closeSettings() {
  settingsModal?.classList.remove('visible');
}

async function fillAudioDeviceLists() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    if (audioInputSelect) {
      audioInputSelect.innerHTML = '';
      inputs.forEach((d,i) => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Микрофон ${i+1}`;
        audioInputSelect.appendChild(o);
      });
      if (userConfig.audioInputDeviceId) audioInputSelect.value = userConfig.audioInputDeviceId;
    }
    if (audioOutputSelect) {
      audioOutputSelect.innerHTML = '';
      outputs.forEach((d,i) => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Выход ${i+1}`;
        audioOutputSelect.appendChild(o);
      });
      if (userConfig.audioOutputDeviceId) audioOutputSelect.value = userConfig.audioOutputDeviceId;
    }
  } catch { toast('Не удалось получить список устройств'); }
}

async function applyOutputDevice(deviceId) {
  if (!remoteVideo || typeof remoteVideo.setSinkId !== 'function') return;
  if (!deviceId) return;
  try { await remoteVideo.setSinkId(deviceId); } catch {}
}

async function testAudioInput() {
  const deviceId = audioInputSelect?.value;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId:{ exact:deviceId }, noiseSuppression: !!userConfig.noiseSuppression, echoCancellation: !!userConfig.echoCancellation, autoGainControl: !!userConfig.autoGainControl }
        : { noiseSuppression: !!userConfig.noiseSuppression, echoCancellation: !!userConfig.echoCancellation, autoGainControl: !!userConfig.autoGainControl },
      video: false,
    });
    stream.getTracks().forEach(t => setTimeout(()=>t.stop(), 1500));
    toast('✓ Микрофон захватывает звук');
  } catch { toast('✗ Не удалось получить доступ к микрофону'); }
}

async function testAudioOutput() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { toast('Web Audio не поддерживается'); return; }
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 300);
    toast('✓ Тестовый звук воспроизведён');
  } catch { toast('✗ Ошибка воспроизведения'); }
}

/* ─── INIT ───────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  (async () => {
    await refreshLocalIps();
    await loadUserConfig();
    try {
      identityInfo = await window.electronAPI?.getIdentity?.();
      if (identityInfo?.userId) myUserId = identityInfo.userId;
    } catch {}
    loadChatTabsFromStorage();
    applyConfigToUI();
    renderSidebar();

    ['connect-modal','settings-modal','profile-modal'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('click', e => { if (e.target === el) el.classList.remove('visible'); });
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeLightbox();
        closeSettings();
        closeConnectModal();
        closeProfileModal();
        return;
      }
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.code === 'KeyI')) {
        window.electronAPI?.openDevTools?.();
      }
    });

    if (audioInputSelect) {
      audioInputSelect.addEventListener('change', async () => {
        await saveUserConfig({ audioInputDeviceId: audioInputSelect.value || null });
      });
    }
    if (audioOutputSelect) {
      audioOutputSelect.addEventListener('change', async () => {
        const val = audioOutputSelect.value || null;
        await saveUserConfig({ audioOutputDeviceId: val });
        if (val) await applyOutputDevice(val);
      });
    }
    if (userConfig.audioOutputDeviceId) applyOutputDevice(userConfig.audioOutputDeviceId);

    if (noiseSuppToggle) {
      noiseSuppToggle.checked = !!userConfig.noiseSuppression;
      noiseSuppToggle.addEventListener('change', async () => {
        await saveUserConfig({ noiseSuppression: !!noiseSuppToggle.checked });
      });
    }
    if (echoCancToggle) {
      echoCancToggle.checked = !!userConfig.echoCancellation;
      echoCancToggle.addEventListener('change', async () => {
        await saveUserConfig({ echoCancellation: !!echoCancToggle.checked });
      });
    }
    if (autoGainToggle) {
      autoGainToggle.checked = !!userConfig.autoGainControl;
      autoGainToggle.addEventListener('change', async () => {
        await saveUserConfig({ autoGainControl: !!autoGainToggle.checked });
      });
    }
    if (speechThreshRange) {
      const val = typeof userConfig.speechThreshold === 'number' ? userConfig.speechThreshold : 0.05;
      speechThreshRange.value = String(val);
      speechThreshRange.addEventListener('input', async () => {
        const v = Number(speechThreshRange.value) || 0.05;
        await saveUserConfig({ speechThreshold: v });
      });
    }

    // Call overlay events
    if (window.electronAPI) {
      callOverlayUnsubOpened = window.electronAPI.onCallOverlayOpened?.(() => {
        callOverlayDetached = true;
        // startFrameCapture is called in detachCallOverlay with delay
      });
      callOverlayUnsubClosed = window.electronAPI.onCallOverlayClosed?.(() => {
        stopFrameCapture();
      });
    }

    // Video overlay drag (within app window)
    if (videoOverlay) {
      let resizing = false;

      videoOverlay.addEventListener('mousedown', (e) => {
        if (e.target.closest('.video-controls')) return;
        if (e.target.closest('.overlay-resize-handle')) return;
        overlayDrag.active = true;
        const rect = videoOverlay.getBoundingClientRect();
        overlayDrag.offsetX = e.clientX - rect.left;
        overlayDrag.offsetY = e.clientY - rect.top;
        // Switch from right-anchored to left-anchored for dragging
        if (!videoOverlay.style.left) {
          videoOverlay.style.right = 'auto';
          videoOverlay.style.left = rect.left + 'px';
          videoOverlay.style.top = rect.top + 'px';
          videoOverlay.style.bottom = 'auto';
        }
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!overlayDrag.active) return;
        const rect = videoOverlay.getBoundingClientRect();
        const x = e.clientX - overlayDrag.offsetX;
        const y = e.clientY - overlayDrag.offsetY;
        const maxX = window.innerWidth - Math.max(rect.width, 200);
        const maxY = window.innerHeight - Math.max(rect.height, 100);
        videoOverlay.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        videoOverlay.style.top  = `${Math.max(0, Math.min(y, maxY))}px`;
      });

      document.addEventListener('mouseup', () => {
        overlayDrag.active = false;
      });

      videoOverlay.addEventListener('dblclick', (e) => {
        if (e.target.closest('.video-controls')) return;
        videoOverlay.classList.toggle('large');
      });
    }

    // Local signaling server exit (hosted mode)
    if (window.electronAPI?.onSignalingExit) {
      window.electronAPI.onSignalingExit(() => {
        if (socket) {
          try { socket.disconnect(); } catch {}
          socket = null;
        }
        onlinePeers = [];
        activePeer = null;
        chatView.classList.add('hidden');
        welcomeScreen.classList.remove('hidden');
        Object.values(peerConnections).forEach(pc => { try { pc.close(); } catch {} });
        peerConnections = {};
        dataChannels = {};
        serverStatusTxt.textContent = 'сервер выключен';
        tbStatus.classList.remove('connected');
        renderSidebar();
      });
    }

    if (serverPortInp && !serverPortInp.value) serverPortInp.value = '7345';
    if (hostPortInp && !hostPortInp.value) hostPortInp.value = '7345';

    try { await window.electronAPI?.startDiscovery?.(); } catch {}
    if (!discoveryUnsub) {
      discoveryUnsub = window.electronAPI?.onDiscoveryUpdate?.((list) => {
        discoveredServers = Array.isArray(list) ? list : [];
        if (socket?.connected) return;
        if (discoveredServers.length >= 1) connectToFoundServer(discoveredServers[0]);
      });
    }

    if (userConfig.lastServer?.ip) {
      if (serverIpInp) serverIpInp.value = userConfig.lastServer.ip;
    }
    if (userConfig.lastServer?.port) {
      const p = String(userConfig.lastServer.port);
      if (serverPortInp) serverPortInp.value = p;
      if (hostPortInp) hostPortInp.value = p;
      const fp = $('footer-port-inp');
      if (fp) fp.value = p;
    }

    if (userConfig.autoConnect !== false && userConfig.lastServer?.ip && userConfig.lastServer?.port) {
      connectToServer();
    }

    setTimeout(() => {
      if (socket?.connected) return;
      if (Array.isArray(discoveredServers) && discoveredServers.length) return;
      ensureLocalServerAndConnect();
    }, 2500);
  })();
});