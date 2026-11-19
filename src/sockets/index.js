const {
  Server
} = require('socket.io');

const {
  verifyAccessToken,
  tokenVersionMatches
} = require('../services/auth.service.js');

const {
  findUserById
} = require('../models/users.model.js');

const {
  env
} = require('../config/env.js');

let ioInstance = null;

// Sockets are push-only here: the server emits notifications/status changes
// into rooms, and no client→server event is handled anywhere. So the
// handshake is the whole attack surface, and it's held to the same rules as
// the REST API (middleware/auth.js#requireAuth), plus connection throttles.
const HANDSHAKES_PER_IP_PER_MINUTE = 30;
const MAX_CONNECTIONS_PER_USER = 10;

const handshakeCounts = new Map(); // ip -> { count, windowStart }
const connectionsPerUser = new Map(); // userId -> open socket count

// Client IP behind the one trusted reverse proxy (same trust model as
// app.js's `trust proxy`, 1): the proxy appends the real client address as
// the last X-Forwarded-For entry, so earlier entries — which a client can
// write itself — are ignored.
function clientIp(socket) {
  const forwarded = String(socket.handshake.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : socket.handshake.address;
}

function tooManyHandshakes(ip) {
  const now = Date.now();
  const entry = handshakeCounts.get(ip);
  if (!entry || now - entry.windowStart > 60 * 1000) {
    handshakeCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > HANDSHAKES_PER_IP_PER_MINUTE;
}

// Drop stale throttle entries so the map can't grow without bound.
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, entry] of handshakeCounts) if (entry.windowStart < cutoff) handshakeCounts.delete(ip);
}, 5 * 60 * 1000).unref();

function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
    // No client→server payloads are expected, so keep the frame limit tiny
    // (socket.io's default is 1MB).
    maxHttpBufferSize: 16 * 1024,
    connectTimeout: 10 * 1000,
  });

  io.use(async (socket, next) => {
    if (tooManyHandshakes(clientIp(socket))) {
      return next(new Error('rate_limited'));
    }
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) {
      return next(new Error('unauthorized'));
    }
    try {
      const claims = verifyAccessToken(token);
      // Narrow-purpose tokens (itinerary PDF, admin MFA) share the access
      // secret but are never valid for a session — same rule as requireAuth.
      if (claims.purpose) return next(new Error('unauthorized'));
      const user = await findUserById(claims.sub);
      if (!user || user.status !== 'active' || !tokenVersionMatches(claims, user)) {
        return next(new Error('unauthorized'));
      }
      if ((connectionsPerUser.get(user.id) || 0) >= MAX_CONNECTIONS_PER_USER) {
        return next(new Error('too_many_connections'));
      }
      // Rooms come from the database row, never from token claims or
      // anything the client sends, so a client can't place itself in another
      // agency's or role's room.
      socket.data.userId = user.id;
      socket.data.role = user.role;
      socket.data.agencyId = user.agency_id;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    connectionsPerUser.set(userId, (connectionsPerUser.get(userId) || 0) + 1);
    socket.on('disconnect', () => {
      const left = (connectionsPerUser.get(userId) || 1) - 1;
      if (left > 0) connectionsPerUser.set(userId, left);
      else connectionsPerUser.delete(userId);
    });

    socket.join(`user:${socket.data.userId}`);

    if (socket.data.agencyId) {
      socket.join(`agency:${socket.data.agencyId}`);
    } else if (socket.data.role) {
      socket.join('staff');
      socket.join(`role:${socket.data.role}`);
    }

    socket.emit('connected', { userId: socket.data.userId });
  });

  ioInstance = io;
  return io;
}

module.exports.initSockets = initSockets;

function getIo() {
  return ioInstance;
}

module.exports.getIo = getIo;
