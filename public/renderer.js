// ╔══════════════════════════════════════════════════════════╗
// ║  NexLink Renderer v3.0 — Server-Relay Architecture      ║
// ╚══════════════════════════════════════════════════════════╝
'use strict';

/* ─── GLOBAL STATE ────────────────────────────────────────── */
let socket         = null;
let myUserId       = null;
let myHiddenId     = null;
let myRadminIp     = null;
let localIps       = [];
let identityInfo   = null;
let sessionToken   = null;

let activePeer     = null;
let localStream    = null;
let micStream      = null;

let incomingCallData = null;
let callMode         = null;
let isMuted          = false;
let isCamOff         = false;

/* ── Relay state ────────────────────────────────────────────── */
let mediaRelayRoom     = null;      // current call room id
let mediaRelayRecorders = { audio: null, video: null, screen: null }; // kind → MediaRecorder
let mediaRelayMimeTypes = { audio: null, video: null, screen: null }; // kind → mime
let relayInitFirst      = { audio: true, video: true, screen: true }; // kind → first chunk flag
let remoteRelayPlayers  = {};        // `${hiddenId}:${kind}` → RelayPlayer
let remoteVisualKind    = {};        // hiddenId → 'video' | 'screen' (what is bound to remoteVideo now)
let currentRemoteVisualHiddenId = null;
let currentCallMembers = [];        // [{ hiddenId, nickname, avatarUrl }]
let lastVisualMode     = 'audio';   // remember last mode when toggling screen share

/* ── P2P (WebRTC) state ─────────────────────────────────────── */
const rtcPeers   = new Map();       // hiddenId → RTCPeerConnection
const rtcStreams = new Map();       // hiddenId → MediaStream

/* ── Chat / peers ───────────────────────────────────────────── */
let chatTabs       = new Map();
let onlinePeers    = [];
let currentNavTab  = 'peers';

const FILE_CHUNK   = 32 * 1024;    // 32 KB chunks for file transfer
let incomingFiles  = {};

let userConfig = {
  username:            'User',
  handle:              null,
  bio:                 '',
  avatarPath:          null,
  audioInputDeviceId:  null,
  audioOutputDeviceId: null,
  noiseSuppression:    true,
  echoCancellation:    true,
  autoGainControl:     true,
  speechThreshold:     0.05,
  streamVolume:        1,
  savedServers:        [],
  peerVolumes:         {},
  screenSystemAudio:   true,
  screenBitrateKbps:   900,
  videoBitrateKbps:    600,
  notifyMessages:      true,
  notifyCalls:         true,
  lastServer:          null,
  autoConnect:         false,
};

/* ─── DOM ─────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const serverStatusTxt   = $('server-status-txt');
const tbStatus          = $('tb-status');
const sidebarContent    = $('sidebar-content');
const serverRailEl      = $('server-rail-list');
const welcomeScreen     = $('welcome-screen');
const chatView          = $('chat-view');
const chatAvatar        = $('chat-avatar');
const chatPeerName      = $('chat-peer-name');
const chatPeerSub       = $('chat-peer-sub');
const messagesEl        = $('messages');
const msgInput          = $('msg-input');
const sendBtn           = $('send-btn');
const videoOverlay      = $('video-overlay');
const localVideo        = $('local-video');
const remoteVideo       = $('remote-video');
const remoteLabel       = $('remote-label');
const callBanner        = $('call-banner');
const bannerFrom        = $('banner-from');
const myIpTxt           = $('my-ip-txt');
const hostIpsTxt        = $('host-ips-txt');
const myNameEl          = $('my-name-el');
const myStatusEl        = $('my-status-el');
const myAvatarEl        = $('my-avatar-el');
const myAvatarImg       = $('my-avatar-img');
const myAvatarInitials  = $('my-avatar-initials');
const myIdEl            = $('my-id-el');
const audioCallBtn      = $('audio-call-btn');
const videoCallBtn      = $('video-call-btn');
const serverIpInp       = $('server-ip-inp');
const serverPortInp     = $('server-port-inp');
const hostPortInp       = $('host-port-inp');
const usernameInp       = $('username-inp');
const hostStopBtn       = $('host-stop-btn');
const settingsModal     = $('settings-modal');
const settingsTitleEl   = $('settings-title');
const settingsPageProfile = $('settings-page-profile');
const settingsPageAudio   = $('settings-page-audio');
const settingsPageScreen  = $('settings-page-screen');
const settingsPageNotif   = $('settings-page-notifications');

const audioInputSelect  = $('audio-input-select');
const audioOutputSelect = $('audio-output-select');
const muteBtn           = $('mute-btn');
const camBtn            = $('cam-btn');
const fileInput         = $('file-input');
const remoteVideoWrap   = $('remote-video-wrap');
const localVideoWrap    = $('local-video-wrap');
const navMicBtn         = $('nav-mic-toggle');
const navHeadphonesBtn  = $('nav-headphones-toggle');
const streamVolumeRange = $('stream-volume-range');
const screenVolWidget   = $('screen-vol-widget');
const ctxMenu           = $('ctx-menu');
const ctxAv             = $('ctx-av');
const ctxNm             = $('ctx-nm');
const ctxSub            = $('ctx-sub');
const ctxVol            = $('ctx-vol');
const ctxVolVal         = $('ctx-vol-val');
const ctxResetBtn       = $('ctx-reset-btn');
const ctxCloseBtn       = $('ctx-close-btn');
const noiseSuppToggle   = $('noise-suppression-toggle');
const echoCancToggle    = $('echo-cancellation-toggle');
const autoGainToggle    = $('auto-gain-toggle');
const speechThreshRange = $('speech-threshold-range');
const screenAudioToggle = $('screen-audio-toggle');
const screenBitrateRange = $('screen-bitrate-range');
const videoBitrateRange  = $('video-bitrate-range');
const notifMsgToggle   = $('notif-msg-toggle');
const notifCallToggle  = $('notif-call-toggle');

let localAudioCtx  = null, localAnalyser  = null, localAudioRaf  = null;

let isHeadphonesMuted = false;
let outgoingRing = null;
let incomingRing = null;

let overlayDrag = { active: false, offsetX: 0, offsetY: 0 };
let screenVolHideTimer = null;

let discoveredServers    = [];
let discoveryUnsub       = null;
let autoConnectInFlight  = false;
let serverBaseUrl        = '';
let currentServerKey     = null;

let reconnectTimer   = null;
let reconnectAttempt = 0;
let connectInFlight  = false;

const readSentIds      = new Set();
const notifiedMsgKeys  = new Set();

let chatSyncTimer = null;
let callOverlayDetached = false;
let screenShareDetached = false;
let framePumpTimer = null;
let frameCanvas = null;
let frameCtx = null;

/* ══════════════════════════════════════════════════════════════
   RELAY PLAYER — plays a remote media stream received via server
   ══════════════════════════════════════════════════════════════ */
class RelayPlayer {
  constructor(kind, mimeType) {
    this.kind      = kind;
    this.mimeType  = mimeType || (kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8,opus');
    this.ms        = new MediaSource();
    this.sb        = null;
    this.queue     = [];
    this.ready     = false;
    this.destroyed = false;
    this._gcTimer  = null;

    // For video/screen use the existing remoteVideo element;
    // for audio create a hidden Audio node.
    if (kind === 'video' || kind === 'screen') {
      this.el = remoteVideo;
      try { remoteVideo.srcObject = null; } catch {}
    } else {
      this.el = new Audio();
      this.el.style.display = 'none';
      document.body.appendChild(this.el);
    }
    this._peerHiddenId = null;
    this.el.autoplay = true;
    this._blobUrl = URL.createObjectURL(this.ms);
    this.el.src   = this._blobUrl;

    this.ms.addEventListener('sourceopen', () => {
      if (this.destroyed) return;
      try {
        if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported && !MediaSource.isTypeSupported(this.mimeType)) {
          console.warn('[RelayPlayer] MIME type not supported for MediaSource:', this.mimeType);
          this.destroyed = true;
          try { this.ms.endOfStream(); } catch {}
          return;
        }
        if (this.ms.readyState !== 'open') {
          console.warn('[RelayPlayer] MediaSource not open on sourceopen, state=', this.ms.readyState);
          return;
        }
        this.sb = this.ms.addSourceBuffer(this.mimeType);
        this.sb.mode = 'sequence';
        this.sb.addEventListener('updateend', () => this._drain());
        this.ready = true;
        this._drain();
      } catch (e) {
        if (e && e.name === 'InvalidStateError') {
          console.warn('[RelayPlayer] addSourceBuffer InvalidStateError, readyState=', this.ms.readyState);
        } else {
          console.error('[RelayPlayer] sourceopen error:', e);
        }
      }
    });

    this.el.addEventListener('error', () => {
      if (this.destroyed) return;
      const msg = this.el?.error?.message || '';
      if (msg.includes('Empty src') || msg.includes('CHUNK_DEMUXER') || msg.includes('append_FAILED')) return;
      console.warn('[RelayPlayer] media error:', msg);
    });

    // Periodically trim buffer to prevent QuotaExceededError
    this._gcTimer = setInterval(() => {
      if (!this.sb || this.sb.updating || this.destroyed) return;
      try {
        if (this.sb.buffered.length > 0) {
          const end   = this.sb.buffered.end(this.sb.buffered.length - 1);
          const start = this.sb.buffered.start(0);
          if (end - start > 20) this.sb.remove(start, end - 8);
        }
      } catch {}
    }, 6000);
  }

  push(buf) {
    if (this.destroyed || !buf) return;
    // Normalize to ArrayBuffer
    let ab;
    if (buf instanceof ArrayBuffer) {
      ab = buf;
    } else if (ArrayBuffer.isView(buf)) {
      ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } else if (buf?.type === 'Buffer' && Array.isArray(buf.data)) {
      ab = new Uint8Array(buf.data).buffer;
    } else {
      return;
    }
    // Drop old chunks if queue is growing (network stall)
    if (this.queue.length > 40) this.queue = this.queue.slice(-8);
    this.queue.push(ab);
    this._drain();
  }

  _drain() {
    if (this.destroyed || !this.ready || !this.sb || this.sb.updating || !this.queue.length) return;
    const chunk = this.queue.shift();
    try {
      this.sb.appendBuffer(chunk);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        // Force trim, then retry
        try {
          if (this.sb.buffered.length > 0 && !this.sb.updating) {
            const end = this.sb.buffered.end(this.sb.buffered.length - 1);
            this.sb.remove(0, Math.max(0, end - 3));
            this.queue.unshift(chunk);
          }
        } catch {}
      } else if (e.name !== 'InvalidStateError') {
        console.warn('[RelayPlayer] appendBuffer:', e.name);
      }
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._gcTimer);
    this.el.onerror = null;
    try { this.el.pause(); } catch {}
    try { this.el.src = ''; } catch {}
    try { URL.revokeObjectURL(this._blobUrl); } catch {}
    try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch {}
    if (this.el !== remoteVideo) {
      try { this.el.remove(); } catch {}
    }
  }
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
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

/** Formats server time (unix seconds or ISO string) as HH:mm:ss */
function formatTimeHHMMSS(val) {
  if (val == null || val === '') return timeStr();
  // Already formatted HH:mm:ss (local or cached) — просто возвращаем как есть
  if (typeof val === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(val)) return val;
  let d;
  if (typeof val === 'number') d = new Date(val * 1000);
  else if (typeof val === 'string' && /^\d+$/.test(val)) d = new Date(parseInt(val, 10) * 1000);
  else d = new Date(val);
  if (isNaN(d.getTime())) return timeStr();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function initials(name) {
  const w = (name || '?').trim().split(/\s+/);
  return w.length >= 2 ? (w[0][0] + w[1][0]).toUpperCase() : (name || '?').slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── CONTEXT MENU (peer volume) ─────────────────────────── */
let ctxPeerHiddenId = null;
function clamp(num, min, max) { return Math.max(min, Math.min(max, num)); }

function getPeerVolume(hid) {
  const map = (userConfig && typeof userConfig.peerVolumes === 'object' && userConfig.peerVolumes) ? userConfig.peerVolumes : {};
  const raw = map?.[hid];
  const n = (typeof raw === 'number' && isFinite(raw)) ? raw : 1;
  return clamp(n, 0, 2);
}

function setPeerVolumeLocal(hid, vol) {
  if (!hid) return;
  const map = (userConfig && typeof userConfig.peerVolumes === 'object' && userConfig.peerVolumes) ? userConfig.peerVolumes : {};
  userConfig.peerVolumes = { ...map, [hid]: clamp(vol, 0, 2) };
  applyStreamVolumeToPlayers();
}

async function persistPeerVolumes() {
  const map = (userConfig && typeof userConfig.peerVolumes === 'object' && userConfig.peerVolumes) ? userConfig.peerVolumes : {};
  try { await saveUserConfig({ peerVolumes: map }); } catch {}
}

function closePeerContextMenu() {
  if (!ctxMenu) return;
  ctxMenu.classList.remove('visible');
  ctxPeerHiddenId = null;
}

function openPeerContextMenu(peer, x, y) {
  if (!ctxMenu || !peer) return;
  const hid = peer.hiddenId || peer.userId;
  if (!hid) return;
  ctxPeerHiddenId = hid;
  const name = peerDisplayName(peer);
  if (ctxNm) ctxNm.textContent = name;
  if (ctxSub) ctxSub.textContent = peer?.radminIp || '';
  if (ctxAv) {
    const av = resolveAvatarUrl(peer?.avatarUrl || null);
    ctxAv.innerHTML = av ? `<img src="${escapeHtml(av)}" alt="">` : escapeHtml(initials(name));
  }

  const vol = getPeerVolume(hid);
  if (ctxVol) ctxVol.value = String(Math.round(vol * 100));
  if (ctxVolVal) ctxVolVal.textContent = `${Math.round(vol * 100)}%`;

  // Position inside viewport
  ctxMenu.style.left = '0px';
  ctxMenu.style.top = '0px';
  ctxMenu.classList.add('visible');
  const r = ctxMenu.getBoundingClientRect();
  const pad = 8;
  const nx = clamp(x, pad, window.innerWidth - r.width - pad);
  const ny = clamp(y, pad, window.innerHeight - r.height - pad);
  ctxMenu.style.left = `${nx}px`;
  ctxMenu.style.top  = `${ny}px`;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function peerDisplayName(peer) {
  return peer?.nickname || peer?.name || 'Пользователь';
}

function lookupName(userId) {
  if (!userId) return 'Пользователь';
  const found = onlinePeers.find(p => p.userId === userId || p.hiddenId === userId);
  if (found?.nickname) return found.nickname;
  return chatTabs.get(userId)?.peer?.nickname || userConfig.username || 'Пользователь';
}

function normalizePeerKey(id) {
  if (!id) return null;
  const found = onlinePeers.find(p => p.hiddenId === id || p.userId === id);
  return found?.hiddenId || id;
}

function genRelayRoomId(hidA, hidB) {
  return 'call:' + [hidA, hidB].sort().join(':');
}

function getBestMimeType(mode) {
  const types = mode === 'audio'
    ? ['audio/webm;codecs=opus', 'audio/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/* ─── P2P HELPERS (WebRTC) ─────────────────────────────────── */
function getOrCreatePeerConnection(peerHiddenId) {
  if (!peerHiddenId) return null;
  if (rtcPeers.has(peerHiddenId)) return rtcPeers.get(peerHiddenId);

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const pc = new RTCPeerConnection({ iceServers });

  // Attach local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, localStream); } catch {}
    });
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate || !socket?.connected) return;
    socket.emit('p2p-ice', {
      to: peerHiddenId,
      candidate: event.candidate,
      roomId: mediaRelayRoom,
    });
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream) return;
    rtcStreams.set(peerHiddenId, stream);
    // Для активного собеседника отображаем первый доступный поток
    if (activePeer && (activePeer.hiddenId === peerHiddenId || activePeer.userId === peerHiddenId)) {
      try { remoteVideo.srcObject = stream; } catch {}
      videoOverlay.classList.add('visible');
      if (remoteLabel) remoteLabel.textContent = lookupName(peerHiddenId);
    }
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'failed' || st === 'closed' || st === 'disconnected') {
      closePeerConnection(peerHiddenId);
    }
  };

  rtcPeers.set(peerHiddenId, pc);
  return pc;
}

function closePeerConnection(peerHiddenId) {
  const pc = rtcPeers.get(peerHiddenId);
  if (pc) {
    try { pc.onicecandidate = null; pc.ontrack = null; } catch {}
    try { pc.close(); } catch {}
  }
  rtcPeers.delete(peerHiddenId);
  rtcStreams.delete(peerHiddenId);
}

function closeAllPeerConnections() {
  Array.from(rtcPeers.keys()).forEach(hid => closePeerConnection(hid));
}

async function startP2PWithPeer(peerHiddenId) {
  if (!socket?.connected || !mediaRelayRoom || !peerHiddenId || peerHiddenId === myHiddenId) return;
  try {
    const pc = getOrCreatePeerConnection(peerHiddenId);
    if (!pc) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('p2p-offer', {
      to: peerHiddenId,
      offer,
      roomId: mediaRelayRoom,
    });
  } catch (e) {
    console.warn('[P2P] startP2PWithPeer error:', e?.message || e);
  }
}

async function ensureP2PForCurrentRoom() {
  if (!socket?.connected || !mediaRelayRoom) return;
  const members = Array.isArray(currentCallMembers) && currentCallMembers.length
    ? currentCallMembers
    : (activePeer ? [activePeer] : []);
  members.forEach(m => {
    const hid = m.hiddenId || m.userId;
    if (!hid || hid === myHiddenId) return;
    if (!rtcPeers.has(hid)) startP2PWithPeer(hid);
  });
}

/* ─── CONFIG PERSISTENCE ─────────────────────────────────── */
async function loadUserConfig() {
  try {
    const cfg = await window.electronAPI?.loadConfig?.();
    if (cfg && typeof cfg === 'object' && !cfg.__error) userConfig = { ...userConfig, ...cfg };
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
    myAvatarEl.classList.toggle('has-img', !!userConfig.avatarPath);
    if (myAvatarImg) {
      userConfig.avatarPath ? (myAvatarImg.src = userConfig.avatarPath) : myAvatarImg.removeAttribute('src');
    }
  }
  const previewEl  = $('profile-avatar-preview');
  const previewImg = $('profile-avatar-img');
  const previewIni = $('profile-avatar-ini');
  if (previewIni) previewIni.textContent = initials(name);
  if (previewEl && previewImg) {
    previewEl.classList.toggle('has-img', !!userConfig.avatarPath);
    userConfig.avatarPath ? (previewImg.src = userConfig.avatarPath) : previewImg.removeAttribute('src');
  }
}

function applyConfigToUI() {
  if (userConfig.username) {
    if (usernameInp) usernameInp.value = userConfig.username;
    myNameEl.textContent = userConfig.username;
  }
  applyAvatar();
}

function applyIdentityToUI() {
  if (myIdEl && myUserId) {
    myIdEl.textContent = myUserId;
  }
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
      avatarDataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
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
  const handleInp = $('handle-inp');
  const bioInp    = $('bio-inp');
  if (handleInp) handleInp.value = userConfig.handle || '';
  if (bioInp)    bioInp.value    = userConfig.bio || '';
  openSettingsTab('profile');
}
function closeProfileModal() { closeSettings(); }

async function saveProfile() {
  const username  = usernameInp.value.trim() || 'User';
  const handleInp = $('handle-inp');
  const bioInp    = $('bio-inp');
  const handleVal = handleInp?.value.trim() || userConfig.handle || '';
  const safeHandle = handleVal || (`@meowhiks_${Math.random().toString(36).slice(2,6)}`);
  const bioVal   = bioInp?.value || '';
  await saveUserConfig({ username, handle: safeHandle, bio: bioVal });
  myNameEl.textContent = username;
  applyAvatar();
  closeProfileModal();
  toast('Профиль сохранён');
  if (socket?.connected) {
    socket.emit('register', {
      userId: myUserId, radminIp: myRadminIp,
      identityPublicKey: identityInfo?.publicKey || null,
      sessionToken,
      nickname: safeHandle || username,
      avatarUrl: userConfig.avatarDataUrl || null,
    });
  }
}

async function copyUserId() {
  const id = myUserId || identityInfo?.userId || '';
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    toast('ID скопирован в буфер обмена');
  } catch {
    toast('Не удалось скопировать ID');
  }
}

/* ─── CONNECT MODAL ──────────────────────────────────────── */
function openConnectModal()  { $('connect-modal').classList.add('visible'); }
function closeConnectModal() { $('connect-modal').classList.remove('visible'); }

/* ─── IP DETECTION ───────────────────────────────────────── */
function isPrivateLanIp(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}
function pickBestLocalIp(ips) {
  return ips.find(ip => ip.startsWith('26.')) || ips.find(isPrivateLanIp) || ips.find(ip => ip !== '127.0.0.1') || '127.0.0.1';
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
function setNavTab(tab) { currentNavTab = tab; renderServerTabs(); renderSidebar(); }
function renderSidebar() { renderOnlinePeers(); }

function renderServerTabs() {
  if (!serverRailEl) return;
  serverRailEl.innerHTML = '';
  const servers = [];

  const addServer = (host, port, source = 'saved') => {
    const h = String(host || '').trim();
    const p = Number(port) || 0;
    if (!h || !p) return;
    const key = `${h}:${p}`;
    if (servers.some(s => s.key === key)) return;
    servers.push({ key, host: h, port: p, source });
  };

  // Saved servers first (user-managed)
  (Array.isArray(userConfig.savedServers) ? userConfig.savedServers : []).forEach(s => addServer(s.ip || s.host, s.port, 'saved'));
  // Discovered servers (LAN discovery)
  (Array.isArray(discoveredServers) ? discoveredServers : []).forEach(s => addServer(s.ip || s.host, s.port, 'discovered'));
  // Ensure the currently connected server is visible even if not in lists
  if (currentServerKey && !servers.some(s => s.key === currentServerKey)) {
    const [host, port] = String(currentServerKey).split(':');
    addServer(host, Number(port), 'current');
  }

  // "+": add / connect
  const plus = document.createElement('button');
  plus.className = 'rail-btn';
  plus.innerHTML = `<i class="fas fa-plus"></i><span class="rail-tooltip">Добавить сервер</span>`;
  plus.addEventListener('click', () => openConnectModal());
  serverRailEl.appendChild(plus);

  // Divider-like spacer
  const spacer = document.createElement('div');
  spacer.style.cssText = 'height:6px;';
  serverRailEl.appendChild(spacer);

  servers.forEach(srv => {
    const el = document.createElement('button');
    el.className = 'rail-btn' + (srv.key === currentServerKey ? ' active' : '');
    const badge = srv.source === 'discovered' ? ' · LAN' : (srv.source === 'current' ? ' · текущий' : '');
    el.innerHTML = `<i class="fas fa-server"></i><span class="rail-tooltip">${escapeHtml(srv.host)}:${srv.port}${badge}</span>`;
    el.addEventListener('click', () => {
      // If already connected — disconnect
      if (srv.key === currentServerKey && socket?.connected) {
        try { socket.disconnect(); } catch {}
        socket = null;
        serverStatusTxt.textContent = 'не подключён';
        tbStatus.classList.remove('connected');
        onlinePeers = [];
        activePeer  = null;
        chatView.classList.add('hidden');
        welcomeScreen.classList.remove('hidden');
        renderSidebar();
        renderServerTabs();
        return;
      }
      if (serverIpInp) serverIpInp.value = srv.host;
      if (serverPortInp) serverPortInp.value = String(srv.port);
      syncFooterPort();
      connectToServer();
    });
    // Right click: remove from saved list (if present)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (srv.source !== 'saved') return;
      const before = Array.isArray(userConfig.savedServers) ? userConfig.savedServers : [];
      const next = before.filter(x => `${(x.ip||x.host)}:${Number(x.port)}` !== srv.key);
      saveUserConfig({ savedServers: next }).then(() => renderServerTabs()).catch(() => {});
    });
    serverRailEl.appendChild(el);
  });
}

function renderChatTabs() {
  sidebarContent.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sec-label'; label.textContent = 'Чаты';
  sidebarContent.appendChild(label);
  if (!chatTabs.size) {
    const e = document.createElement('div');
    e.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);padding:8px 4px';
    e.textContent = 'Нет активных чатов';
    sidebarContent.appendChild(e);
    return;
  }
  chatTabs.forEach((tab, uid) => {
    const displayName = peerDisplayName(tab.peer);
    const el = document.createElement('div');
    el.className = 'chat-tab' + (activePeer?.userId === uid ? ' active' : '');
    el.dataset.uid = uid;
    const resolvedAvatar = resolveAvatarUrl(tab.peer.avatarUrl);
    const avatarHtml = resolvedAvatar ? `<img src="${escapeHtml(resolvedAvatar)}" alt="" />` : initials(displayName);
    el.innerHTML = `
      <div class="tab-avatar">${avatarHtml}<div class="tab-online-dot"></div></div>
      <div class="tab-info">
        <div class="tab-name">${escapeHtml(displayName)}</div>
        <div class="tab-sub">${escapeHtml(tab.peer.radminIp)}</div>
      </div>
      <div class="peer-actions-row">
        <button class="small-icon-btn" title="Голос" onclick="event.stopPropagation();quickCall('${escapeHtml(uid)}','audio')"><i class="fas fa-microphone"></i></button>
        <button class="small-icon-btn" title="Видео" onclick="event.stopPropagation();quickCall('${escapeHtml(uid)}','video')"><i class="fas fa-video"></i></button>
      </div>
      <button class="tab-close" title="Закрыть" onclick="event.stopPropagation();closeTab('${escapeHtml(uid)}')"><i class="fas fa-xmark"></i></button>`;
    el.addEventListener('click', () => openTab(uid));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = tab?.peer || null;
      if (p) openPeerContextMenu(p, e.clientX, e.clientY);
    });
    sidebarContent.appendChild(el);
  });
}

function renderOnlinePeers() {
  sidebarContent.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'sec-label'; label.textContent = 'Онлайн';
  sidebarContent.appendChild(label);
  const peers = onlinePeers.filter(p => p.userId !== myUserId);
  if (!peers.length) {
    const e = document.createElement('div');
    e.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);padding:10px 12px;line-height:1.4';
    e.innerHTML = socket?.connected ? 'Пока никого нет. Все, кто подключён, появятся здесь.' : 'Подключитесь к серверу.';
    sidebarContent.appendChild(e);
    return;
  }
  peers.forEach(peer => {
    const displayName = peerDisplayName(peer);
    const el = document.createElement('div');
    const isActive = activePeer && (activePeer.hiddenId === (peer.hiddenId || peer.userId));
    el.className = 'chat-tab' + (isActive ? ' active' : '');
    const resolvedAvatar = resolveAvatarUrl(peer.avatarUrl);
    const avatarHtml = resolvedAvatar ? `<img src="${escapeHtml(resolvedAvatar)}" alt="" />` : initials(displayName);
    el.innerHTML = `
      <div class="tab-avatar">${avatarHtml}<div class="tab-online-dot"></div></div>
      <div class="tab-info">
        <div class="tab-name">${escapeHtml(displayName)}</div>
        <div class="tab-sub">${escapeHtml(peer.radminIp)}</div>
      </div>
      <div class="peer-actions-row">
        <button class="small-icon-btn" title="Написать" onclick="event.stopPropagation();selectPeer(${JSON.stringify(peer).replace(/"/g,"'")})"><i class="fas fa-message"></i></button>
      </div>`;
    el.addEventListener('click', () => selectPeer(peer));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPeerContextMenu(peer, e.clientX, e.clientY);
    });
    sidebarContent.appendChild(el);
  });
}

function openTab(userId) { const tab = chatTabs.get(userId); if (tab) selectPeer(tab.peer); }
function closeTab(userId) {
  chatTabs.delete(userId);
  if (activePeer && (activePeer.hiddenId === userId || activePeer.userId === userId)) {
    activePeer = null;
    welcomeScreen.classList.remove('hidden');
    chatView.classList.add('hidden');
  }
  persistChatTabs();
  renderSidebar();
}
function quickCall(userId, mode) { const tab = chatTabs.get(userId); if (tab) selectPeer(tab.peer); startCall(mode); }

/* ─── SPEAKING DETECTION (local only) ───────────────────── */
function stopSpeakingDetection() {
  if (localAudioRaf) cancelAnimationFrame(localAudioRaf);
  localAudioRaf = null;
  try { localAudioCtx?.close(); } catch {}
  localAudioCtx = localAnalyser = null;
  [myAvatarEl, localVideoWrap].forEach(el => el?.classList.remove('speaking'));
}

function startSpeakingDetection(stream) {
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
      for (let i = 0; i < data.length; i++) { const v = (data[i]-128)/128; sum += v*v; }
      const level = Math.sqrt(sum/data.length);
      const now = performance.now();
      if (level > threshold) { speaking = true; lastAbove = now; }
      else if (speaking && (now - lastAbove) > releaseMs) { speaking = false; }
      myAvatarEl?.classList.toggle('speaking', speaking);
      localVideoWrap?.classList.toggle('speaking', speaking);
      localAudioRaf = requestAnimationFrame(loop);
    };
    if (localAudioCtx) localAudioCtx.close();
    localAudioCtx = ctx; localAnalyser = analyser;
    localAudioRaf = requestAnimationFrame(loop);
  } catch {}
}

/* ─── RING ───────────────────────────────────────────────── */
function createRingAudio() {
  try { const a = new Audio('musics/playing.mp3'); a.loop = true; a.volume = 0.7; return a; } catch { return null; }
}
function startOutgoingRing() { if (outgoingRing) return; outgoingRing = createRingAudio(); outgoingRing?.play().catch(() => {}); }
function stopOutgoingRing()  { if (!outgoingRing) return; try { outgoingRing.pause(); outgoingRing.currentTime = 0; } catch {} outgoingRing = null; }
function startIncomingRing() { if (incomingRing) return; incomingRing = createRingAudio(); incomingRing?.play().catch(() => {}); }
function stopIncomingRing()  { if (!incomingRing) return; try { incomingRing.pause(); incomingRing.currentTime = 0; } catch {} incomingRing = null; }

/* ─── SERVER CONNECT HELPERS ─────────────────────────────── */
function connectToFoundServer(srv) {
  if (!srv?.ip || !srv?.port) return;
  if (serverIpInp) serverIpInp.value = srv.ip;
  if (serverPortInp) serverPortInp.value = String(srv.port);
  syncFooterPort();
  connectToServer();
}

function syncFooterPort() {
  const port = serverPortInp?.value || hostPortInp?.value || '7345';
  const fp = $('footer-port-inp');
  if (fp && fp.value !== port) fp.value = port;
}

function quickReconnectByPort() {
  const fp = $('footer-port-inp');
  const port = fp ? Number(fp.value) || 7345 : 7345;
  if (serverPortInp) serverPortInp.value = String(port);
  if (hostPortInp)   hostPortInp.value = String(port);
  if (serverIpInp)   serverIpInp.value = userConfig.lastServer?.ip || '127.0.0.1';
  connectToServer();
}

function clearReconnectLoop() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempt = 0;
}

function scheduleReconnectLoop() {
  if (userConfig.autoConnect === false || socket?.connected || connectInFlight || reconnectTimer) return;
  try { window.electronAPI?.scanDiscovery?.(); } catch {}
  if (socket && typeof socket.connect === 'function') { try { socket.connect(); } catch {} return; }
  const delay = Math.min(15000, Math.round(1000 * Math.pow(1.6, reconnectAttempt)));
  reconnectAttempt++;
  serverStatusTxt.textContent = `переподключение через ${Math.ceil(delay/1000)}с...`;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToServer().catch(() => {}); }, delay);
}

async function ensureLocalServerAndConnect() {
  if (autoConnectInFlight) return;
  autoConnectInFlight = true;
  try {
    const fp = $('footer-port-inp');
    const desired = Number((fp?.value || hostPortInp?.value || serverPortInp?.value || '7345').trim()) || 7345;
    const res = await window.electronAPI?.startSignalingServer?.(desired);
    if (!res?.ok) { toast(`✗ Сервер не запустился: ${res?.error||'ошибка'}`); return; }
    if (hostStopBtn) hostStopBtn.disabled = false;
    if (serverIpInp)   serverIpInp.value  = '127.0.0.1';
    if (serverPortInp) serverPortInp.value = String(res.port);
    if (hostPortInp)   hostPortInp.value   = String(res.port);
    if (fp) fp.value = String(res.port);
    toast(`✓ Сервер создан на порту :${res.port}`);
    connectToServer();
  } finally { autoConnectInFlight = false; }
}

function notifyIncomingMessageOnce({ uid, serverId, msgId, senderHidden, text }) {
  try {
    if (!text || senderHidden === myHiddenId || !window.electronAPI?.notifyMessage) return;
    if (userConfig.notifyMessages === false) return;
    if (document.hasFocus && document.hasFocus()) return;
    const key = `${uid}:${serverId != null ? `sid:${serverId}` : `mid:${msgId||''}`}`;
    if (notifiedMsgKeys.has(key)) return;
    notifiedMsgKeys.add(key);
    window.electronAPI.notifyMessage({ title: lookupName(senderHidden), body: text });
  } catch {}
}

function syncAllChatsFromServer() {
  if (!socket?.connected) return;
  if (chatSyncTimer) { clearTimeout(chatSyncTimer); chatSyncTimer = null; }
  const keys = Array.from(chatTabs.keys()).filter(Boolean).slice(0, 25);
  keys.forEach((uid, i) => setTimeout(() => { if (socket?.connected) fetchChatHistoryFromServer(uid); }, i * 180));
}

/* ═══════════════════════════════════════════════════════════
   CONNECT TO SERVER
   ═══════════════════════════════════════════════════════════ */
async function connectToServer() {
  const username  = (usernameInp?.value || userConfig.username || 'User').trim();
  const serverIp  = serverIpInp?.value.trim() || '127.0.0.1';
  const port      = Number(serverPortInp?.value.trim() || 7345) || 7345;
  const serverUrl = `http://${serverIp}:${port}`;

  if (connectInFlight) return;
  connectInFlight = true;

  // End any active call before switching servers
  if (videoOverlay?.classList?.contains?.('visible')) {
    cleanupCall(false); // don't notify peer — we're disconnecting
  }

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  currentServerKey = `${serverIp}:${port}`;
  const hidKey = `nexlink-hidden-id-${currentServerKey}`;
  let storedHiddenId = null;
  try { storedHiddenId = localStorage.getItem(hidKey); } catch {}
  if (!storedHiddenId || storedHiddenId.length < 8) {
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
    sessionToken = Array.from(buf).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  if (socket) { socket.disconnect(); socket = null; }
  if (identityInfo?.userId) myUserId = identityInfo.userId;
  else if (!myUserId) myUserId = 'u_' + genId();

  // Ensure we have a persistent handle for this user
  if (!userConfig.handle) {
    const generatedHandle = '@meowhiks_' + Math.random().toString(36).slice(2, 6);
    await saveUserConfig({ handle: generatedHandle });
  }

  // Persist last used server and ensure it's present in saved list (but do NOT auto-connect on startup)
  const saved = Array.isArray(userConfig.savedServers) ? userConfig.savedServers : [];
  const key = `${serverIp}:${port}`;
  const exists = saved.some(s => `${(s.ip||s.host)}:${Number(s.port)}` === key);
  const nextSaved = exists ? saved : [{ ip: serverIp, port }, ...saved].slice(0, 30);
  await saveUserConfig({ username, lastServer: { ip: serverIp, port }, autoConnect: false, savedServers: nextSaved });
  localStorage.setItem('my-advertised-ip', myRadminIp);

  const connectBtn = $('connect-btn');
  if (connectBtn) connectBtn.disabled = true;
  serverStatusTxt.textContent = 'подключение...';
  tbStatus.classList.remove('connected');

  loadScript(`http://${serverIp}:${port}/socket.io/socket.io.js`, (err) => {
    if (err || typeof io !== 'function') {
      connectInFlight = false;
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      scheduleReconnectLoop();
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

      socket.emit('register', {
        userId: myUserId,
        hiddenId: myHiddenId,
        radminIp: myRadminIp,
        identityPublicKey: identityInfo?.publicKey || null,
        sessionToken,
        nickname: userConfig.handle || username,
        avatarUrl: userConfig.avatarDataUrl || null,
        inCall: false,
      });

      myNameEl.textContent   = username;
      myStatusEl.textContent = '● online';
      myStatusEl.className   = 'my-av-status online';
      applyAvatar();
      closeConnectModal();
      toast(`✓ Подключён как ${username}`);
      renderServerTabs();
      chatSyncTimer = setTimeout(() => syncAllChatsFromServer(), 450);
    });

    socket.on('connect_error', () => {
      serverStatusTxt.textContent = 'ошибка';
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      connectInFlight = false;
      scheduleReconnectLoop();
    });

    socket.on('disconnect', () => {
      serverStatusTxt.textContent = 'отключён';
      tbStatus.classList.remove('connected');
      if (connectBtn) connectBtn.disabled = false;
      myStatusEl.textContent = '● offline';
      myStatusEl.className   = 'my-av-status';
      onlinePeers = [];
      activePeer  = null;
      chatView.classList.add('hidden');
      welcomeScreen.classList.remove('hidden');
      renderServerTabs();
      renderSidebar();
      connectInFlight = false;
      // Clean up any active call silently
      if (videoOverlay?.classList?.contains?.('visible')) cleanupCall(false);
      scheduleReconnectLoop();
    });

    socket.on('peers-update', (peers) => {
      onlinePeers = (peers || []).map(p => ({ ...p, hiddenId: p.hiddenId || p.userId, inCallRoomId: p.inCallRoomId || null }));
      onlinePeers.forEach(p => {
        const key = p.hiddenId || p.userId;
        const tab = chatTabs.get(key);
        if (tab) {
          tab.peer.nickname     = p.nickname     || tab.peer.nickname;
          tab.peer.radminIp     = p.radminIp     || tab.peer.radminIp;
          tab.peer.avatarUrl    = p.avatarUrl    || tab.peer.avatarUrl;
          tab.peer.inCall       = p.inCall;
          tab.peer.inCallRoomId = p.inCallRoomId || null;
        }
      });
      updateJoinCallBanner();
      if (currentNavTab === 'peers') renderSidebar();
    });

    socket.on('peer-offline', ({ userId }) => {
      if (activePeer?.userId === userId) addSystemMsg(`${lookupName(userId)} отключился`);
    });

    /* ── RELAY CALL SIGNALING ─────────────────────────────────── */
    socket.on('relay-call-offer', async ({ offer, from, roomId, callMode: mode, mimeType }) => {
      // Also accept legacy WebRTC offer shape for compat
      if (offer && !roomId) {
        // Legacy WebRTC path (ignore — we don't support it in v3)
        return;
      }
      incomingCallData = { from, roomId, callMode: mode, mimeType };
      const displayName = peerDisplayName(from);
      bannerFrom.textContent = `от ${displayName} (${from?.radminIp || ''})`;
      callBanner.classList.add('visible');
      if (userConfig.notifyCalls !== false) window.electronAPI?.notifyCall?.({ from });
      startIncomingRing();
    });

    socket.on('relay-call-answer', ({ from, roomId, accepted, mimeType }) => {
      stopOutgoingRing();
      if (!accepted) {
        addSystemMsg('Звонок отклонён');
        cleanupCall(false);
        return;
      }
      // Peer accepted — they'll start sending media; player created on first relay-media chunk
      addSystemMsg(`${lookupName(from?.hiddenId)} принял звонок`);
      // Попробовать поднять P2P с собеседником
      const hid = from?.hiddenId || from?.userId;
      if (hid) startP2PWithPeer(hid);
    });

    socket.on('relay-call-end', ({ from, roomId, reason }) => {
      if (reason === 'timeout') addSystemMsg('Звонок завершён');
      else if (from) addSystemMsg(`${lookupName(from.hiddenId || from.userId)} завершил звонок`);
      cleanupCall(false);
    });

    /* ── RELAY MEDIA ──────────────────────────────────────────── */
    socket.on('relay-media', ({ roomId, kind, mimeType, chunk, hiddenId }) => {
      if (!chunk) return;
      const hid = hiddenId || 'remote';
      const effKind = (kind === 'screen' || kind === 'video' || kind === 'audio') ? kind : 'audio';
      const makeKey = (k) => `${hid}:${k}`;

      if (effKind === 'audio') {
        const k = makeKey('audio');
        if (!remoteRelayPlayers[k]) {
          const effMime = mimeType || getBestMimeType('audio');
          remoteRelayPlayers[k] = new RelayPlayer('audio', effMime);
          remoteRelayPlayers[k]._peerHiddenId = hid;
          applyStreamVolumeToPlayers();
        }
        remoteRelayPlayers[k].push(chunk);
        return;
      }

      // Visual (video/screen) — only one can be bound to remoteVideo at a time
      const prevKind = remoteVisualKind[hid];
      if (prevKind && prevKind !== effKind) {
        const prevKey = makeKey(prevKind);
        if (remoteRelayPlayers[prevKey]) {
          remoteRelayPlayers[prevKey].destroy();
          delete remoteRelayPlayers[prevKey];
        }
      }
      remoteVisualKind[hid] = effKind;
      currentRemoteVisualHiddenId = hid;

      const vKey = makeKey(effKind);
      if (!remoteRelayPlayers[vKey]) {
        const effMime = mimeType || getBestMimeType('video');
        remoteRelayPlayers[vKey] = new RelayPlayer(effKind, effMime);
        videoOverlay.classList.add('visible');
        if (remoteLabel) remoteLabel.textContent = lookupName(hid);
        applyStreamVolumeToPlayers();
      }
      remoteRelayPlayers[vKey].push(chunk);
    });

    socket.on('relay-init-chunk', ({ roomId, chunk, hiddenId }) => {
      // Init chunk for late-joining — treat as regular media
      if (!chunk || !hiddenId) return;
      const hid = hiddenId;
      const visualKind = remoteVisualKind[hid];
      const candidates = [
        visualKind ? `${hid}:${visualKind}` : null,
        `${hid}:audio`,
      ].filter(Boolean);
      for (const k of candidates) {
        const p = remoteRelayPlayers[k];
        if (p) { p.push(chunk); break; }
      }
    });

    socket.on('relay-peer-joined', ({ roomId }) => {
      if (!mediaRelayRoom || !roomId) return;
      socket.emit('relay-room-members', { roomId: mediaRelayRoom }, (members) => {
        if (Array.isArray(members)) { currentCallMembers = members; updateJoinCallBanner(); }
      });
      // Автоматически инициировать P2P c новыми участниками в комнате
      ensureP2PForCurrentRoom();
    });

    socket.on('relay-peer-left', ({ hiddenId, roomId }) => {
      if (hiddenId) {
        ['audio', 'video', 'screen'].forEach(k => {
          const key = `${hiddenId}:${k}`;
          if (remoteRelayPlayers[key]) {
            remoteRelayPlayers[key].destroy();
            delete remoteRelayPlayers[key];
          }
        });
        delete remoteVisualKind[hiddenId];
      }
      if (hiddenId) {
        closePeerConnection(hiddenId);
      }
      if (roomId && mediaRelayRoom) {
        socket.emit('relay-room-members', { roomId: mediaRelayRoom }, (members) => {
          if (Array.isArray(members)) { currentCallMembers = members; updateJoinCallBanner(); }
        });
      }
    });

    /* ── FILE TRANSFER ────────────────────────────────────────── */
    socket.on('file-start', ({ transferId, name, mime, size, totalChunks, from }) => {
      incomingFiles[transferId] = { name, mime, size, totalChunks, chunks: [], received: 0, sender: from };
      const uid = normalizePeerKey(from);
      if (uid && activePeerKey() === uid) {
        addFileProgressMsg({ transferId, name, sender: from }, uid);
      }
    });

    socket.on('file-chunk', ({ transferId, index, data }) => {
      const ft = incomingFiles[transferId];
      if (!ft) return;
      ft.chunks[index] = data;
      ft.received++;
      updateFileProgress(transferId, ft.received, ft.totalChunks);
      if (ft.received === ft.totalChunks) {
        finalizeFile(transferId, { ...ft, uid: normalizePeerKey(ft.sender) });
      }
    });

    /* ── CHAT ─────────────────────────────────────────────────── */
    socket.on('chat-new', (msg) => {
      if (msg.roomType !== 'dm') return;
      const senderHidden = normalizePeerKey(msg.senderHiddenId || msg.sender);
      const peerHidden   = normalizePeerKey(msg.peerHiddenId   || msg.to || null);
      if (!senderHidden) return;
      const uid = senderHidden === myHiddenId ? peerHidden : senderHidden;
      if (!uid) return;
      const legacy = window.NexLinkCrypto?.decodeLegacyPayload?.(msg.ciphertext, msg.iv);
      const text = legacy?.text;
      const id   = legacy?.id || msg.id;
      if (!text) return;
      storeAndShowMessage(uid, { id, serverId: msg.id, text, sender: senderHidden, time: msg.time, me: senderHidden === myHiddenId });
      if (senderHidden === myHiddenId && id) setMessageStatus(uid, id, 'delivered');
      if (senderHidden !== myHiddenId && activePeerKey() === uid) sendReadReceiptsForActiveChat();
      notifyIncomingMessageOnce({ uid, serverId: msg.id, msgId: id, senderHidden, text });
    });

    /* ── P2P SIGNALING (WebRTC) ───────────────────────────────── */
    socket.on('p2p-offer', async ({ from, roomId, offer } = {}) => {
      try {
        const hid = from?.hiddenId || from?.userId;
        if (!hid || !offer) return;
        const pc = getOrCreatePeerConnection(hid);
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('p2p-answer', { to: hid, answer, roomId: mediaRelayRoom || roomId || null });
      } catch (e) {
        console.warn('[P2P] handle offer error:', e?.message || e);
      }
    });

    socket.on('p2p-answer', async ({ from, roomId, answer } = {}) => {
      try {
        const hid = from?.hiddenId || from?.userId;
        if (!hid || !answer) return;
        const pc = rtcPeers.get(hid);
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (e) {
        console.warn('[P2P] handle answer error:', e?.message || e);
      }
    });

    socket.on('p2p-ice', async ({ from, roomId, candidate } = {}) => {
      try {
        const hid = from?.hiddenId || from?.userId;
        if (!hid || !candidate) return;
        const pc = getOrCreatePeerConnection(hid);
        if (!pc) return;
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[P2P] handle ice error:', e?.message || e);
      }
    });

    socket.on('p2p-close', ({ from } = {}) => {
      const hid = from?.hiddenId || from?.userId;
      if (hid) closePeerConnection(hid);
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
  return url.startsWith('/') ? serverBaseUrl + url : url;
}

function loadScript(src, cb) {
  if (document.querySelector(`script[src="${src}"]`)) { cb?.(null); return; }
  const s = document.createElement('script');
  s.src    = src;
  s.onload = () => cb?.(null);
  s.onerror = () => { toast('✗ Не удалось загрузить socket.io с сервера'); cb?.(new Error('load failed')); };
  document.head.appendChild(s);
}

/* ─── LOCAL SERVER ───────────────────────────────────────── */
async function startLocalHost() {
  const port = Number((hostPortInp?.value || serverPortInp?.value || '7345').trim()) || 7345;
  const res  = await window.electronAPI?.startSignalingServer?.(port);
  if (!res?.ok) { toast(`✗ Сервер не запустился: ${res?.error||'ошибка'}`); return; }
  if (hostStopBtn)   hostStopBtn.disabled = false;
  if (serverIpInp)   serverIpInp.value   = '127.0.0.1';
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

/* ═══════════════════════════════════════════════════════════
   MEDIA HELPERS
   ═══════════════════════════════════════════════════════════ */
function buildAudioConstraints() {
  const audioDeviceId = userConfig.audioInputDeviceId;
  return {
    noiseSuppression: !!userConfig.noiseSuppression,
    echoCancellation: !!userConfig.echoCancellation,
    autoGainControl:  !!userConfig.autoGainControl,
    ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
  };
}

async function ensureMicStream() {
  const audioConstraints = buildAudioConstraints();
  if (micStream && micStream.getAudioTracks().some(t => t.readyState === 'live')) return micStream;
  micStream?.getTracks?.().forEach(t => { try { t.stop(); } catch {} });
  micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  return micStream;
}

async function getMediaStream(mode) {
  if (mode === 'audio') {
    return ensureMicStream();
  }

  if (mode === 'video') {
    // Camera only. Microphone is relayed via separate 'audio' stream.
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { width: 1280, height: 720 } });
  }

  if (mode === 'screen') {
    let displayStream = null;
    try {
      // Capture system audio if enabled and supported
      const wantSysAudio = userConfig.screenSystemAudio !== false;
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: !!wantSysAudio });
    } catch (err) {
      if (window.electronAPI?.getDesktopSources) {
        const sources = await window.electronAPI.getDesktopSources({ types: ['screen','window'] });
        const source  = sources.find(s => s.id) || sources[0];
        if (source?.id) {
          const wantSysAudio = userConfig.screenSystemAudio !== false;
          displayStream = await navigator.mediaDevices.getUserMedia({
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
            audio: wantSysAudio ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } } : false,
          });
        }
      }
      if (!displayStream) throw err;
    }
    return displayStream;
  }

  throw new Error(`Unknown call mode: ${mode}`);
}

/* ─── RELAY RECORDER ─────────────────────────────────────── */
function stopRelayRecorder(kind) {
  const rec = mediaRelayRecorders?.[kind];
  if (rec) {
    try { rec.stop(); } catch {}
  }
  if (mediaRelayRecorders) mediaRelayRecorders[kind] = null;
  if (relayInitFirst) relayInitFirst[kind] = true;
}

function stopAllRelayRecorders() {
  ['audio', 'video', 'screen'].forEach(k => stopRelayRecorder(k));
}

function startRelayRecorder(kind, roomId, stream) {
  if (!stream || !roomId) return;
  stopRelayRecorder(kind);

  const hasAudio = stream.getAudioTracks().length > 0;
  const hasVideo = stream.getVideoTracks().length > 0;
  let mimeType = '';
  if (kind === 'audio') {
    mimeType = getBestMimeType('audio');
  } else if (hasAudio) {
    mimeType = getBestMimeType('video');
  } else {
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }
  if (!mimeType) { toast('✗ Ваш браузер не поддерживает MediaRecorder'); return; }
  mediaRelayMimeTypes[kind] = mimeType;
  relayInitFirst[kind] = true;

  const opts = {
    mimeType,
    ...(hasAudio ? { audioBitsPerSecond: 64000 } : {}),
    ...(hasVideo ? {
      videoBitsPerSecond: kind === 'screen'
        ? Math.round(clamp(Number(userConfig.screenBitrateKbps) || 900, 200, 4000) * 1000)
        : Math.round(clamp(Number(userConfig.videoBitrateKbps)  || 600, 200, 4000) * 1000),
    } : {}),
  };

  let recorder;
  try {
    recorder = new MediaRecorder(stream, opts);
  } catch (e) {
    toast('✗ Не удалось запустить запись: ' + (e?.message || ''));
    return;
  }

  recorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0 || !socket?.connected) return;
    try {
      const buf = await e.data.arrayBuffer();
      const first = !!relayInitFirst[kind];
      relayInitFirst[kind] = false;
      socket.emit('relay-media', { roomId, kind, mimeType, isInit: first, chunk: buf });
    } catch {}
  };
  recorder.onerror = (e) => console.error('[RelayRecorder] error:', e);
  recorder.start(120);
  mediaRelayRecorders[kind] = recorder;
}

/* ═══════════════════════════════════════════════════════════
   CALL FUNCTIONS (relay-based)
   ═══════════════════════════════════════════════════════════ */
async function startCall(mode) {
  if (!activePeer) { toast('Выберите собеседника'); return; }
  if (!socket?.connected) { toast('Нет подключения к серверу'); return; }

  callMode = mode;
  if (mode !== 'screen') lastVisualMode = mode;
  try {
    await ensureMicStream();
    localStream = (mode === 'audio') ? null : await getMediaStream(mode);
  } catch (err) {
    toast('✗ ' + (err?.name === 'NotAllowedError' ? 'Доступ запрещён. Разрешите захват в системных настройках.' : (err?.message || 'Нет доступа к устройству')));
    return;
  }

  try { localVideo.srcObject = localStream || null; } catch {}
  videoOverlay.classList.add('visible');
  if (isMuted) applyMicMuteStateToStreams();
  startSpeakingDetection(micStream);

  const roomId = genRelayRoomId(myHiddenId, activePeer.hiddenId || activePeer.userId);
  mediaRelayRoom = roomId;

  // Join relay room and signal peer
  socket.emit('relay-join', { roomId });
  socket.emit('relay-call-offer', {
    to: activePeer.hiddenId || activePeer.userId,
    roomId,
    callMode: mode,
    mimeType: getBestMimeType(mode === 'audio' ? 'audio' : 'video'),
    from: { userId: myUserId, hiddenId: myHiddenId, nickname: userConfig.username, radminIp: myRadminIp },
  });

  // Start sending media immediately (mic is always separate)
  startRelayRecorder('audio', roomId, micStream);
  stopRelayRecorder('video');
  stopRelayRecorder('screen');
  if (localStream && mode !== 'audio') startRelayRecorder(mode, roomId, localStream);
  // If user stops screen sharing via OS UI — fall back
  if (mode === 'screen') {
    const vt = localStream?.getVideoTracks?.()?.[0];
    if (vt) vt.onended = () => { if (callMode === 'screen') switchCallMode(lastVisualMode || 'audio'); };
  }

  socket.emit('call-state', { inCall: true });
  audioCallBtn?.classList.add('active');
  videoCallBtn?.classList.add('active');
  updateCallModeButtons();
  startOutgoingRing();
  // Refresh room members after peer joins (server now uses canonical roomId)
  const refreshRoomMembers = () => {
    if (!mediaRelayRoom || !socket?.connected) return;
    socket.emit('relay-room-members', { roomId: mediaRelayRoom }, (members) => {
      if (Array.isArray(members)) { currentCallMembers = members; updateJoinCallBanner(); }
    });
  };
  setTimeout(refreshRoomMembers, 800);
  setTimeout(refreshRoomMembers, 2500);
}

async function acceptCall() {
  callBanner.classList.remove('visible');
  stopIncomingRing();
  if (!incomingCallData) return;
  const { from, roomId, callMode: mode, mimeType: remoteMime } = incomingCallData;
  callMode  = mode || 'audio';
  if (callMode !== 'screen') lastVisualMode = callMode;
  mediaRelayRoom = roomId;

  const key = from.hiddenId || from.userId;
  if (!activePeer || activePeer.hiddenId !== key) {
    activePeer = { ...from, hiddenId: key };
    if (!chatTabs.has(key)) chatTabs.set(key, { peer: activePeer, messages: [], connected: false });
    welcomeScreen.classList.add('hidden');
    chatView.classList.remove('hidden');
    const displayName = peerDisplayName(activePeer);
    chatAvatar.innerHTML = initials(displayName);
    chatPeerName.textContent = displayName;
    chatPeerSub.textContent  = activePeer.radminIp || '';
    if (remoteLabel) remoteLabel.textContent = displayName;
  }

  try {
    await ensureMicStream();
    localStream = (callMode === 'audio') ? null : await getMediaStream(callMode);
  } catch (err) {
    toast('✗ ' + (err?.message || 'Нет доступа к микрофону/устройству'));
    return;
  }

  try { localVideo.srcObject = localStream || null; } catch {}
  if (isMuted) applyMicMuteStateToStreams();
  startSpeakingDetection(micStream);

  // Answer peer
  socket.emit('relay-call-answer', {
    to: key,
    roomId,
    accepted: true,
    mimeType: getBestMimeType(callMode === 'audio' ? 'audio' : 'video'),
  });

  // Join room and start sending
  socket.emit('relay-join', { roomId });
  startRelayRecorder('audio', roomId, micStream);
  stopRelayRecorder('video');
  stopRelayRecorder('screen');
  if (localStream && callMode !== 'audio') startRelayRecorder(callMode, roomId, localStream);
  if (callMode === 'screen') {
    const vt = localStream?.getVideoTracks?.()?.[0];
    if (vt) vt.onended = () => { if (callMode === 'screen') switchCallMode(lastVisualMode || 'audio'); };
  }

  videoOverlay.classList.add('visible');
  socket.emit('call-state', { inCall: true });
  updateCallModeButtons();
  addSystemMsg(`Принят звонок от ${peerDisplayName(from)}`);
  incomingCallData = null;
  renderSidebar();
  socket.emit('relay-room-members', { roomId }, (members) => {
    if (Array.isArray(members)) { currentCallMembers = members; updateJoinCallBanner(); }
  });
  setTimeout(() => {
    if (!mediaRelayRoom || !socket?.connected) return;
    socket.emit('relay-room-members', { roomId: mediaRelayRoom }, (members) => {
      if (Array.isArray(members)) { currentCallMembers = members; updateJoinCallBanner(); }
    });
  }, 600);
  updateJoinCallBanner();
}

function rejectCall() {
  callBanner.classList.remove('visible');
  if (incomingCallData) {
    socket?.emit('relay-call-end', { to: incomingCallData.from?.hiddenId || incomingCallData.from?.userId, roomId: incomingCallData.roomId });
    incomingCallData = null;
  }
  stopIncomingRing();
}

function endCall() {
  if (activePeer && socket?.connected) {
    socket.emit('relay-call-end', {
      to: activePeer.hiddenId || activePeer.userId,
      roomId: mediaRelayRoom,
    });
  }
  cleanupCall(false);
}

/**
 * cleanupCall — tear down everything call-related
 * @param {boolean} [notify=false] — emit relay-call-end to peer (set false if peer already ended)
 */
function cleanupCall(notify = false) {
  if (notify && activePeer && socket?.connected && mediaRelayRoom) {
    socket.emit('relay-call-end', { to: activePeer.hiddenId || activePeer.userId, roomId: mediaRelayRoom });
  }

  // Stop recorders
  stopAllRelayRecorders();

  // Leave relay room
  if (mediaRelayRoom && socket?.connected) {
    socket.emit('relay-leave', { roomId: mediaRelayRoom });
  }
  mediaRelayRoom = null;

  // Close all P2P connections
  closeAllPeerConnections();

  // Destroy all remote players
  Object.values(remoteRelayPlayers).forEach(p => { try { p.destroy(); } catch {} });
  remoteRelayPlayers = {};
  remoteVisualKind = {};
  relayInitFirst = { audio: true, video: true, screen: true };

  // Stop local stream
  localStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
  localStream = null;
  // Fully stop mic stream at the very end of the call
  if (micStream) {
    micStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    micStream = null;
  }
  try { localVideo.srcObject = null; } catch {}
  try { remoteVideo.srcObject = null; remoteVideo.src = ''; } catch {}

  stopSpeakingDetection();
  videoOverlay.classList.remove('visible');
  videoOverlay.style.left = videoOverlay.style.top = videoOverlay.style.bottom = videoOverlay.style.width = videoOverlay.style.height = '';

  audioCallBtn?.classList.remove('active');
  videoCallBtn?.classList.remove('active');
  isMuted = false; isCamOff = false;

  const miIcon  = muteBtn?.querySelector('i');
  const camIcon = camBtn?.querySelector('i');
  if (miIcon)  miIcon.className  = 'fas fa-microphone';
  if (camIcon) camIcon.className = 'fas fa-video';

  stopOutgoingRing();
  stopIncomingRing();
  window.electronAPI?.closeCallOverlay?.();
  callMode = null;
  lastVisualMode = 'audio';
  socket?.emit?.('call-state', { inCall: false });
  updateJoinCallBanner();
}

async function switchCallMode(mode) {
  if (!activePeer || !mediaRelayRoom || callMode === mode) return;
  if (mode === 'screen' && callMode && callMode !== 'screen') lastVisualMode = callMode;

  let newStream = null;
  if (mode !== 'audio') {
    try {
      newStream = await getMediaStream(mode);
    } catch (err) {
      toast('✗ ' + (err?.message || 'Не удалось переключить режим'));
      return;
    }
  }

  const oldStream = localStream;
  localStream = newStream;
  try { localVideo.srcObject = newStream || null; } catch {}

  // Keep mic stream alive and relayed separately
  if (!micStream || !micStream.getAudioTracks().some(t => t.readyState === 'live')) {
    try { await ensureMicStream(); } catch {}
  }
  if (micStream) startRelayRecorder('audio', mediaRelayRoom, micStream);
  if (isMuted) applyMicMuteStateToStreams();

  if (mode === 'audio') {
    stopRelayRecorder('video');
    stopRelayRecorder('screen');
    callMode = 'audio';
  } else if (mode === 'video') {
    stopRelayRecorder('screen');
    startRelayRecorder('video', mediaRelayRoom, newStream);
    callMode = 'video';
    lastVisualMode = 'video';
  } else if (mode === 'screen') {
    stopRelayRecorder('video');
    startRelayRecorder('screen', mediaRelayRoom, newStream);
    callMode = 'screen';
    const vt = newStream?.getVideoTracks?.()?.[0];
    if (vt) vt.onended = () => { if (callMode === 'screen') switchCallMode(lastVisualMode || 'audio'); };
  }

  updateCallModeButtons();

  if (oldStream && oldStream !== newStream) {
    oldStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  }
}

function updateCallModeButtons() {
  ['audio', 'video', 'screen'].forEach(m => {
    const btn = $('mode-' + m + '-btn');
    if (btn) btn.classList.toggle('active', callMode === m);
  });
}

/* ─── MIC / CAMERA / HEADPHONES ─────────────────────────── */
function toggleMute()    { setMicMuted(!isMuted); }
function toggleGlobalMic() { setMicMuted(!isMuted); }

function applyMicMuteStateToStreams() {
  micStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
}

function updateMicIcons() {
  const cls = isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
  const oi = muteBtn?.querySelector('i');
  const ni = navMicBtn?.querySelector('i');
  if (oi) oi.className = cls;
  if (ni) ni.className = cls;
}

function setMicMuted(muted) {
  isMuted = muted;
  applyMicMuteStateToStreams();
  updateMicIcons();
  if (navMicBtn) navMicBtn.classList.toggle('muted', isMuted);
}

function toggleCamera() {
  if (!localStream || callMode !== 'video') return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const icon = camBtn?.querySelector('i');
  if (icon) icon.className = isCamOff ? 'fas fa-video-slash' : 'fas fa-video';
}

function toggleHeadphones() {
  isHeadphonesMuted = !isHeadphonesMuted;
  applyStreamVolumeToPlayers();
  const icon = navHeadphonesBtn?.querySelector('i');
  if (icon) icon.className = isHeadphonesMuted ? 'fas fa-headphones-simple' : 'fas fa-headphones';
  if (navHeadphonesBtn) navHeadphonesBtn.classList.toggle('muted', isHeadphonesMuted);
}

function applyStreamVolumeToPlayers() {
  const vol = (typeof userConfig.streamVolume === 'number' && isFinite(userConfig.streamVolume))
    ? Math.max(0, Math.min(1, userConfig.streamVolume))
    : 1;

  const pv = (hid) => {
    const map = (userConfig && typeof userConfig.peerVolumes === 'object' && userConfig.peerVolumes) ? userConfig.peerVolumes : {};
    const raw = map?.[hid];
    const n = (typeof raw === 'number' && isFinite(raw)) ? raw : 1;
    return Math.max(0, Math.min(2, n));
  };

  try {
    remoteVideo.muted = isHeadphonesMuted;
    const vhid = currentRemoteVisualHiddenId;
    remoteVideo.volume = isHeadphonesMuted ? 0 : (vol * (vhid ? pv(vhid) : 1));
  } catch {}
  Object.values(remoteRelayPlayers).forEach(p => {
    if (!p?.el || p.el === remoteVideo) return;
    try {
      let peerVol = 1;
      if (typeof p._peerHiddenId === 'string' && p._peerHiddenId) peerVol = pv(p._peerHiddenId);
      p.el.muted = isHeadphonesMuted;
      p.el.volume = isHeadphonesMuted ? 0 : (vol * peerVol);
    } catch {}
  });
}

function isScreenVisibleNow() {
  // Local screen mode or remote visual kind is screen
  if (callMode === 'screen') return true;
  const hid = currentRemoteVisualHiddenId;
  if (hid && remoteVisualKind && remoteVisualKind[hid] === 'screen') return true;
  return false;
}

function showScreenVolWidgetTemporarily() {
  if (!screenVolWidget) return;
  if (!isScreenVisibleNow()) { screenVolWidget.classList.remove('show'); return; }
  screenVolWidget.classList.add('show');
  if (screenVolHideTimer) clearTimeout(screenVolHideTimer);
  screenVolHideTimer = setTimeout(() => {
    screenVolWidget.classList.remove('show');
    screenVolHideTimer = null;
  }, 1200);
}

/* ─── POP-OUT WINDOWS (call overlay / screen share) ───────── */
function ensureFramePump() {
  if (framePumpTimer) return;
  frameCanvas = frameCanvas || document.createElement('canvas');
  frameCtx = frameCtx || frameCanvas.getContext('2d', { alpha: false });
  framePumpTimer = setInterval(() => {
    try {
      const hasCall = !!callOverlayDetached;
      const hasScreen = !!screenShareDetached;
      if (!hasCall && !hasScreen) {
        clearInterval(framePumpTimer);
        framePumpTimer = null;
        return;
      }
      if (!videoOverlay?.classList?.contains?.('visible')) return;

      const v = remoteVideo;
      if (!v || v.readyState < 2 || v.videoWidth < 2 || v.videoHeight < 2) return;

      // Limit output size for performance (keep aspect ratio)
      const maxW = 980;
      const scale = Math.min(1, maxW / v.videoWidth);
      const w = Math.max(2, Math.round(v.videoWidth * scale));
      const h = Math.max(2, Math.round(v.videoHeight * scale));
      if (frameCanvas.width !== w) frameCanvas.width = w;
      if (frameCanvas.height !== h) frameCanvas.height = h;
      frameCtx.drawImage(v, 0, 0, w, h);
      const dataUrl = frameCanvas.toDataURL('image/jpeg', 0.70);

      // Screen share pop-out only when screen is visible
      if (hasScreen && isScreenVisibleNow()) window.electronAPI?.sendScreenShareFrame?.(dataUrl);
      if (hasCall) window.electronAPI?.sendCallOverlayFrame?.(dataUrl);
    } catch {}
  }, 120);
}

function detachCallOverlay() {
  // If screen-share is visible — pop out screen share, else pop out call overlay
  if (isScreenVisibleNow()) {
    screenShareDetached = true;
    window.electronAPI?.openScreenShare?.();
    ensureFramePump();
    return;
  }
  callOverlayDetached = true;
  window.electronAPI?.openCallOverlay?.();
  ensureFramePump();
}

function toggleRightPanel() {
  // Placeholder: keep panel hide/show from the UI button
  const el = document.getElementById('right-panel');
  if (!el) return;
  el.classList.toggle('hidden');
}

function toggleScreenShare() {
  if (!socket?.connected) { toast('Нет подключения'); return; }
  if (!activePeer) { toast('Выберите собеседника'); return; }
  if (!videoOverlay?.classList?.contains?.('visible')) { startCall('screen'); return; }
  if (callMode === 'screen') switchCallMode(lastVisualMode || 'audio');
  else { lastVisualMode = callMode || lastVisualMode || 'audio'; switchCallMode('screen'); }
}

function toggleFocusRemote() {
  videoOverlay?.classList.toggle('focus-remote');
}

async function joinPeerCall() {
  if (!activePeer || !socket?.connected) return;
  // Если уже в звонке — просто ничего не делаем
  if (videoOverlay?.classList?.contains?.('visible')) return;
  stopIncomingRing();
  const peer = onlinePeers.find(p => (p.hiddenId || p.userId) === activePeer?.hiddenId);
  const roomId = peer?.inCallRoomId || null;
  if (roomId) {
    mediaRelayRoom = roomId;
    socket.emit('relay-join', { roomId });
    // запросить у сервера полный список участников
    socket.emit('relay-room-members', { roomId }, (members) => {
      if (Array.isArray(members)) {
        currentCallMembers = members;
        updateJoinCallBanner();
      }
    });
    try { await ensureMicStream(); } catch { toast('✗ Нет доступа к микрофону'); return; }
    // Always relay mic separately
    startRelayRecorder('audio', roomId, micStream);
    if (isMuted) applyMicMuteStateToStreams();
    startSpeakingDetection(micStream);
    // Try to add camera video as visual stream
    try {
      localStream = await getMediaStream('video');
      callMode = 'video';
      lastVisualMode = 'video';
      try { localVideo.srcObject = localStream; } catch {}
      startRelayRecorder('video', roomId, localStream);
    } catch {
      localStream = null;
      callMode = 'audio';
      try { localVideo.srcObject = null; } catch {}
      stopRelayRecorder('video');
      stopRelayRecorder('screen');
    }
    videoOverlay.classList.add('visible');
    socket.emit('call-state', { inCall: true });
    updateCallModeButtons();
    addSystemMsg(`Вы вошли в звонок с ${peerDisplayName(activePeer)}`);
    updateJoinCallBanner();
    renderSidebar();
  } else {
    startCall('video');
  }
}

/* ─── SELECT PEER ─────────────────────────────────────────── */
function selectPeer(peer) {
  const key = peer.hiddenId || peer.userId;
  activePeer = { ...peer, hiddenId: key };

  if (!chatTabs.has(key)) chatTabs.set(key, { peer: activePeer, messages: [], connected: false });

  welcomeScreen.classList.add('hidden');
  chatView.classList.remove('hidden');

  const resolvedAvatar = resolveAvatarUrl(peer.avatarUrl);
  chatAvatar.innerHTML = resolvedAvatar
    ? `<img src="${escapeHtml(resolvedAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
    : initials(peerDisplayName(peer));
  chatPeerName.textContent = peerDisplayName(peer);
  chatPeerSub.textContent  = (peer.radminIp || '') + ' · relay';
  if (remoteLabel) remoteLabel.textContent = peerDisplayName(peer);

  messagesEl.innerHTML = '';
  const tab = chatTabs.get(key);
  (tab?.messages || []).forEach(m => {
    if (m.fileMsg) appendFileMessageEl(m.fileMsg, m.me);
    else appendMessageEl(m.text, m.me, m.sender, m.time, m.id, m.status);
  });

  msgInput.disabled = !socket?.connected;
  sendBtn.disabled  = !socket?.connected;

  fetchChatHistoryFromServer(key);
  sendReadReceiptsForActiveChat();
  updateJoinCallBanner();
  renderSidebar();
}

function updateJoinCallBanner() {
  const banner = $('join-call-banner');
  const avatarEl = $('join-call-avatar');
  if (!banner) return;
  const peer = onlinePeers.find(p => (p.hiddenId || p.userId) === activePeer?.hiddenId);
  const show = !!(activePeer && peer?.inCall);
  banner.classList.toggle('hidden', !show);
  if (show && avatarEl) {
    // Render all participants pills (including self if в комнате)
    const pills = [];
    const members = Array.isArray(currentCallMembers) ? currentCallMembers : [];
    const seen = new Set();
    members.forEach(m => {
      const hid = m.hiddenId || m.userId;
      if (!hid || seen.has(hid)) return;
      seen.add(hid);
      const av = resolveAvatarUrl(m.avatarUrl);
      const label = m.nickname || lookupName(hid);
      pills.push(
        av
          ? `<div class="pill"><img src="${escapeHtml(av)}" alt="${escapeHtml(label)}"></div>`
          : `<div class="pill">${initials(label)}</div>`
      );
    });
    // Если сервер пока не вернул список — хотя бы показать собеседника
    if (!pills.length && peer) {
      const av = resolveAvatarUrl(peer.avatarUrl);
      pills.push(
        av
          ? `<div class="pill"><img src="${escapeHtml(av)}" alt="${escapeHtml(peerDisplayName(peer))}"></div>`
          : `<div class="pill">${initials(peerDisplayName(peer))}</div>`
      );
    }
    avatarEl.innerHTML = pills.join('');
  }
}

/* ─── CHAT SEND ───────────────────────────────────────────── */
function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !activePeer || !socket?.connected) return;

  const msgId  = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const msgObj = { id: msgId, text, me: true, sender: myHiddenId, time: timeStr(), status: 'pending' };
  const peerKey = activePeer.hiddenId || activePeer.userId;

  let tab = chatTabs.get(peerKey);
  if (!tab) { chatTabs.set(peerKey, { peer: activePeer, messages: [], connected: false }); tab = chatTabs.get(peerKey); }
  tab.messages.push(msgObj);
  persistChatTabs();

  // Encode with UTF-8 safe method — handles Russian/emoji/any Unicode
  let ciphertext = '';
  try {
    if (window.NexLinkCrypto?.encodeLegacyPayload) {
      ciphertext = window.NexLinkCrypto.encodeLegacyPayload({ text, id: msgId });
    } else {
      // UTF-8 safe fallback (no btoa(jsonStr) which breaks on non-ASCII)
      const bytes = new TextEncoder().encode(JSON.stringify({ text, id: msgId }));
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      ciphertext = btoa(bin);
    }
  } catch { ciphertext = ''; }

  if (!ciphertext) { toast('✗ Не удалось закодировать сообщение'); return; }

  const iv = btoa(String.fromCharCode(...new Uint8Array(12)));
  socket.emit('chat-send', { roomType: 'dm', roomId: peerKey, to: peerKey, ciphertext, iv, clientMsgId: msgId }, (ack) => {
    if (ack?.ok) {
      // Обновляем timestamp на серверный (общий для всех клиентов)
      const tab2 = chatTabs.get(peerKey);
      if (tab2?.messages?.length) {
        const m = tab2.messages.find(x => x?.id === msgId && x?.me);
        if (m && ack.time) {
          m.time = ack.time;
          persistChatTabs();
          if (activePeerKey() === peerKey) {
            const el = messagesEl?.querySelector?.(`.msg[data-msg-id="${CSS.escape(String(msgId))}"] .msg-meta`);
            if (el) el.childNodes[0].textContent = formatTimeHHMMSS(ack.time);
          }
        }
      }
      setMessageStatus(peerKey, msgId, 'delivered');
    }
  });

  appendMessageEl(text, true, myHiddenId, msgObj.time, msgId, msgObj.status);
  msgInput.value = '';
  msgInput.style.height = 'auto';
}

function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 110) + 'px';
}

/* ─── READ RECEIPTS ──────────────────────────────────────── */
function sendReadReceiptsForActiveChat() {
  const uid = activePeerKey();
  if (!uid || !socket?.connected) return;
  const tab = chatTabs.get(uid);
  if (!tab?.messages?.length) return;
  const ids = [];
  for (const m of tab.messages) {
    if (!m || m.me || !m.id) continue;
    const key = `${uid}:${m.id}`;
    if (readSentIds.has(key)) continue;
    readSentIds.add(key);
    ids.push(m.id);
  }
  if (ids.length) socket.emit('chat-read', { peerHiddenId: uid, messageIds: ids });
}

/* ─── MESSAGE STORAGE & STATUS ───────────────────────────── */
function activePeerKey() { return activePeer ? (activePeer.hiddenId || activePeer.userId) : null; }

function normalizeMsgStatus(s) { return ['pending','delivered','read'].includes(s) ? s : null; }
function statusIconHtml(s) {
  if (s === 'pending') return '<i class="far fa-clock msg-status-icon" title="Отправка"></i>';
  if (s === 'delivered') return '<i class="fas fa-check msg-status-icon" title="Доставлено"></i>';
  if (s === 'read') return '<i class="fas fa-check-double msg-status-icon" title="Прочитано"></i>';
  return '';
}

function setMessageStatus(uid, msgId, status) {
  const st = normalizeMsgStatus(status);
  if (!uid || !msgId || !st) return;
  const tab = chatTabs.get(uid);
  if (!tab?.messages?.length) return;
  const m = tab.messages.find(x => x?.id === msgId && x?.me);
  if (!m) return;
  const rank = { pending: 0, delivered: 1, read: 2 };
  const cur = normalizeMsgStatus(m.status);
  if (cur && rank[cur] >= rank[st]) return;
  m.status = st;
  persistChatTabs();
  if (activePeerKey() === uid) {
    const wrap = messagesEl?.querySelector?.(`.msg[data-msg-id="${CSS.escape(String(msgId))}"] .msg-status-wrap`);
    if (wrap) wrap.innerHTML = statusIconHtml(st);
  }
}

function storeAndShowMessage(uid, msgObj) {
  let tab = chatTabs.get(uid);
  if (!tab) {
    const peer = onlinePeers.find(p => (p.hiddenId||p.userId) === uid) || { userId: uid, hiddenId: uid, radminIp: 'unknown' };
    tab = { peer, messages: [], connected: false };
    chatTabs.set(uid, tab);
  }
  if (msgObj?.id   && tab.messages.some(m => m?.id       === msgObj.id))       return;
  if (msgObj?.serverId != null && tab.messages.some(m => m?.serverId === msgObj.serverId)) return;
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
      const peer = onlinePeers.find(p => (p.hiddenId||p.userId) === uid) || { userId: uid, hiddenId: uid, radminIp: 'unknown' };
      tab = { peer, messages: [], connected: false };
      chatTabs.set(uid, tab);
    }
    const ids       = new Set(tab.messages.map(m => m?.id).filter(Boolean));
    const serverIds = new Set(tab.messages.map(m => m?.serverId).filter(v => v != null));
    serverMessages.forEach(m => {
      if (m?.id != null && serverIds.has(m.id)) return;
      let text = m.text;
      if (!text && m.ciphertext && window.NexLinkCrypto?.decodeLegacyPayload) {
        const legacy = window.NexLinkCrypto.decodeLegacyPayload(m.ciphertext, m.iv);
        if (legacy) text = legacy.text;
      }
      if (!text) return;
      let stableId = m.id;
      if (m.ciphertext && window.NexLinkCrypto?.decodeLegacyPayload) {
        const legacy = window.NexLinkCrypto.decodeLegacyPayload(m.ciphertext, m.iv);
        if (legacy?.id) stableId = legacy.id;
      }
      if (stableId && ids.has(stableId)) return;
      if (stableId) ids.add(stableId);
      if (m?.id != null) serverIds.add(m.id);
      const me = m.sender === myHiddenId;
      tab.messages.push({ id: stableId, serverId: m.id, text, sender: m.sender, time: m.time, me, status: me ? 'delivered' : undefined });
    });
    tab.messages.sort((a,b) => String(a?.time||'').localeCompare(String(b?.time||'')));
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
      peer: { userId: tab.peer.userId, hiddenId: tab.peer.hiddenId||uid, radminIp: tab.peer.radminIp, nickname: tab.peer.nickname||null, avatarUrl: tab.peer.avatarUrl||null },
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
        peer: { userId: entry.peer.userId, hiddenId: entry.peer.hiddenId||key, radminIp: entry.peer.radminIp||'unknown', nickname: entry.peer.nickname||null, avatarUrl: entry.peer.avatarUrl||null },
        messages: Array.isArray(entry.messages) ? entry.messages : [],
        connected: false,
      });
    });
  } catch {}
}

/* ─── FILE TRANSFER (via server relay) ──────────────────── */
function openFilePicker() { if (!fileInput) return; fileInput.value = ''; fileInput.click(); }

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (!fileInput.files?.length) return;
    Array.from(fileInput.files).forEach(sendFile);
  });
}

async function sendFile(file) {
  if (!activePeer) return;
  if (!socket?.connected) { toast('Нет подключения к серверу'); return; }
  if (file.size > 50 * 1024 * 1024) { toast('Файл слишком большой (макс 50MB)'); return; }

  const peerKey    = activePeer.hiddenId || activePeer.userId;
  const transferId = genId();
  const dataUrl    = await readFileAsDataURL(file);
  const base64     = dataUrl.split(',')[1];
  const totalChunks = Math.ceil(base64.length / (FILE_CHUNK * 4 / 3 | 0 + 1)); // approx base64 chunk count

  socket.emit('file-start', { to: peerKey, transferId, name: file.name, mime: file.type||'application/octet-stream', size: file.size, totalChunks });

  const chunkLen = Math.ceil(base64.length / totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const data = base64.slice(i * chunkLen, (i+1) * chunkLen);
    socket.emit('file-chunk', { to: peerKey, transferId, index: i, data });
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 20));
  }

  const fileMsg = { transferId, sender: myHiddenId, name: file.name, mime: file.type, size: file.size, dataUrl };
  appendFileMessageEl(fileMsg, true);
  const tab = chatTabs.get(peerKey);
  if (tab) { tab.messages.push({ fileMsg, me: true, time: timeStr() }); persistChatTabs(); }
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
    <div class="msg-av">${initials(msg.sender || '?')}</div>
    <div class="msg-body">
      <div class="file-progress-wrap">
        <div class="file-progress-name">${escapeHtml(msg.name)}</div>
        <div class="file-progress-bar-bg"><div class="file-progress-bar" id="fpb_${msg.transferId}" style="width:0%"></div></div>
        <div class="file-progress-pct" id="fpp_${msg.transferId}">0%</div>
      </div>
    </div>`;
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
  const base64  = ft.chunks.join('');
  const dataUrl = `data:${ft.mime};base64,${base64}`;
  const fileMsg = { transferId, sender: ft.sender, name: ft.name, mime: ft.mime, size: ft.size, dataUrl };
  const el = $('fp_' + transferId);
  if (el) el.remove();
  appendFileMessageEl(fileMsg, false);
  const tab = chatTabs.get(ft.uid || normalizePeerKey(ft.sender));
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
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'msg' + (isMe ? ' me' : '');
  if (msgId) div.dataset.msgId = String(msgId);

  let avatarHtml;
  if (isMe) {
    avatarHtml = userConfig.avatarPath ? `<img src="${escapeHtml(userConfig.avatarPath)}" alt="me">` : initials(userConfig.username || 'Я');
  } else {
    const peerUid = sender || activePeer?.hiddenId || activePeer?.userId;
    const peer    = chatTabs.get(peerUid)?.peer || onlinePeers.find(p => (p.hiddenId||p.userId) === peerUid);
    const peerAvatar = resolveAvatarUrl(peer?.avatarUrl);
    avatarHtml = peerAvatar ? `<img src="${escapeHtml(peerAvatar)}" alt="peer">` : initials(peerDisplayName(peer) || '?');
  }

  const effStatus  = isMe ? (normalizeMsgStatus(status) || 'delivered') : null;
  const statusHtml = isMe ? `<span class="msg-status-wrap">${statusIconHtml(effStatus)}</span>` : '';

  div.innerHTML = `
    <div class="msg-av">${avatarHtml}</div>
    <div class="msg-body">
      <div class="msg-bubble">${escapeHtml(text)}</div>
      <div class="msg-meta">${escapeHtml(formatTimeHHMMSS(time))}${statusHtml}</div>
    </div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendFileMessageEl(fileMsg, isMe) {
  const div = document.createElement('div');
  div.className = 'msg' + (isMe ? ' me' : '');
  let avatarHtml;
  if (isMe) {
    avatarHtml = userConfig.avatarPath ? `<img src="${escapeHtml(userConfig.avatarPath)}" alt="me">` : initials(userConfig.username || 'Я');
  } else {
    const peer = activePeer;
    const pa = resolveAvatarUrl(peer?.avatarUrl);
    avatarHtml = pa ? `<img src="${escapeHtml(pa)}" alt="peer">` : initials(peerDisplayName(peer) || '?');
  }
  const isImage = (fileMsg.mime||'').startsWith('image/');
  const safeName = escapeHtml(fileMsg.name || 'file');
  const url  = fileMsg.dataUrl || '#';
  const size = fileMsg.size ? ` · ${(fileMsg.size/1024).toFixed(1)} KB` : '';
  let preview;
  if (isImage) {
    preview = `<img src="${url}" alt="${safeName}" class="file-img" onclick="openLightbox(this.src)" />`;
  } else {
    const iconMap = { 'application/pdf':'fa-file-pdf', 'application/zip':'fa-file-zipper', 'text/plain':'fa-file-lines' };
    preview = `<i class="fas ${iconMap[fileMsg.mime] || 'fa-file'}" style="font-size:24px;margin-bottom:6px;display:block"></i>`;
  }
  div.innerHTML = `
    <div class="msg-av">${avatarHtml}</div>
    <div class="msg-body">
      <div class="msg-bubble file">
        <a class="file-link" href="${url}" download="${safeName}">${preview}</a>
        <div class="file-meta">${safeName}${size}</div>
      </div>
      <div class="msg-meta">${timeStr()}</div>
    </div>`;
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
  const lb = $('lightbox'), img = $('lightbox-img');
  if (!lb || !img) return;
  img.src = src;
  lb.classList.add('visible');
}
function closeLightbox() { $('lightbox')?.classList.remove('visible'); }

/* ─── SETTINGS ───────────────────────────────────────────── */
async function openSettings() { await openSettingsTab('profile'); }
function closeSettings()      { settingsModal?.classList.remove('visible'); }

function setSettingsTab(tab, btnEl = null) {
  const t = String(tab || 'profile');
  const pages = {
    profile: settingsPageProfile,
    audio: settingsPageAudio,
    screen: settingsPageScreen,
    notifications: settingsPageNotif,
  };
  Object.entries(pages).forEach(([k, el]) => {
    if (!el) return;
    el.classList.toggle('hidden', k !== t);
  });
  if (settingsTitleEl) {
    const map = {
      profile: '<i class="fas fa-user"></i> Профиль',
      audio: '<i class="fas fa-microphone"></i> Звук',
      screen: '<i class="fas fa-desktop"></i> Демонстрация',
      notifications: '<i class="fas fa-bell"></i> Уведомления',
    };
    settingsTitleEl.innerHTML = map[t] || map.profile;
  }
  if (btnEl) {
    try {
      settingsModal?.querySelectorAll?.('.nav-tab')?.forEach?.(b => b.classList.remove('active'));
      btnEl.classList.add('active');
    } catch {}
  }
}

async function openSettingsTab(tab = 'profile') {
  await fillAudioDeviceLists();
  settingsModal?.classList.add('visible');
  setSettingsTab(tab);
  // Sync left nav active state
  try {
    const btns = settingsModal?.querySelectorAll?.('.nav-tab') || [];
    btns.forEach(b => b.classList.remove('active'));
    // Best-effort: find by onclick string
    const match = Array.from(btns).find(b => String(b.getAttribute('onclick') || '').includes(`setSettingsTab('${tab}'`));
    (match || btns[0])?.classList?.add?.('active');
  } catch {}
  // Populate profile inputs when opening
  if (tab === 'profile') {
    applyAvatar();
    if (usernameInp) usernameInp.value = userConfig.username || 'User';
    const handleInp = $('handle-inp');
    const bioInp    = $('bio-inp');
    if (handleInp) handleInp.value = userConfig.handle || '';
    if (bioInp)    bioInp.value    = userConfig.bio || '';
  }
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
  if (!deviceId) return;
  try {
    if (typeof remoteVideo?.setSinkId === 'function') remoteVideo.setSinkId(deviceId).catch(() => {});
  } catch {}
  Object.values(remoteRelayPlayers).forEach(p => {
    if (typeof p.el.setSinkId === 'function') p.el.setSinkId(deviceId).catch(() => {});
  });
}

async function testAudioInput() {
  const deviceId = audioInputSelect?.value;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId }, noiseSuppression: !!userConfig.noiseSuppression, echoCancellation: !!userConfig.echoCancellation } : true,
      video: false,
    });
    stream.getTracks().forEach(t => setTimeout(() => t.stop(), 1500));
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

/* ═══════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  (async () => {
    await refreshLocalIps();
    await loadUserConfig();
    try {
      identityInfo = await window.electronAPI?.getIdentity?.();
      if (identityInfo?.userId) myUserId = identityInfo.userId;
    } catch {}
    applyIdentityToUI();
    loadChatTabsFromStorage();
    applyConfigToUI();
    renderSidebar();

    // Prevent horizontal scroll in chat area
    if (messagesEl) {
      messagesEl.style.overflowX = 'hidden';
      messagesEl.addEventListener('wheel', e => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
      }, { passive: false });
    }

    // Close modals on backdrop click
    ['connect-modal','settings-modal'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('click', e => { if (e.target === el) el.classList.remove('visible'); });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeLightbox(); closeSettings(); closeConnectModal(); closeProfileModal(); return; }
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.code === 'KeyI')) window.electronAPI?.openDevTools?.();
    });

    // Context menu events
    if (ctxVol) {
      ctxVol.addEventListener('input', () => {
        const hid = ctxPeerHiddenId;
        if (!hid) return;
        const pct = clamp(Number(ctxVol.value) || 0, 0, 200);
        const vol = pct / 100;
        if (ctxVolVal) ctxVolVal.textContent = `${pct}%`;
        setPeerVolumeLocal(hid, vol);
      });
      ctxVol.addEventListener('change', () => persistPeerVolumes());
    }
    ctxResetBtn?.addEventListener('click', () => {
      const hid = ctxPeerHiddenId;
      if (!hid) return;
      setPeerVolumeLocal(hid, 1);
      if (ctxVol) ctxVol.value = '100';
      if (ctxVolVal) ctxVolVal.textContent = '100%';
      persistPeerVolumes();
    });
    ctxCloseBtn?.addEventListener('click', () => closePeerContextMenu());
    document.addEventListener('pointerdown', (e) => {
      if (!ctxMenu?.classList?.contains('visible')) return;
      if (e.target && ctxMenu.contains(e.target)) return;
      closePeerContextMenu();
    });

    // Audio input device change
    if (audioInputSelect) {
      audioInputSelect.addEventListener('change', async () => {
        await saveUserConfig({ audioInputDeviceId: audioInputSelect.value || null });
      });
    }

    // Audio output device change
    if (audioOutputSelect) {
      audioOutputSelect.addEventListener('change', async () => {
        const val = audioOutputSelect.value || null;
        await saveUserConfig({ audioOutputDeviceId: val });
        if (val) await applyOutputDevice(val);
      });
    }
    if (userConfig.audioOutputDeviceId) applyOutputDevice(userConfig.audioOutputDeviceId);

    // Stream volume (remote)
    if (streamVolumeRange) {
      const v = (typeof userConfig.streamVolume === 'number' && isFinite(userConfig.streamVolume)) ? userConfig.streamVolume : 1;
      streamVolumeRange.value = String(Math.round(Math.max(0, Math.min(1, v)) * 100));
      streamVolumeRange.addEventListener('input', async () => {
        const pct = Math.max(0, Math.min(100, Number(streamVolumeRange.value) || 0));
        const vol01 = pct / 100;
        await saveUserConfig({ streamVolume: vol01 });
        applyStreamVolumeToPlayers();
      });
      applyStreamVolumeToPlayers();
    }

    // Screen-share volume widget: show when mouse near bottom-right
    if (remoteVideoWrap && screenVolWidget) {
      const NEAR = 150;
      remoteVideoWrap.addEventListener('mousemove', (e) => {
        if (!isScreenVisibleNow()) { screenVolWidget.classList.remove('show'); return; }
        const r = remoteVideoWrap.getBoundingClientRect();
        const dx = r.right - e.clientX;
        const dy = r.bottom - e.clientY;
        if (dx >= 0 && dy >= 0 && dx < NEAR && dy < NEAR) {
          screenVolWidget.classList.add('show');
          if (screenVolHideTimer) { clearTimeout(screenVolHideTimer); screenVolHideTimer = null; }
        } else {
          showScreenVolWidgetTemporarily();
        }
      });
      remoteVideoWrap.addEventListener('mouseleave', () => {
        if (screenVolHideTimer) { clearTimeout(screenVolHideTimer); screenVolHideTimer = null; }
        screenVolWidget.classList.remove('show');
      });
    }

    if (noiseSuppToggle) {
      noiseSuppToggle.checked = !!userConfig.noiseSuppression;
      noiseSuppToggle.addEventListener('change', async () => saveUserConfig({ noiseSuppression: !!noiseSuppToggle.checked }));
    }
    if (echoCancToggle) {
      echoCancToggle.checked = !!userConfig.echoCancellation;
      echoCancToggle.addEventListener('change', async () => saveUserConfig({ echoCancellation: !!echoCancToggle.checked }));
    }
    if (autoGainToggle) {
      autoGainToggle.checked = !!userConfig.autoGainControl;
      autoGainToggle.addEventListener('change', async () => saveUserConfig({ autoGainControl: !!autoGainToggle.checked }));
    }
    if (speechThreshRange) {
      speechThreshRange.value = String(typeof userConfig.speechThreshold === 'number' ? userConfig.speechThreshold : 0.05);
      speechThreshRange.addEventListener('input', async () => saveUserConfig({ speechThreshold: Number(speechThreshRange.value) || 0.05 }));
    }

    // Screen share settings
    if (screenAudioToggle) {
      screenAudioToggle.checked = userConfig.screenSystemAudio !== false;
      screenAudioToggle.addEventListener('change', async () => saveUserConfig({ screenSystemAudio: !!screenAudioToggle.checked }));
    }
    if (screenBitrateRange) {
      const v = clamp(Number(userConfig.screenBitrateKbps) || 900, 200, 4000);
      screenBitrateRange.value = String(v);
      screenBitrateRange.addEventListener('input', async () => saveUserConfig({ screenBitrateKbps: Number(screenBitrateRange.value) || 900 }));
    }
    if (videoBitrateRange) {
      const v = clamp(Number(userConfig.videoBitrateKbps) || 600, 200, 4000);
      videoBitrateRange.value = String(v);
      videoBitrateRange.addEventListener('input', async () => saveUserConfig({ videoBitrateKbps: Number(videoBitrateRange.value) || 600 }));
    }

    // Notifications
    if (notifMsgToggle) {
      notifMsgToggle.checked = userConfig.notifyMessages !== false;
      notifMsgToggle.addEventListener('change', async () => saveUserConfig({ notifyMessages: !!notifMsgToggle.checked }));
    }
    if (notifCallToggle) {
      notifCallToggle.checked = userConfig.notifyCalls !== false;
      notifCallToggle.addEventListener('change', async () => saveUserConfig({ notifyCalls: !!notifCallToggle.checked }));
    }

    // Overlay call window events (Electron)
    if (window.electronAPI) {
      window.electronAPI.onCallOverlayClosed?.(() => { callOverlayDetached = false; });
      window.electronAPI.onScreenShareClosed?.(() => { screenShareDetached = false; });
    }

    // Video overlay drag
    if (videoOverlay) {
      videoOverlay.addEventListener('mousedown', e => {
        if (e.target.closest('.video-controls') || e.target.closest('.overlay-resize-handle')) return;
        overlayDrag.active = true;
        const rect = videoOverlay.getBoundingClientRect();
        overlayDrag.offsetX = e.clientX - rect.left;
        overlayDrag.offsetY = e.clientY - rect.top;
        if (!videoOverlay.style.left) {
          videoOverlay.style.right = 'auto'; videoOverlay.style.bottom = 'auto';
          videoOverlay.style.left = rect.left + 'px'; videoOverlay.style.top = rect.top + 'px';
        }
        e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!overlayDrag.active) return;
        const rect = videoOverlay.getBoundingClientRect();
        const x = e.clientX - overlayDrag.offsetX, y = e.clientY - overlayDrag.offsetY;
        const maxX = window.innerWidth - Math.max(rect.width, 200);
        const maxY = window.innerHeight - Math.max(rect.height, 100);
        videoOverlay.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        videoOverlay.style.top  = `${Math.max(0, Math.min(y, maxY))}px`;
      });
      document.addEventListener('mouseup', () => { overlayDrag.active = false; });
      videoOverlay.addEventListener('dblclick', e => {
        if (e.target.closest('.video-controls')) return;
        videoOverlay.classList.toggle('large');
      });
    }

    // Local server exit event (Electron hosting mode)
    if (window.electronAPI?.onSignalingExit) {
      window.electronAPI.onSignalingExit(() => {
        if (socket) { try { socket.disconnect(); } catch {} socket = null; }
        cleanupCall(false);
        onlinePeers = []; activePeer = null;
        chatView.classList.add('hidden');
        welcomeScreen.classList.remove('hidden');
        serverStatusTxt.textContent = 'сервер выключен';
        tbStatus.classList.remove('connected');
        renderSidebar();
      });
    }

    // Port inputs
    if (serverPortInp && !serverPortInp.value) serverPortInp.value = '7345';
    if (hostPortInp   && !hostPortInp.value)   hostPortInp.value   = '7345';

    // Discovery
    try { await window.electronAPI?.startDiscovery?.(); } catch {}
    if (!discoveryUnsub) {
      discoveryUnsub = window.electronAPI?.onDiscoveryUpdate?.((list) => {
        discoveredServers = Array.isArray(list) ? list : [];
        renderServerTabs();
      });
    }

    // Restore last server
    if (userConfig.lastServer?.ip   && serverIpInp)   serverIpInp.value   = userConfig.lastServer.ip;
    if (userConfig.lastServer?.port) {
      const p = String(userConfig.lastServer.port);
      if (serverPortInp) serverPortInp.value = p;
      if (hostPortInp)   hostPortInp.value   = p;
      const fp = $('footer-port-inp');
      if (fp) fp.value = p;
    }

    // By default: stay disconnected. User chooses a server from the left rail.
    renderServerTabs();
  })();
});