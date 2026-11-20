require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map((origin) => origin.trim()).filter(Boolean);

const hosted = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
if (hosted && (!allowedOrigins.length || allowedOrigins.some(value => {
  const url = new URL(value);
  return url.protocol !== 'https:' || url.origin !== value;
}))) throw new Error('Configure explicit HTTPS frontend origins in CLIENT_ORIGIN.');
const acceptsOrigin = (origin) => !origin || !allowedOrigins.length || allowedOrigins.includes(origin);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });
  if (hosted) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (!acceptsOrigin(req.headers.origin)) return res.sendStatus(403);
  next();
});
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
  }),
);
// In production only the trusted TLS terminator may reach this listener.
app.set('trust proxy', process.env.TRUSTED_PROXY || 'loopback');
const trustProxy = app.get('trust proxy fn');
const secureTransport = (req) => req.socket.encrypted ||
  (trustProxy(req.socket.remoteAddress, 0) && req.headers['x-forwarded-proto'] === 'https');
app.use((req, res, next) => {
  if (hosted && req.path !== '/health' && !secureTransport(req)) {
    return res.status(403).json({ error: 'HTTPS required.' });
  }
  next();
});
app.use(express.json({ limit: '4kb' }));
const { authenticate, sessions, ready } = require('./accounts').openAccounts();
app.post(['/accounts/register', '/accounts/login'], authenticate);
app.post('/accounts/logout', (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer /, '');
  sessions.delete(token);
  for (const client of io.sockets.sockets.values()) {
    if (token && client.handshake.auth.token === token) client.disconnect(true);
  }
  res.sendStatus(204);
});

app.get('/', (_req, res) => {
  res.json({ message: 'Chat backend is running.' });

});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use((err, _req, res, _next) => {
  const status = err.status === 413 ? 413 : err.status === 400 ? 400 : 500;
  res.status(status).json({ error: status === 500 ? 'Request could not be completed.' : 'Invalid request.' });
});

const server = http.createServer(app);

const io = new Server(server, {
  allowRequest: (req, done) => done(null, acceptsOrigin(req.headers.origin) && (!hosted || secureTransport(req))),
  cors: {
    origin: allowedOrigins.length > 0 ? allowedOrigins : '*',
    methods: ['GET', 'POST'],
  },
});

const validSignal = packet => packet && typeof packet.callId === 'string' && /^[a-f0-9-]{36}$/.test(packet.callId) &&
  typeof packet.nonce === 'string' && /^[A-Za-z0-9+/]{32}$/.test(packet.nonce) &&
  typeof packet.box === 'string' && packet.box.length <= 131072 && /^[A-Za-z0-9+/]{22,}={0,2}$/.test(packet.box);

const usersBySocket = new Map();
const roomsBySocket = new Map();

const createSystemMessage = (text) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  user: 'system',
  system: true,
  text,
  timestamp: new Date().toISOString(),
});

const sanitizeRoomCode = (value) =>
  (typeof value === 'string' ? value : '')
    .trim()
    .slice(0, 32)
    .replace(/[^a-zA-Z0-9_-]/g, '');

const emitOnlineUsers = () => {
  const users = Array.from(io.sockets.sockets.values()).map((client) => ({
    id: client.id,
    name: usersBySocket.get(client.id) || 'Anonymous',
    publicKey: client.handshake.auth.publicKey,
    joined: usersBySocket.has(client.id),
  }));
  io.emit('online_users', users);
};

io.use((socket, next) => {
  if (typeof socket.handshake.auth?.publicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(socket.handshake.auth.publicKey)) {
    return next(new Error('Refresh Orbit to use encrypted chat.'));
  }
  const token = socket.handshake.auth.token;
  if (!token) return next();
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) return next(new Error('Session expired'));
  socket.data.account = session;
  next();
});

io.on('connection', (socket) => {
  let budget = 120;
  let updated = Date.now();
  socket.use((_packet, next) => {
    const now = Date.now();
    budget = Math.min(120, budget + (now - updated) / 50);
    updated = now;
    if (budget < 1) return socket.disconnect(true);
    budget--;
    next();
  });
  if (socket.data.account) {
    usersBySocket.set(socket.id, socket.data.account.name);
    const timer = setTimeout(() => socket.disconnect(true), socket.data.account.expires - Date.now());
    socket.once('disconnect', () => clearTimeout(timer));
  }
  socket.emit('chat_message', createSystemMessage('Welcome to Orbit. Make yourself at home.'));
  emitOnlineUsers();

  socket.on('join_room', (rawName) => {
    if (typeof rawName !== 'string') return;
    const guest = rawName.trim().slice(0, 24);
    const name = socket.data.account?.name || (guest.startsWith('@') ? 'Guest' : guest || 'Anonymous');
    usersBySocket.set(socket.id, name);
    io.emit('chat_message', createSystemMessage(`${name} joined the room.`));
    emitOnlineUsers();
  });

  socket.on('join_private_room', (rawRoomCode) => {
    const roomCode = sanitizeRoomCode(rawRoomCode);
    if (!usersBySocket.has(socket.id) || !roomCode || (roomsBySocket.get(socket.id)?.size >= 128 && !roomsBySocket.get(socket.id).has(roomCode))) {
      return;
    }

    const roomName = `room:${roomCode}`;
    socket.join(roomName);

    const currentRooms = roomsBySocket.get(socket.id) || new Set();
    currentRooms.add(roomCode);
    roomsBySocket.set(socket.id, currentRooms);

    const user = usersBySocket.get(socket.id) || 'Anonymous';
    io.to(roomName).emit('room_message', {
      ...createSystemMessage(`${user} joined the room.`),
      room: roomCode,
    });
  });

  socket.on('encrypted_text', (packet, reply) => {
    if (typeof reply !== 'function') return;
    const { kind, target, deliveries } = packet || {};
    const user = usersBySocket.get(socket.id);
    if (!user || !Array.isArray(deliveries) || !deliveries.length ||
        !['global', 'room', 'direct'].includes(kind)) return reply(false);
    if (kind === 'room' && (!roomsBySocket.get(socket.id)?.has(target) || deliveries.length !== 1)) return reply(false);
    if (kind === 'direct' && (!usersBySocket.has(target) || deliveries.length !== 1)) return reply(false);
    if (kind === 'global' && target !== 'global') return reply(false);
    const recipients = new Set();
    const timestamp = new Date().toISOString();
    for (const entry of deliveries) {
      if (!entry || recipients.has(entry.to) || typeof entry.nonce !== 'string' || !/^[A-Za-z0-9+/]{32}$/.test(entry.nonce) ||
          typeof entry.box !== 'string' || entry.box.length > 8192 || !/^[A-Za-z0-9+/]{22,}={0,2}$/.test(entry.box) ||
          (kind === 'global' && !usersBySocket.has(entry.to)) ||
          (kind !== 'global' && entry.to !== target)) return reply(false);
      recipients.add(entry.to);
    }
    for (const { to, nonce, box } of deliveries) {
      const destination = kind === 'room' ? 'room:' + target : to;
      io.to(destination).emit('encrypted_text', { kind, target, to, nonce, box, user, from: socket.id, timestamp });
    }
    reply(true);
  });

  socket.on('typing', () => {
    const user = usersBySocket.get(socket.id);
    if (!user) {
      return;
    }
    socket.broadcast.emit('user_typing', user);
  });

  socket.on('stop_typing', () => {
    const user = usersBySocket.get(socket.id);
    if (!user) {
      return;
    }
    socket.broadcast.emit('user_stop_typing', user);
  });

  function clearCall() {
    const partner = io.sockets.sockets.get(socket.data.callPeer);
    clearTimeout(socket.data.ringTimer);
    delete socket.data.callPeer;
    delete socket.data.incomingOffer;
    if (partner?.data.callPeer === socket.id) {
      clearTimeout(partner.data.ringTimer);
      delete partner.data.callPeer;
      delete partner.data.incomingOffer;
      partner.emit('end_call');
    }
  }

  socket.on('call_user', (payload) => {
    const userToCall = payload?.userToCall;
    const partner = io.sockets.sockets.get(userToCall);
    if (!usersBySocket.has(socket.id) || !usersBySocket.has(userToCall) || !partner ||
        partner === socket || partner.data.callPeer || socket.data.callPeer || !validSignal(payload?.signalData)) {
      if (!socket.data.callPeer) socket.emit('end_call');
      return;
    }

    socket.data.callPeer = partner.id;
    partner.data.callPeer = socket.id;
    partner.data.incomingOffer = true;
    socket.data.ringTimer = setTimeout(() => { clearCall(); socket.emit('end_call'); }, 45000);
    socket.data.ringTimer.unref();
    io.to(userToCall).emit('call_user', {
      signal: payload.signalData,
      from: socket.id,
      name: usersBySocket.get(socket.id) || 'Anonymous',
    });
  });

  socket.on('answer_call', (payload) => {
    const to = payload?.to;
    if (typeof to !== 'string' || socket.data.callPeer !== to || !socket.data.incomingOffer || !validSignal(payload?.signal)) {
      return;
    }

    delete socket.data.incomingOffer;
    clearTimeout(io.sockets.sockets.get(to)?.data.ringTimer);
    io.to(to).emit('call_accepted', payload.signal);
  });

  socket.on('ice_candidate', (payload) => {
    const to = payload?.to;
    if (typeof to !== 'string' || socket.data.callPeer !== to || !validSignal(payload?.candidate)) {
      return;
    }

    io.to(to).emit('ice_candidate', {
      candidate: payload.candidate,
      from: socket.id,
    });
  });

  socket.on('end_call', (payload) => {
    const to = payload?.to;
    if (typeof to === 'string' && socket.data.callPeer === to) clearCall();
  });

  socket.on('disconnect', () => {
    clearCall();
    const name = usersBySocket.get(socket.id);
    if (name) {
      socket.broadcast.emit('user_stop_typing', name);
      io.emit('chat_message', createSystemMessage(`${name} left the room.`));
      usersBySocket.delete(socket.id);
    }
    roomsBySocket.delete(socket.id);
    emitOnlineUsers();
  });
});

const port = process.env.PORT === undefined ? 4000 : Number(process.env.PORT);
ready.then(() => server.listen(port, () => {
  console.log(`Server listening on http://localhost:${server.address().port}`);
})).catch(() => {
  console.error('Account storage initialization failed. Check database configuration and connectivity.');
  process.exitCode = 1;
});
