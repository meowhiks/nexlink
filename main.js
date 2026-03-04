// ╔══════════════════════════════════════════════════════════╗
// ║  NexLink P2P Messenger — Electron Main v2.0             ║
// ╚══════════════════════════════════════════════════════════╝

const { app, BrowserWindow, ipcMain, dialog, nativeImage, session, desktopCapturer, Notification } = require('electron');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const fsp    = fs.promises;
const crypto = require('crypto');
const dgram  = require('dgram');
const { spawn } = require('child_process');

let mainWindow = null;
let callOverlayWindow = null;
let serverProcess = null;

// ── LAN discovery (UDP) ───────────────────────────────────────
const DISCOVERY_UDP_PORT = 7345;
const DISCOVERY_MAGIC = 'nexlink:v1';
let discovery = null;

function ipv4ToInt(ip) {
  const p = String(ip || '').split('.').map(n => Number(n) >>> 0);
  if (p.length !== 4 || p.some(n => !Number.isFinite(n))) return null;
  return ((p[0] << 24) >>> 0) + ((p[1] << 16) >>> 0) + ((p[2] << 8) >>> 0) + (p[3] >>> 0);
}

function intToIpv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function getBroadcastAddresses() {
  const ifaces = os.networkInterfaces();
  const out = new Set(['255.255.255.255']);
  for (const name of Object.keys(ifaces)) {
    for (const info of (ifaces[name] || [])) {
      if (!info || info.family !== 'IPv4' || info.internal) continue;
      const ipInt = ipv4ToInt(info.address);
      const maskInt = ipv4ToInt(info.netmask || '255.255.255.0');
      if (ipInt == null || maskInt == null) continue;
      const bcast = (ipInt | (~maskInt >>> 0)) >>> 0;
      out.add(intToIpv4(bcast));
    }
  }
  return Array.from(out);
}

function sendDiscoveryUpdate() {
  if (!mainWindow || !discovery) return;
  const now = Date.now();
  const list = Array.from(discovery.peers.values())
    .filter(p => (now - p.lastSeenMs) < 15000)
    .map(p => ({ ip: p.ip, port: p.port, label: p.label, hostname: p.hostname, lastSeenMs: p.lastSeenMs }))
    .sort((a,b) => (a.label || '').localeCompare(b.label || '') || (a.ip + ':' + a.port).localeCompare(b.ip + ':' + b.port));
  mainWindow.webContents.send('discovery-update', list);
}

function discoveryDiscover() {
  if (!discovery?.sock) return;
  const payload = Buffer.from(JSON.stringify({
    magic: DISCOVERY_MAGIC, type: 'discover', want: 'signaling', ts: Date.now(),
  }), 'utf8');
  const addrs = getBroadcastAddresses();
  for (const addr of addrs) {
    try { discovery.sock.send(payload, 0, payload.length, DISCOVERY_UDP_PORT, addr); } catch {}
  }
}

function startDiscovery() {
  if (discovery) return;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  discovery = { sock, peers: new Map(), timers: [] };

  sock.on('message', (msg, rinfo) => {
    let parsed = null;
    try { parsed = JSON.parse(String(msg || '')); } catch { return; }
    if (!parsed || parsed.magic !== DISCOVERY_MAGIC) return;
    if (parsed.type === 'discover') return;
    if (parsed.type === 'announce') {
      const tcpPort = Number(parsed.tcpPort);
      if (!tcpPort || tcpPort < 1 || tcpPort > 65535) return;
      const key = `${rinfo.address}:${tcpPort}`;
      discovery.peers.set(key, {
        ip: rinfo.address, port: tcpPort,
        label: `${rinfo.address}:${tcpPort}`,
        hostname: String(parsed.hostname || ''),
        lastSeenMs: Date.now(),
      });
      sendDiscoveryUpdate();
    }
  });

  sock.on('error', () => {});
  sock.bind(0, '0.0.0.0', () => {
    try { sock.setBroadcast(true); } catch {}
    discoveryDiscover();
  });

  discovery.timers.push(setInterval(() => discoveryDiscover(), 3000));
  discovery.timers.push(setInterval(() => sendDiscoveryUpdate(), 2000));
}

function stopDiscovery() {
  if (!discovery) return;
  for (const t of discovery.timers) clearInterval(t);
  discovery.timers = [];
  try { discovery.sock.close(); } catch {}
  discovery = null;
}

// ── Cache relocation ──────────────────────────────────────────
try {
  const tempBase = path.join(app.getPath('temp'), 'nexlink-electron');
  app.commandLine.appendSwitch('disk-cache-dir',  path.join(tempBase, 'Cache'));
  app.commandLine.appendSwitch('media-cache-dir', path.join(tempBase, 'MediaCache'));
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
} catch {}

// ── Window ────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    frame: false,
    transparent: false,
    backgroundColor: '#030305',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      preload:                path.join(__dirname, 'preload.js'),
      contextIsolation:       true,
      nodeIntegration:        false,
      webSecurity:            false,
      allowRunningInsecureContent: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    closeCallOverlayWindow();
  });
}

// ── Call overlay window ────────────────────────────────────────
function closeCallOverlayWindow() {
  if (callOverlayWindow && !callOverlayWindow.isDestroyed()) {
    callOverlayWindow.close();
    callOverlayWindow = null;
  }
  mainWindow?.webContents?.send?.('call-overlay-closed');
}

function createCallOverlayWindow() {
  if (callOverlayWindow && !callOverlayWindow.isDestroyed()) {
    callOverlayWindow.focus();
    return;
  }

  callOverlayWindow = new BrowserWindow({
    width: 520,
    height: 400,
    minWidth: 320,
    minHeight: 240,
    frame: true,               // native frame — позволяет ресайз и перетаскивание за пределы
    titleBarStyle: 'default',
    transparent: false,
    backgroundColor: '#0a0a0c',
    alwaysOnTop: true,
    resizable: true,           // ← ресайз как обычное окно Windows
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    parent: null,              // ← независимое окно, можно выносить за пределы
    webPreferences: {
      preload: path.join(__dirname, 'preload-call-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  callOverlayWindow.setMenuBarVisibility(false);
  callOverlayWindow.setTitle('NexLink — Звонок');
  callOverlayWindow.loadFile(path.join(__dirname, 'public', 'call-overlay.html'));
  callOverlayWindow.once('ready-to-show', () => {
    callOverlayWindow.show();
  });
  callOverlayWindow.on('closed', () => {
    callOverlayWindow = null;
    mainWindow?.webContents?.send?.('call-overlay-closed');
  });

  mainWindow?.webContents?.send?.('call-overlay-opened');
}

app.whenReady().then(() => {
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const screen = sources.find(s => s.id && String(s.id).startsWith('screen:')) || sources[0];
        if (screen?.id) callback({ video: screen });
        else callback({});
      } catch { callback({}); }
    });
  } catch {}
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', async () => {
  if (serverProcess) { try { serverProcess.kill('SIGTERM'); } catch {} serverProcess = null; }
  try { stopDiscovery(); } catch {}
});

// ── Config helpers ────────────────────────────────────────────
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    console.error('readConfig:', err);
    return {};
  }
}

async function writeConfig(cfg) {
  const filePath = getConfigPath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const payload = (cfg && typeof cfg === 'object') ? cfg : {};
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

// ── IPC: Local IPs ────────────────────────────────────────────
ipcMain.handle('net-get-local-ips', () => {
  const ifaces = os.networkInterfaces();
  const ips = new Set(['127.0.0.1']);
  for (const name of Object.keys(ifaces)) {
    for (const info of (ifaces[name] || [])) {
      if (info?.family === 'IPv4' && info.address) ips.add(info.address);
    }
  }
  return Array.from(ips);
});

// ── IPC: Signaling server ─────────────────────────────────────
ipcMain.handle('signaling-start', async (_e, { port } = {}) => {
  if (serverProcess) return { ok: true, port: 7345, alreadyRunning: true };
  const desiredPort = Number(port || 7345);
  try {
    const serverPath = path.join(__dirname, 'server', 'index.js');
    serverProcess = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(desiredPort) },
      cwd: path.join(__dirname, 'server'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess.on('error', (err) => console.error('server spawn error:', err));
    serverProcess.on('exit', () => {
      serverProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('signaling-server-exited');
      }
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 1500);
      serverProcess.once('error', () => { clearTimeout(t); reject(new Error('Spawn failed')); });
    });
    try { startDiscovery(); } catch {}
    return { ok: true, port: desiredPort };
  } catch (err) {
    serverProcess = null;
    return { ok: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('signaling-stop', async () => {
  if (!serverProcess) return { ok: true, alreadyStopped: true };
  serverProcess.kill('SIGTERM');
  serverProcess = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('signaling-server-exited');
  }
  return { ok: true };
});

// ── IPC: DevTools ──────────────────────────────────────────────
ipcMain.on('devtools-open', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.openDevTools({ mode: 'detach' });
});

// ── IPC: Discovery ────────────────────────────────────────────
ipcMain.handle('discovery-start', async () => {
  try { startDiscovery(); return { ok: true, udpPort: DISCOVERY_UDP_PORT }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('discovery-stop', async () => {
  try { stopDiscovery(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

ipcMain.handle('discovery-scan', async () => {
  try { startDiscovery(); discoveryDiscover(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ── IPC: Config ───────────────────────────────────────────────
ipcMain.handle('config-load', async () => {
  try { return await readConfig(); }
  catch (err) { return { __error: String(err?.message || err) }; }
});

ipcMain.handle('config-save', async (_e, config) => {
  try { await writeConfig((config && typeof config === 'object') ? config : {}); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
});

// ── IPC: Avatar picker ────────────────────────────────────────
ipcMain.handle('dialog-open-avatar', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выбрать аватар',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp'] }],
  });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
});

// ── IPC: Identity ─────────────────────────────────────────────
ipcMain.handle('identity-get', async () => {
  let cfg = await readConfig();
  if (!cfg.identity?.userId || !cfg.identity?.publicKey) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding:  { type: 'spki',  format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const userId = 'u_' + crypto.randomBytes(8).toString('hex');
    cfg.identity = {
      userId,
      publicKey:  publicKey.toString('base64'),
      privateKey: privateKey.toString('base64'),
    };
    await writeConfig(cfg);
  }
  return { userId: cfg.identity.userId, publicKey: cfg.identity.publicKey };
});

// ── IPC: Window controls ──────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// ── IPC: Incoming call notification ──────────────────────────
ipcMain.on('incoming-call-notify', (_e, { from }) => {
  if (!mainWindow) return;
  mainWindow.flashFrame(true);
  setTimeout(() => mainWindow.flashFrame(false), 3000);
  if (!mainWindow.isFocused()) mainWindow.show();
  try {
    const title = 'Входящий звонок';
    const body  = from?.nickname || from?.userId || 'Новый звонок';
    new Notification({ title, body }).show();
  } catch {}
});

// ── IPC: System notifications ──────────────────────────────────
ipcMain.on('notify-message', (_e, { title, body } = {}) => {
  try {
    new Notification({
      title: title || 'Новое сообщение',
      body:  body  || '',
    }).show();
  } catch {}
});

// ── IPC: Call overlay ─────────────────────────────────────────
ipcMain.on('call-overlay-open', () => createCallOverlayWindow());
ipcMain.on('call-overlay-close', () => closeCallOverlayWindow());

// Direct video frame forwarding (renderer → overlay window)
// renderer.js captures video element via canvas and sends JPEG dataUrl
ipcMain.on('call-overlay-frame', (_e, dataUrl) => {
  if (!callOverlayWindow || callOverlayWindow.isDestroyed()) return;
  callOverlayWindow.webContents.send('call-overlay-frame', dataUrl);
});

// Legacy capturePage approach (kept for backward compat)
ipcMain.on('call-overlay-capture', async (_e, { x, y, width, height } = {}) => {
  if (!mainWindow || !callOverlayWindow || callOverlayWindow.isDestroyed()) return;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return;
  try {
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    if (rect.width < 10 || rect.height < 10) return;
    const img = await mainWindow.webContents.capturePage(rect);
    callOverlayWindow.webContents.send('call-overlay-frame', img.toDataURL());
  } catch {}
});

ipcMain.on('call-overlay-fullscreen', () => {
  if (!callOverlayWindow || callOverlayWindow.isDestroyed()) return;
  callOverlayWindow.setFullScreen(!callOverlayWindow.isFullScreen());
});