const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const MAP_W = 2400;
const MAP_H = 1400;
const PLAYER_RADIUS = 22;
const BALL_RADIUS = 18;
const GOAL_WIDTH = 180;
const GOAL_DEPTH = 50;
const PLAYER_SPEED = 420;
const BOOST_SPEED = 780;
const BOOST_MAX = 100;
const BOOST_REGEN = 10;       // per second
const BOOST_DRAIN = 40;       // per second while boosting
const BOOST_PAD_RADIUS = 28;
const BOOST_RESPAWN = 8000;   // ms
const DODGE_SPEED = 700;
const DODGE_DURATION = 0.18;  // seconds
const FRICTION = 0.985;
const BALL_FRICTION = 0.992;
const BALL_BOUNCE = 0.65;
const PLAYER_BOUNCE = 0.5;
const MAX_PLAYERS = 8;
const SCORE_TO_WIN = 5;

// Boost pad positions
const BOOST_PADS = [
  { id: 0, x: 180,       y: 180,       big: true },
  { id: 1, x: MAP_W-180, y: 180,       big: true },
  { id: 2, x: 180,       y: MAP_H-180, big: true },
  { id: 3, x: MAP_W-180, y: MAP_H-180, big: true },
  { id: 4, x: MAP_W/2,   y: 100,       big: false },
  { id: 5, x: MAP_W/2,   y: MAP_H-100, big: false },
  { id: 6, x: 600,       y: MAP_H/2,   big: false },
  { id: 7, x: MAP_W-600, y: MAP_H/2,   big: false },
];

// ─── ROOM STORE ──────────────────────────────────────────────────────────────
const rooms = new Map();

function createRoom(name, hostId) {
  const room = {
    id: uuidv4().slice(0, 6).toUpperCase(),
    name,
    hostId,
    state: 'lobby',   // lobby | playing | ended
    players: new Map(),
    ball: createBall(),
    scores: { red: 0, blue: 0 },
    boostPads: BOOST_PADS.map(p => ({ ...p, active: true, respawnAt: 0 })),
    lastTick: Date.now(),
    tickInterval: null,
    countdown: 0,
    goalCooldown: 0,
  };
  rooms.set(room.id, room);
  return room;
}

function createBall() {
  return { x: MAP_W / 2, y: MAP_H / 2, vx: 0, vy: 0, lastHitBy: null };
}

function createPlayer(socketId, profile) {
  return {
    id: socketId,
    name: profile.name || 'Player',
    avatar: profile.avatar || null,
    title: profile.title || 'Rookie',
    banner: profile.banner || '#1a1a2e',
    team: 'spectator',
    x: MAP_W / 2,
    y: MAP_H / 2,
    vx: 0,
    vy: 0,
    boost: BOOST_MAX,
    isDodging: false,
    dodgeTimer: 0,
    dodgeVx: 0,
    dodgeVy: 0,
    keys: { up: false, down: false, left: false, right: false, boost: false },
    lastProcessedInput: 0,
    inputQueue: [],
  };
}

// ─── PHYSICS ─────────────────────────────────────────────────────────────────
function tickRoom(room) {
  const now = Date.now();
  const dt = Math.min((now - room.lastTick) / 1000, 0.05);
  room.lastTick = now;

  if (room.state !== 'playing') return;
  if (room.goalCooldown > 0) {
    room.goalCooldown -= dt;
    if (room.goalCooldown <= 0) resetAfterGoal(room);
    broadcastState(room);
    return;
  }

  const players = Array.from(room.players.values()).filter(p => p.team !== 'spectator');

  // Process inputs
  players.forEach(p => {
    processPlayerInputs(p, dt);
  });

  // Move ball
  room.ball.x += room.ball.vx * dt;
  room.ball.y += room.ball.vy * dt;
  room.ball.vx *= Math.pow(BALL_FRICTION, dt * 60);
  room.ball.vy *= Math.pow(BALL_FRICTION, dt * 60);

  // Ball wall collisions
  if (room.ball.x - BALL_RADIUS < 0) {
    room.ball.x = BALL_RADIUS;
    room.ball.vx = Math.abs(room.ball.vx) * BALL_BOUNCE;
  }
  if (room.ball.x + BALL_RADIUS > MAP_W) {
    room.ball.x = MAP_W - BALL_RADIUS;
    room.ball.vx = -Math.abs(room.ball.vx) * BALL_BOUNCE;
  }
  const goalTop = MAP_H / 2 - GOAL_WIDTH / 2;
  const goalBot = MAP_H / 2 + GOAL_WIDTH / 2;
  const inGoalY = room.ball.y > goalTop && room.ball.y < goalBot;

  if (room.ball.y - BALL_RADIUS < 0) {
    room.ball.y = BALL_RADIUS;
    room.ball.vy = Math.abs(room.ball.vy) * BALL_BOUNCE;
  }
  if (room.ball.y + BALL_RADIUS > MAP_H) {
    room.ball.y = MAP_H - BALL_RADIUS;
    room.ball.vy = -Math.abs(room.ball.vy) * BALL_BOUNCE;
  }

  // Check goals
  if (room.ball.x - BALL_RADIUS < -GOAL_DEPTH && inGoalY) {
    scoreGoal(room, 'blue');
    return;
  }
  if (room.ball.x + BALL_RADIUS > MAP_W + GOAL_DEPTH && inGoalY) {
    scoreGoal(room, 'red');
    return;
  }

  // Player physics & collisions
  players.forEach(p => {
    // Wall clamp
    p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y));

    // Ball collision
    const dx = room.ball.x - p.x;
    const dy = room.ball.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = PLAYER_RADIUS + BALL_RADIUS;
    if (dist < minDist && dist > 0) {
      const nx = dx / dist;
      const ny = dy / dist;
      // Separate
      const overlap = minDist - dist;
      room.ball.x += nx * overlap * 0.6;
      room.ball.y += ny * overlap * 0.6;
      p.x -= nx * overlap * 0.4;
      p.y -= ny * overlap * 0.4;
      // Transfer velocity
      const relVx = p.vx - room.ball.vx;
      const relVy = p.vy - room.ball.vy;
      const dot = relVx * nx + relVy * ny;
      const impulse = dot * 1.4;
      room.ball.vx += impulse * nx;
      room.ball.vy += impulse * ny;
      p.vx -= impulse * nx * 0.3;
      p.vy -= impulse * ny * 0.3;
      room.ball.lastHitBy = p.id;
    }
  });

  // Player-player collisions
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minD = PLAYER_RADIUS * 2;
      if (dist < minD && dist > 0) {
        const nx = dx / dist, ny = dy / dist;
        const overlap = (minD - dist) / 2;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
        const relVx = a.vx - b.vx, relVy = a.vy - b.vy;
        const dot = relVx * nx + relVy * ny;
        if (dot > 0) {
          a.vx -= dot * nx * PLAYER_BOUNCE;
          a.vy -= dot * ny * PLAYER_BOUNCE;
          b.vx += dot * nx * PLAYER_BOUNCE;
          b.vy += dot * ny * PLAYER_BOUNCE;
        }
      }
    }
  }

  // Boost pads
  room.boostPads.forEach(pad => {
    if (!pad.active && now > pad.respawnAt) pad.active = true;
    if (!pad.active) return;
    players.forEach(p => {
      const dx = p.x - pad.x, dy = p.y - pad.y;
      if (Math.sqrt(dx * dx + dy * dy) < PLAYER_RADIUS + BOOST_PAD_RADIUS) {
        const amount = pad.big ? BOOST_MAX : 40;
        p.boost = Math.min(BOOST_MAX, p.boost + amount);
        pad.active = false;
        pad.respawnAt = now + BOOST_RESPAWN;
      }
    });
  });

  broadcastState(room);
}

function processPlayerInputs(p, dt) {
  // Process queued inputs (client-side prediction reconciliation)
  while (p.inputQueue.length > 0) {
    const input = p.inputQueue.shift();
    p.keys = input.keys;
    p.lastProcessedInput = input.seq;
  }

  const keys = p.keys;
  let ax = 0, ay = 0;
  const speed = (keys.boost && p.boost > 0) ? BOOST_SPEED : PLAYER_SPEED;

  if (p.isDodging) {
    p.dodgeTimer -= dt;
    p.vx = p.dodgeVx;
    p.vy = p.dodgeVy;
    if (p.dodgeTimer <= 0) {
      p.isDodging = false;
    }
  } else {
    if (keys.up)    ay -= 1;
    if (keys.down)  ay += 1;
    if (keys.left)  ax -= 1;
    if (keys.right) ax += 1;

    const len = Math.sqrt(ax * ax + ay * ay);
    if (len > 0) { ax /= len; ay /= len; }

    const targetVx = ax * speed;
    const targetVy = ay * speed;
    const accel = 12;
    p.vx += (targetVx - p.vx) * Math.min(1, accel * dt);
    p.vy += (targetVy - p.vy) * Math.min(1, accel * dt);

    if (keys.boost && p.boost > 0 && len > 0) {
      p.boost = Math.max(0, p.boost - BOOST_DRAIN * dt);
    } else if (!keys.boost || len === 0) {
      p.boost = Math.min(BOOST_MAX, p.boost + BOOST_REGEN * dt);
    }
  }

  p.vx *= Math.pow(FRICTION, dt * 60);
  p.vy *= Math.pow(FRICTION, dt * 60);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

function scoreGoal(room, team) {
  room.scores[team]++;
  room.goalCooldown = 3.0;
  io.to(room.id).emit('goal', { team, scores: room.scores, scorer: room.ball.lastHitBy });
  if (room.scores[team] >= SCORE_TO_WIN) {
    room.state = 'ended';
    io.to(room.id).emit('gameOver', { winner: team, scores: room.scores });
    clearInterval(room.tickInterval);
    room.tickInterval = null;
  }
}

function resetAfterGoal(room) {
  room.ball = createBall();
  room.players.forEach(p => {
    if (p.team === 'red') { p.x = MAP_W * 0.3; p.y = MAP_H / 2; }
    else if (p.team === 'blue') { p.x = MAP_W * 0.7; p.y = MAP_H / 2; }
    p.vx = 0; p.vy = 0; p.boost = BOOST_MAX;
  });
}

function broadcastState(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = {
      id, name: p.name, avatar: p.avatar, title: p.title, banner: p.banner,
      team: p.team, x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      boost: p.boost, isDodging: p.isDodging,
      lastProcessedInput: p.lastProcessedInput,
    };
  });
  io.to(room.id).emit('gameState', {
    players,
    ball: room.ball,
    boostPads: room.boostPads.map(p => ({ id: p.id, active: p.active })),
    scores: room.scores,
    goalCooldown: room.goalCooldown,
    tick: Date.now(),
  });
}

function startGame(room) {
  room.state = 'playing';
  room.scores = { red: 0, blue: 0 };
  room.ball = createBall();
  let sp = 0;
  room.players.forEach(p => {
    if (p.team === 'red') { p.x = MAP_W * 0.28 + (sp % 2) * 60; p.y = MAP_H / 2 + (Math.floor(sp / 2) - 1) * 100; sp++; }
  });
  sp = 0;
  room.players.forEach(p => {
    if (p.team === 'blue') { p.x = MAP_W * 0.72 - (sp % 2) * 60; p.y = MAP_H / 2 + (Math.floor(sp / 2) - 1) * 100; sp++; }
    p.vx = 0; p.vy = 0; p.boost = BOOST_MAX;
  });
  room.boostPads.forEach(pad => { pad.active = true; });
  room.lastTick = Date.now();
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => tickRoom(room), TICK_MS);
  io.to(room.id).emit('gameStarted', {
    mapW: MAP_W, mapH: MAP_H, boostPads: BOOST_PADS,
    playerRadius: PLAYER_RADIUS, ballRadius: BALL_RADIUS,
    goalWidth: GOAL_WIDTH, goalDepth: GOAL_DEPTH,
  });
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  socket.on('getRooms', () => {
    const list = [];
    rooms.forEach(r => {
      list.push({
        id: r.id, name: r.name, state: r.state,
        playerCount: r.players.size,
        redCount: [...r.players.values()].filter(p => p.team === 'red').length,
        blueCount: [...r.players.values()].filter(p => p.team === 'blue').length,
      });
    });
    socket.emit('roomList', list);
  });

  socket.on('createRoom', ({ roomName, profile }) => {
    const room = createRoom(roomName || 'Champions Field', socket.id);
    const player = createPlayer(socket.id, profile || {});
    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.currentRoom = room.id;
    socket.emit('roomJoined', {
      roomId: room.id, playerId: socket.id,
      isHost: true, room: serializeRoom(room),
      constants: { MAP_W, MAP_H, PLAYER_RADIUS, BALL_RADIUS, GOAL_WIDTH, GOAL_DEPTH, BOOST_PADS, BOOST_MAX },
    });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ roomId, profile }) => {
    const room = rooms.get(roomId.toUpperCase());
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit('error', 'Room is full'); return; }
    const player = createPlayer(socket.id, profile || {});
    room.players.set(socket.id, player);
    socket.join(room.id);
    socket.currentRoom = room.id;
    socket.emit('roomJoined', {
      roomId: room.id, playerId: socket.id,
      isHost: room.hostId === socket.id, room: serializeRoom(room),
      constants: { MAP_W, MAP_H, PLAYER_RADIUS, BALL_RADIUS, GOAL_WIDTH, GOAL_DEPTH, BOOST_PADS, BOOST_MAX },
    });
    broadcastLobby(room);
  });

  socket.on('changeTeam', ({ team }) => {
    const room = rooms.get(socket.currentRoom);
    if (!room || room.state !== 'lobby') return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const redCount = [...room.players.values()].filter(p => p.team === 'red').length;
    const blueCount = [...room.players.values()].filter(p => p.team === 'blue').length;
    if (team === 'red' && redCount >= 4) { socket.emit('error', 'Red team is full'); return; }
    if (team === 'blue' && blueCount >= 4) { socket.emit('error', 'Blue team is full'); return; }
    player.team = team;
    broadcastLobby(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.currentRoom);
    if (!room || room.hostId !== socket.id) return;
    const red = [...room.players.values()].filter(p => p.team === 'red').length;
    const blue = [...room.players.values()].filter(p => p.team === 'blue').length;
    if (red < 1 || blue < 1) { socket.emit('error', 'Need at least 1 player per team'); return; }
    startGame(room);
  });

  socket.on('input', ({ keys, seq, dodge }) => {
    const room = rooms.get(socket.currentRoom);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.team === 'spectator') return;

    player.inputQueue.push({ keys, seq });
    if (player.inputQueue.length > 10) player.inputQueue.shift();

    if (dodge && !player.isDodging) {
      const len = Math.sqrt(dodge.x * dodge.x + dodge.y * dodge.y);
      if (len > 0) {
        player.isDodging = true;
        player.dodgeTimer = DODGE_DURATION;
        player.dodgeVx = (dodge.x / len) * DODGE_SPEED;
        player.dodgeVy = (dodge.y / len) * DODGE_SPEED;
      }
    }
  });

  socket.on('updateProfile', (profile) => {
    const room = rooms.get(socket.currentRoom);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (profile.name) player.name = profile.name.slice(0, 20);
    if (profile.avatar !== undefined) player.avatar = profile.avatar;
    if (profile.title) player.title = profile.title;
    if (profile.banner) player.banner = profile.banner;
    broadcastLobby(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.currentRoom);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) {
      clearInterval(room.tickInterval);
      rooms.delete(room.id);
    } else {
      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
      }
      broadcastLobby(room);
      if (room.state === 'playing') {
        const red = [...room.players.values()].filter(p => p.team === 'red').length;
        const blue = [...room.players.values()].filter(p => p.team === 'blue').length;
        if (red === 0 || blue === 0) {
          room.state = 'lobby';
          clearInterval(room.tickInterval);
          room.tickInterval = null;
          io.to(room.id).emit('returnToLobby', { reason: 'A team is empty' });
        }
      }
    }
  });

  socket.on('rematch', () => {
    const room = rooms.get(socket.currentRoom);
    if (!room || room.hostId !== socket.id) return;
    room.state = 'lobby';
    room.scores = { red: 0, blue: 0 };
    broadcastLobby(room);
  });
});

function serializeRoom(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = { id, name: p.name, avatar: p.avatar, title: p.title, banner: p.banner, team: p.team };
  });
  return { id: room.id, name: room.name, state: room.state, players, scores: room.scores, hostId: room.hostId };
}

function broadcastLobby(room) {
  io.to(room.id).emit('lobbyUpdate', serializeRoom(room));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Champions Field server on port ${PORT}`));
