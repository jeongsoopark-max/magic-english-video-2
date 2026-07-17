// server.js — signaling server for the small-scale video classroom
//
// Responsibilities:
//   1. Serve the static client (public/).
//   2. Relay WebRTC signaling messages (offer/answer/ICE) between peers
//      in the same room. The server never touches audio/video media —
//      that flows directly peer-to-peer once the connection is set up.
//   3. Track who is in each room and enforce a max room size.
//   4. Relay lightweight text chat messages within a room.
//   5. Optional "waiting room": whoever joins a room first (when nobody is
//      in it) becomes that room's host for as long as they stay connected.
//      If they turned on approval, later joiners sit in a pending queue
//      until the host admits or denies them.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 10; // small group class ceiling for mesh WebRTC

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Map<socketId, { name }>   (admitted members, i.e. actually in the call)
const rooms = new Map();
// roomId -> socketId of the current host (the first person who opened the room)
const roomHosts = new Map();
// roomId -> { waitingRoomEnabled: boolean }
const roomSettings = new Map();
// roomId -> Map<socketId, { name }>   (asked to join, waiting on the host)
const roomPending = new Map();

function getRoomMembers(roomId) {
  return rooms.get(roomId) || new Map();
}

function roomSummary(roomId) {
  const members = getRoomMembers(roomId);
  return Array.from(members.entries()).map(([id, info]) => ({ id, name: info.name }));
}

function broadcastPendingList(roomId) {
  const hostId = roomHosts.get(roomId);
  if (!hostId) return;
  const pending = roomPending.get(roomId) || new Map();
  const list = Array.from(pending.entries()).map(([id, info]) => ({ id, name: info.name }));
  io.to(hostId).emit('pending-list', list);
}

io.on('connection', (socket) => {
  let joinedRoom = null;   // set once actually admitted into a room
  let pendingRoom = null;  // set while sitting in a room's waiting queue

  socket.on('join-room', ({ roomId, name, requireApproval }, ack) => {
    if (typeof ack !== 'function') return;
    if (!roomId || typeof roomId !== 'string') {
      return ack({ ok: false, error: 'invalid-room' });
    }
    const cleanName = (name || 'Guest').slice(0, 40);
    const members = getRoomMembers(roomId);
    const roomIsFresh = members.size === 0 && !roomHosts.has(roomId);

    // First person in an empty room becomes its host and sets the
    // approval policy for everyone who follows.
    if (roomIsFresh) {
      members.set(socket.id, { name: cleanName });
      rooms.set(roomId, members);
      roomHosts.set(roomId, socket.id);
      roomSettings.set(roomId, { waitingRoomEnabled: !!requireApproval });

      socket.join(roomId);
      joinedRoom = roomId;
      return ack({ ok: true, peers: [], maxSize: MAX_ROOM_SIZE, isHost: true });
    }

    const settings = roomSettings.get(roomId) || { waitingRoomEnabled: false };
    const hostId = roomHosts.get(roomId);

    if (settings.waitingRoomEnabled && hostId) {
      const pending = roomPending.get(roomId) || new Map();
      pending.set(socket.id, { name: cleanName });
      roomPending.set(roomId, pending);
      pendingRoom = roomId;

      ack({ ok: true, waiting: true });
      broadcastPendingList(roomId);
      return;
    }

    if (members.size >= MAX_ROOM_SIZE) {
      return ack({ ok: false, error: 'room-full', maxSize: MAX_ROOM_SIZE });
    }

    const existingPeers = roomSummary(roomId);
    members.set(socket.id, { name: cleanName });
    rooms.set(roomId, members);

    socket.join(roomId);
    joinedRoom = roomId;

    ack({ ok: true, peers: existingPeers, maxSize: MAX_ROOM_SIZE, isHost: false });
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: cleanName });
  });

  // Host approves or denies someone sitting in the waiting queue.
  socket.on('admission-response', ({ targetId, approve }) => {
    if (!joinedRoom || !targetId) return;
    if (roomHosts.get(joinedRoom) !== socket.id) return; // only the host may decide

    const pending = roomPending.get(joinedRoom);
    if (!pending || !pending.has(targetId)) return;
    const info = pending.get(targetId);
    pending.delete(targetId);
    broadcastPendingList(joinedRoom);

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!approve) {
      io.to(targetId).emit('admission-result', { approved: false });
      return;
    }

    const members = getRoomMembers(joinedRoom);
    if (members.size >= MAX_ROOM_SIZE) {
      io.to(targetId).emit('admission-result', { approved: false, reason: 'room-full' });
      return;
    }

    members.set(targetId, { name: info.name });
    rooms.set(joinedRoom, members);
    if (targetSocket) targetSocket.join(joinedRoom);

    const existingPeers = roomSummary(joinedRoom).filter((p) => p.id !== targetId);
    io.to(targetId).emit('admission-result', { approved: true, peers: existingPeers, maxSize: MAX_ROOM_SIZE });
    io.to(joinedRoom).except(targetId).emit('peer-joined', { id: targetId, name: info.name });
  });

  // Someone waiting gives up before the host responds.
  socket.on('cancel-wait', () => leavePendingQueue());

  // --- WebRTC signaling relay (server just forwards these blind) ---
  socket.on('signal', ({ to, data }) => {
    if (!to || !joinedRoom) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // --- Simple room chat ---
  socket.on('chat-message', ({ text }) => {
    if (!joinedRoom || !text) return;
    const members = getRoomMembers(joinedRoom);
    const name = members.get(socket.id)?.name || 'Guest';
    const trimmed = String(text).slice(0, 1000);
    io.to(joinedRoom).emit('chat-message', {
      from: socket.id,
      name,
      text: trimmed,
      at: Date.now(),
    });
  });

  socket.on('leave-room', () => leaveCurrentRoom());
  socket.on('disconnect', () => {
    leaveCurrentRoom();
    leavePendingQueue();
  });

  function leavePendingQueue() {
    if (!pendingRoom) return;
    const pending = roomPending.get(pendingRoom);
    if (pending) {
      pending.delete(socket.id);
      broadcastPendingList(pendingRoom);
    }
    pendingRoom = null;
  }

  function leaveCurrentRoom() {
    if (!joinedRoom) return;
    const roomId = joinedRoom;
    const members = getRoomMembers(roomId);
    members.delete(socket.id);

    const wasHost = roomHosts.get(roomId) === socket.id;

    if (members.size === 0) {
      // Room is fully empty — reset it so the next joiner starts fresh
      // (and can become host again if they choose to).
      rooms.delete(roomId);
      roomHosts.delete(roomId);
      roomSettings.delete(roomId);
      roomPending.delete(roomId);
    } else {
      rooms.set(roomId, members);
      if (wasHost) {
        // The host left but others are still on the call. Nobody's left
        // to approve anyone, so open the room up rather than leaving
        // future joiners stuck forever — and let anyone already waiting
        // in immediately.
        roomHosts.delete(roomId);
        roomSettings.set(roomId, { waitingRoomEnabled: false });
        const pending = roomPending.get(roomId);
        if (pending && pending.size > 0) {
          pending.forEach((info, pendingId) => {
            const pendingSocket = io.sockets.sockets.get(pendingId);
            if (!pendingSocket) return;
            members.set(pendingId, { name: info.name });
            pendingSocket.join(roomId);
            io.to(pendingId).emit('admission-result', {
              approved: true,
              peers: roomSummary(roomId).filter((p) => p.id !== pendingId),
              maxSize: MAX_ROOM_SIZE,
            });
          });
          rooms.set(roomId, members);
          roomPending.delete(roomId);
        }
      }
    }

    socket.to(roomId).emit('peer-left', { id: socket.id });
    socket.leave(roomId);
    joinedRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`Video classroom signaling server listening on http://localhost:${PORT}`);
});
