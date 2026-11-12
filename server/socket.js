const crypto = require('crypto');
const { Server } = require('socket.io');
const Invite = require('../models/Invite');
const Session = require('../models/Session');
const Score = require('../models/Score');
const { callFrame, callAudio } = require('../utils/mlClient');
const { createRiskState, addScore, setVirtualCamera, setLatestChallenge, fuse } = require('../utils/risk');
const { isVirtualCamera } = require('../utils/virtualCameras');
const { createChallenge } = require('../utils/challenges');
const { recomputeSessionSummary } = require('../utils/sessionSummary');
const { createJoinLimiter } = require('../middleware');
const { verifyVerifierToken } = require('../utils/verifierToken');

const MAX_MEDIA_BYTES = 300 * 1024;
const VERIFIER_GRACE_MS = Number.isFinite(Number(process.env.VERIFIER_GRACE_MS)) && Number(process.env.VERIFIER_GRACE_MS) >= 0
  ? Number(process.env.VERIFIER_GRACE_MS)
  : 30_000;

function initializeSockets(httpServer) {
  const io = new Server(httpServer, {
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      if (!origin) return callback(null, true);
      try {
        const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0]?.trim();
        const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : 'http');
        const requestOrigin = `${protocol}://${request.headers.host}`;
        return callback(null, new URL(origin).origin === requestOrigin);
      } catch (_error) {
        return callback(null, false);
      }
    }
  });
  const rooms = new Map();
  const allowJoinAttempt = createJoinLimiter({ windowMs: 60_000, limit: 20 });

  function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        verifierId: null,
        verifierGraceTimer: null,
        ending: false,
        customerId: null,
        customerJoinKey: null,
        flags: { virtualCamera: null },
        activeChallenge: null,
        lastChallengeAt: 0,
        detection: {
          inFlight: { frame: false, audio: false },
          risk: createRiskState(),
          lastSavedAt: 0,
          detectorOnline: null,
          backend: null
        }
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function sendJoinError(socket, reason) {
    socket.emit('join-error', { reason });
  }

  async function joinRoom(socket, data) {
    if (!data || !/^[a-f0-9]{12}$/i.test(data.roomId || '')) {
      return sendJoinError(socket, 'invalid_room');
    }
    if (!['verifier', 'customer'].includes(data.role)) {
      return sendJoinError(socket, 'invalid_role');
    }
    if (data.role === 'verifier' && !verifyVerifierToken(data.verifierToken, data.roomId)) {
      return sendJoinError(socket, 'unauthorized');
    }
    if (socket.data.roomId) {
      if (socket.data.roomId === data.roomId && socket.data.role === data.role) return;
      await leaveRoom(socket);
    }

    const session = await Session.findOne({ roomId: data.roomId }).select('endedAt').lean();
    if (!session) return sendJoinError(socket, 'not_found');
    if (session.endedAt) return sendJoinError(socket, 'ended');

    let room = rooms.get(data.roomId);
    if (room?.ending) return sendJoinError(socket, 'ended');
    let joinKey;
    if (data.role === 'customer') {
      if (typeof data.token !== 'string' || !data.token) return sendJoinError(socket, 'invalid_token');
      const invite = await Invite.findOne({ token: data.token, roomId: data.roomId })
        .select('expiresAt used').lean();
      if (!invite) return sendJoinError(socket, 'invalid_token');
      if (invite.expiresAt <= new Date()) return sendJoinError(socket, 'expired');

      if (invite.used) {
        if (room?.customerId && data.joinKey !== room.customerJoinKey) {
          socket.emit('room-full');
          return;
        }
        if (!room?.customerJoinKey || data.joinKey !== room.customerJoinKey) {
          return sendJoinError(socket, 'used');
        }
        joinKey = room.customerJoinKey;
      } else {
        if (room?.customerId) {
          socket.emit('room-full');
          return;
        }
        const generatedJoinKey = crypto.randomBytes(32).toString('hex');
        const claimedInvite = await Invite.findOneAndUpdate(
          { token: data.token, roomId: data.roomId, used: false, expiresAt: { $gt: new Date() } },
          { $set: { used: true } },
          { new: true }
        ).select('_id').lean();
        if (!claimedInvite) {
          const currentInvite = await Invite.findOne({ token: data.token, roomId: data.roomId })
            .select('expiresAt').lean();
          if (!currentInvite || currentInvite.expiresAt <= new Date()) {
            return sendJoinError(socket, 'expired');
          }
          return sendJoinError(socket, 'used');
        }
        room = getRoom(data.roomId);
        room.customerJoinKey = generatedJoinKey;
        joinKey = generatedJoinKey;
        room.expiresAt = invite.expiresAt;
      }
    }

    room = room || getRoom(data.roomId);
    if (room.ending) return sendJoinError(socket, 'ended');
    if (data.role === 'verifier' && room.verifierGraceTimer) {
      clearTimeout(room.verifierGraceTimer);
      room.verifierGraceTimer = null;
    }
    const slotKey = data.role === 'verifier' ? 'verifierId' : 'customerId';
    const existingSocketId = room[slotKey];
    if (existingSocketId && existingSocketId !== socket.id) {
      if (data.role !== 'customer' || data.joinKey !== room.customerJoinKey) {
        socket.emit('room-full');
        return;
      }
      if (room.verifierId) io.to(room.verifierId).emit('peer-left', { role: 'customer' });
      const previousSocket = io.sockets.sockets.get(existingSocketId);
      if (previousSocket) {
        previousSocket.data.roomId = null;
        previousSocket.data.role = null;
        previousSocket.disconnect(true);
      }
    }

    room[slotKey] = socket.id;
    socket.data.roomId = data.roomId;
    socket.data.role = data.role;
    socket.join(data.roomId);
    socket.emit('joined', data.role === 'customer' ? { role: data.role, joinKey } : { role: data.role });

    if (room.verifierId && room.customerId) {
      io.to(room.verifierId).emit('peer-joined', { role: 'customer' });
      io.to(room.customerId).emit('peer-joined', { role: 'verifier' });
      await Session.updateOne(
        { roomId: data.roomId, startedAt: null },
        { $set: { startedAt: new Date() } }
      );
      if (room.flags.virtualCamera) {
        io.to(room.verifierId).emit('camera-flag', room.flags.virtualCamera);
        emitRiskUpdate(room, null);
      }
      if (room.activeChallenge && room.activeChallenge.expiresAt > Date.now()) {
        io.to(room.customerId).emit('challenge', {
          id: room.activeChallenge.id,
          text: room.activeChallenge.text,
          expiresAt: new Date(room.activeChallenge.expiresAt).toISOString()
        });
      }
    }
  }

  async function finishVerifierRoom(roomId, room) {
    if (!room || room.ending) return;
    room.ending = true;
    if (room.verifierGraceTimer) clearTimeout(room.verifierGraceTimer);
    room.verifierGraceTimer = null;
    if (room.activeChallenge) await finishChallenge(roomId, room, 'timeout');
    await Session.updateOne({ roomId, endedAt: null }, { $set: { endedAt: new Date() } }).catch(() => {});
    await recomputeSessionSummary(roomId).catch(() => {});
    if (room.customerId) {
      const customer = io.sockets.sockets.get(room.customerId);
      io.to(room.customerId).emit('peer-left', { role: 'verifier' });
      if (customer) {
        customer.data.roomId = null;
        customer.data.role = null;
        customer.leave(roomId);
      }
    }
    if (rooms.get(roomId) === room) rooms.delete(roomId);
  }

  async function leaveRoom(socket) {
    const { roomId, role } = socket.data;
    if (!roomId || !role) return;
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    socket.data.role = null;
    socket.leave(roomId);

    if (role === 'verifier') {
      if (room?.verifierId !== socket.id) return;
      room.verifierId = null;
      await finishVerifierRoom(roomId, room);
      return;
    }

    if (room?.customerId === socket.id) {
      room.customerId = null;
      if (room.verifierId) io.to(room.verifierId).emit('peer-left', { role: 'customer' });
      if (!room.verifierId && room.expiresAt && room.expiresAt <= new Date()) rooms.delete(roomId);
    }
  }

  async function handleDisconnect(socket) {
    const { roomId, role } = socket.data;
    if (role !== 'verifier' || !roomId) return leaveRoom(socket);
    const room = rooms.get(roomId);
    socket.data.roomId = null;
    socket.data.role = null;
    if (!room || room.verifierId !== socket.id) return;
    room.verifierId = null;
    if (room.verifierGraceTimer) clearTimeout(room.verifierGraceTimer);
    if (room.customerId) io.to(room.customerId).emit('peer-reconnecting', { role: 'verifier', graceMs: VERIFIER_GRACE_MS });
    room.verifierGraceTimer = setTimeout(() => {
      finishVerifierRoom(roomId, room).catch(() => {});
    }, VERIFIER_GRACE_MS);
    if (typeof room.verifierGraceTimer.unref === 'function') room.verifierGraceTimer.unref();
  }

  function relay(socket, eventName, payload) {
    const { roomId, role } = socket.data;
    if (!roomId || !role || !payload || typeof payload !== 'object') return;
    const room = rooms.get(roomId);
    if (!room) return;
    const peerId = role === 'verifier' ? room.customerId : room.verifierId;
    if (peerId) io.to(peerId).emit(eventName, payload);
  }

  function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function detectorStatus(room, ok, reason) {
    if (room.detection.detectorOnline === ok) return;
    room.detection.detectorOnline = ok;
    if (!room.verifierId) return;
    const verifier = io.sockets.sockets.get(room.verifierId);
    if (verifier) verifier.emit('detector-status', ok ? { ok: true } : { ok: false, reason });
  }

  function emitRiskUpdate(room, clientTs = null) {
    try {
      if (!room?.verifierId) return;
      const verifier = io.sockets.sockets.get(room.verifierId);
      if (!verifier) return;
      const serverTs = Date.now();
      verifier.emit('score-update', {
        ...fuse(room.detection.risk, serverTs),
        backend: room.detection.backend,
        mock: room.detection.backend === 'mock',
        clientTs,
        serverTs
      });
    } catch (_error) {
      // Risk display updates are isolated from the call/signaling path.
    }
  }

  async function reportDevice(socket, payload) {
    try {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || socket.data.role !== 'customer' || room.customerId !== socket.id) return;
      if (!payload || typeof payload !== 'object') return;

      const activeLabel = typeof payload.activeLabel === 'string' ? payload.activeLabel.trim().slice(0, 160) : '';
      const allLabels = Array.isArray(payload.allLabels)
        ? payload.allLabels.filter((label) => typeof label === 'string').slice(0, 64).map((label) => label.trim().slice(0, 160))
        : [];
      const activeResult = isVirtualCamera(activeLabel);
      const otherVirtualPresent = allLabels.some((label) => label && label !== activeLabel && isVirtualCamera(label).flagged);
      const nextFlags = {
        flagged: activeResult.flagged,
        label: activeLabel || null,
        matched: activeResult.matched,
        otherVirtualPresent
      };
      const previous = room.flags.virtualCamera;
      const changed = !previous || previous.flagged !== nextFlags.flagged || previous.label !== nextFlags.label ||
        previous.matched !== nextFlags.matched || previous.otherVirtualPresent !== nextFlags.otherVirtualPresent;
      room.flags.virtualCamera = nextFlags;
      setVirtualCamera(room.detection.risk, nextFlags);
      if (!changed) return;

      const at = new Date();
      await Session.updateOne({ roomId }, {
        $set: { virtualCamera: { flagged: nextFlags.flagged, label: nextFlags.label, at } }
      }).catch(() => {});
      if (room.verifierId) io.to(room.verifierId).emit('camera-flag', nextFlags);
      emitRiskUpdate(room, null);
    } catch (_error) {
      // Device reports are advisory and must never interrupt the call.
    }
  }

  async function finishChallenge(roomId, room, result) {
    try {
      const challenge = room?.activeChallenge;
      if (!challenge) return;
      room.activeChallenge = null;
      if (challenge.timer) clearTimeout(challenge.timer);
      const at = new Date();
      const record = { type: challenge.type, result, at };
      if (challenge.type !== 'read_digits') record.text = challenge.text;
      await Session.updateOne({ roomId }, { $push: { challenges: record } }).catch(() => {});
      setLatestChallenge(room.detection.risk, { type: challenge.type, result });
      const payload = { id: challenge.id, result };
      if (room.customerId) io.to(room.customerId).emit('challenge-closed', payload);
      if (room.verifierId) io.to(room.verifierId).emit('challenge-closed', payload);
      emitRiskUpdate(room, null);
    } catch (_error) {
      if (room) room.activeChallenge = null;
    }
  }

  function requestChallenge(socket) {
    try {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || socket.data.role !== 'verifier' || room.verifierId !== socket.id) return;
      if (!room.customerId) return socket.emit('challenge-error', { reason: 'customer_not_connected' });
      if (room.activeChallenge) return socket.emit('challenge-error', { reason: 'active' });
      const now = Date.now();
      const cooldownMs = 5000 - (now - room.lastChallengeAt);
      if (cooldownMs > 0) return socket.emit('challenge-error', { reason: 'cooldown', retryAfterMs: cooldownMs });

      const created = createChallenge();
      const expiresAt = now + created.ttlMs;
      room.lastChallengeAt = now;
      room.activeChallenge = { ...created, expiresAt, timer: null };
      room.activeChallenge.timer = setTimeout(() => {
        finishChallenge(roomId, room, 'timeout').catch(() => {});
      }, created.ttlMs);
      if (typeof room.activeChallenge.timer.unref === 'function') room.activeChallenge.timer.unref();
      io.to(room.customerId).emit('challenge', {
        id: created.id,
        text: created.text,
        expiresAt: new Date(expiresAt).toISOString()
      });
      socket.emit('challenge-sent', {
        id: created.id,
        type: created.type,
        text: created.text,
        expiresAt: new Date(expiresAt).toISOString()
      });
    } catch (_error) {
      socket.emit('challenge-error', { reason: 'unavailable' });
    }
  }

  function submitChallengeResult(socket, payload) {
    try {
      const roomId = socket.data.roomId;
      const room = roomId && rooms.get(roomId);
      if (!room || socket.data.role !== 'verifier' || room.verifierId !== socket.id) return;
      const challenge = room.activeChallenge;
      if (!challenge || !payload || payload.id !== challenge.id || !['pass', 'fail'].includes(payload.result)) return;
      if (challenge.expiresAt <= Date.now()) {
        finishChallenge(roomId, room, 'timeout').catch(() => {});
        return;
      }
      finishChallenge(roomId, room, payload.result).catch(() => {});
    } catch (_error) {
      // Invalid challenge results are ignored.
    }
  }

  async function processMedia(socket, modality, payload) {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || socket.data.role !== 'verifier' || room.verifierId !== socket.id) return;
    if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.ts)) return;

    const media = toBuffer(payload.data);
    if (!media || media.length === 0) return;
    if (media.length > MAX_MEDIA_BYTES) {
      detectorStatus(room, false, 'payload_too_large');
      return;
    }
    if (room.detection.inFlight[modality]) return;

    room.detection.inFlight[modality] = true;
    try {
      const result = modality === 'frame' ? await callFrame(media) : await callAudio(media);
      const currentRoom = rooms.get(roomId);
      if (currentRoom !== room || room.verifierId !== socket.id || !socket.connected) return;
      detectorStatus(room, true);
      room.detection.backend = result.backend;
      const receivedAt = Date.now();
      const signal = modality === 'frame' ? 'face' : 'audio';
      addScore(room.detection.risk, signal, result, receivedAt);
      const combined = fuse(room.detection.risk, receivedAt);
      const scoreUpdate = {
        ...combined,
        backend: result.backend,
        mock: result.backend === 'mock',
        clientTs: payload.ts,
        serverTs: receivedAt
      };
      socket.emit('score-update', scoreUpdate);

      if (receivedAt - room.detection.lastSavedAt >= 1000) {
        room.detection.lastSavedAt = receivedAt;
        const scoreDocument = new Score({
          roomId,
          ts: new Date(receivedAt),
          audio: combined.audio,
          face: combined.face,
          risk: combined.risk,
          label: combined.label,
          reasons: combined.reasons.map((item) => item.text),
          backend: result.backend
        });
        try {
          await scoreDocument.save();
          await recomputeSessionSummary(roomId);
        } catch (_error) {
          // A summary failure must not stop the live call.
        }
      }
    } catch (error) {
      const currentRoom = rooms.get(roomId);
      if (currentRoom === room && room.verifierId === socket.id && socket.connected) {
        const reason = error.code === 'timeout' ? 'timeout' : 'service_unavailable';
        detectorStatus(room, false, reason);
      }
    } finally {
      room.detection.inFlight[modality] = false;
    }
  }

  io.on('connection', (socket) => {
    socket.on('join-room', (data) => {
      if (!allowJoinAttempt(socket.handshake.address || 'unknown')) return sendJoinError(socket, 'rate_limited');
      joinRoom(socket, data).catch(() => sendJoinError(socket, 'server_error'));
    });
    socket.on('offer', (payload) => relay(socket, 'offer', payload));
    socket.on('answer', (payload) => relay(socket, 'answer', payload));
    socket.on('ice', (payload) => relay(socket, 'ice', payload));
    socket.on('frame', (payload) => { processMedia(socket, 'frame', payload).catch(() => {}); });
    socket.on('audio', (payload) => { processMedia(socket, 'audio', payload).catch(() => {}); });
    socket.on('device-report', (payload) => { reportDevice(socket, payload).catch(() => {}); });
    socket.on('challenge-request', () => requestChallenge(socket));
    socket.on('challenge-result', (payload) => submitChallengeResult(socket, payload));
    socket.on('leave', () => { leaveRoom(socket).catch(() => {}); });
    socket.on('disconnect', () => { handleDisconnect(socket).catch(() => {}); });
  });

  return io;
}

module.exports = { initializeSockets };
