// signalingServer.js — NexLink built-in signaling server
'use strict';

const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { Server } = require('socket.io');

// Graceful dynamic port binding: if desired port is busy, try next
async function bindPort(server, desired, maxAttempts = 20) {
  let port = desired;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '0.0.0.0', resolve);
      });
      return port;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        server.removeAllListeners('error');
        port++;
      } else throw err;
    }
  }
  throw new Error(`Could not find a free port starting from ${desired}`);
}

/**
 * Start the in-process signaling server.
 * Returns { port, close }
 */
async function startSignalingServer({ port = 3000, logger = console, staticDir = null } = {}) {
  const httpServer = http.createServer((req, res) => {
    // Serve static files if staticDir is provided
    if (staticDir) {
      let filePath = path.join(staticDir, req.url === '/' ? '/index.html' : req.url);
      // Security: prevent path traversal
      if (!filePath.startsWith(path.resolve(staticDir))) {
        res.writeHead(403); res.end(); return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const extMap = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': extMap[ext] || 'application/octet-stream' });
        res.end(data);
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('NexLink signaling server OK');
    }
  });

  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e7, // 10MB max message
  });

  // peers: Map socketId → { userId, radminIp, socketId, identityPublicKey, sessionToken, nickname, avatarUrl, inCall }
  const peers = new Map();
  // chatRooms: Map roomKey → [{ id, from, to, text, time, sender }]
  const chatRooms = new Map();

  function roomKey(a, b) {
    return [a, b].sort().join('|');
  }

  io.on('connection', (socket) => {
    logger.log(`[signaling] connect ${socket.id}`);

    socket.on('register', ({ userId, hiddenId, radminIp, identityPublicKey, sessionToken, nickname, avatarUrl, inCall }) => {
      if (!userId) return;
      peers.set(socket.id, { userId, hiddenId: hiddenId || userId, radminIp, socketId: socket.id, identityPublicKey, sessionToken, nickname, avatarUrl, inCall: !!inCall });
      logger.log(`[signaling] registered ${userId} (${nickname || 'no-nick'}) @ ${radminIp}`);
      broadcastPeers(io, peers);
    });

    socket.on('call-state', ({ inCall }) => {
      const p = peers.get(socket.id);
      if (p) { p.inCall = !!inCall; broadcastPeers(io, peers); }
    });

    // Legacy: plaintext store (kept for compatibility)
    socket.on('chat-store', ({ to, from, text, time, sender, id }) => {
      if (!to || !from || !text) return;
      const key = roomKey(from, to);
      if (!chatRooms.has(key)) chatRooms.set(key, []);
      const arr = chatRooms.get(key);
      const msg = { id: id || `m_${Date.now()}_${Math.random().toString(36).slice(2)}`, from, to, text, time: time || new Date().toISOString(), sender };
      arr.push(msg);
      if (arr.length > 500) arr.splice(0, arr.length - 500);
    });

    function findPeerByHiddenId(hiddenId) {
      for (const [, peer] of peers) {
        if (peer.hiddenId === hiddenId) return peer;
      }
      return null;
    }

    // New: chat-send (ciphertext/iv), chat-history compatible with central server
    socket.on('chat-send', ({ roomType, roomId, ciphertext, iv, to, clientMsgId } = {}, cb) => {
      try {
        const me = peers.get(socket.id);
        if (!me?.hiddenId) {
          if (typeof cb === 'function') cb({ ok: false, error: 'not_online' });
          return;
        }
        const senderHiddenId = me.hiddenId;
        const peerHiddenId = to || roomId;
        if (!peerHiddenId || !ciphertext || !iv) {
          if (typeof cb === 'function') cb({ ok: false, error: 'bad_request' });
          return;
        }
        const key = roomKey(senderHiddenId, peerHiddenId);
        if (!chatRooms.has(key)) chatRooms.set(key, []);
        const arr = chatRooms.get(key);
        const serverId = `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        arr.push({
          id: serverId,
          roomType: 'dm',
          roomId: key,
          sender: senderHiddenId,
          senderHiddenId,
          peerHiddenId,
          ciphertext,
          iv,
          time: new Date().toISOString(),
        });
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        io.emit('chat-new', {
          id: serverId,
          roomType: 'dm',
          roomId: key,
          sender: senderHiddenId,
          senderHiddenId,
          peerHiddenId,
          ciphertext,
          iv,
          time: new Date().toISOString(),
        });
        if (typeof cb === 'function') cb({ ok: true, clientMsgId: clientMsgId || null, time: new Date().toISOString() });
      } catch (e) {
        if (typeof cb === 'function') cb({ ok: false, error: 'server_error' });
      }
    });

    socket.on('chat-history', ({ roomType, roomId, with: peerHiddenId } = {}, cb) => {
      const me = peers.get(socket.id);
      if (!me || !me.hiddenId || typeof cb !== 'function') return cb?.([]);
      const other = peerHiddenId || roomId;
      if (!other) return cb([]);
      const key = roomKey(me.hiddenId, other);
      const arr = chatRooms.get(key) || [];
      // Normalize legacy plaintext entries to match newer shape if needed
      const out = arr.map(m => {
        if (m && m.ciphertext) return m;
        if (!m || !m.text) return null;
        const msgId = m.id || `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const ciphertext = Buffer.from(JSON.stringify({ text: m.text, id: msgId }), 'utf8').toString('base64');
        const iv = Buffer.alloc(12, 0).toString('base64');
        return {
          id: msgId,
          roomType: 'dm',
          roomId: key,
          sender: m.sender || m.from,
          senderHiddenId: m.sender || m.from,
          peerHiddenId: m.to || other,
          ciphertext,
          iv,
          time: m.time || new Date().toISOString(),
        };
      }).filter(Boolean);
      cb(out);
    });

    socket.on('chat-read', ({ peerHiddenId, messageIds } = {}, cb) => {
      try {
        const me = peers.get(socket.id);
        if (!me?.hiddenId) {
          if (typeof cb === 'function') cb({ ok: false, error: 'not_online' });
          return;
        }
        const target = findPeerByHiddenId(peerHiddenId);
        const ids = Array.isArray(messageIds) ? messageIds.filter(Boolean).slice(0, 500) : [];
        if (!target || ids.length === 0) {
          if (typeof cb === 'function') cb({ ok: false, delivered: false });
          return;
        }
        io.to(target.socketId).emit('chat-read', { roomType: 'dm', peerHiddenId: me.hiddenId, messageIds: ids, time: new Date().toISOString() });
        if (typeof cb === 'function') cb({ ok: true, delivered: true });
      } catch {
        if (typeof cb === 'function') cb({ ok: false, error: 'server_error' });
      }
    });

    socket.on('offer', ({ to, offer, from }) => {
      const target = findPeer(peers, to);
      if (!target) return;
      const me = peers.get(socket.id);
      io.to(target.socketId).emit('offer', { offer, from: me || { userId: from } });
    });

    socket.on('answer', ({ to, answer }) => {
      const target = findPeer(peers, to);
      if (!target) return;
      io.to(target.socketId).emit('answer', { answer });
    });

    socket.on('ice-candidate', ({ to, candidate }) => {
      const target = findPeer(peers, to);
      if (!target) return;
      const me = peers.get(socket.id);
      io.to(target.socketId).emit('ice-candidate', { candidate, from: me?.userId });
    });

    socket.on('call-end', ({ to }) => {
      const target = findPeer(peers, to);
      if (!target) return;
      const me = peers.get(socket.id);
      io.to(target.socketId).emit('call-end', { from: me || { userId: 'unknown' } });
    });

    socket.on('disconnect', () => {
      const peer = peers.get(socket.id);
      if (peer) {
        logger.log(`[signaling] disconnect ${peer.userId}`);
        peers.delete(socket.id);
        io.emit('peer-offline', { userId: peer.userId, radminIp: peer.radminIp });
        broadcastPeers(io, peers);
      }
    });
  });

  const actualPort = await bindPort(httpServer, port);
  logger.log(`[signaling] server listening on :${actualPort}`);

  return {
    port: actualPort,
    close: () => new Promise((resolve, reject) => {
      io.close();
      httpServer.close(err => err ? reject(err) : resolve());
    }),
  };
}

function findPeer(peers, userId) {
  for (const [, peer] of peers) {
    if (peer.userId === userId) return peer;
  }
  return null;
}

function broadcastPeers(io, peers) {
  const list = Array.from(peers.values()).map(({ userId, radminIp, socketId, nickname, avatarUrl, inCall }) => ({ userId, radminIp, socketId, nickname, avatarUrl, inCall: !!inCall }));
  io.emit('peers-update', list);
}

module.exports = { startSignalingServer };
