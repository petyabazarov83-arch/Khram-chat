const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

app.use(express.static(__dirname));

let users = {}; // uid -> socket.id

io.on('connection', (socket) => {
  socket.on('register', (user) => {
    socket.uid = user.uid;
    users[user.uid] = socket.id;
    io.emit('online-users-list', Object.keys(users));
  });

  socket.on('join-group-room', (groupId) => {
    socket.join(groupId);
  });

  socket.on('chat message', (data) => {
    if (data.isGroup) {
      io.to(data.targetUid).emit('chat message', data);
    } else {
      const targetSocketId = users[data.targetUid];
      if (targetSocketId) io.to(targetSocketId).emit('chat message', data);
      socket.emit('chat message', data);
    }
  });

  socket.on('call-user', (data) => {
    if (data.isGroup) {
      socket.to(data.targetUid).emit('incoming-call', data);
    } else {
      const targetSocketId = users[data.targetUid];
      if (targetSocketId) io.to(targetSocketId).emit('incoming-call', data);
    }
  });

  socket.on('make-answer', (data) => {
    const targetSocketId = users[data.targetUid];
    if (targetSocketId) io.to(targetSocketId).emit('call-answered', data);
  });

  socket.on('ice-candidate', (data) => {
    const targetSocketId = users[data.targetUid];
    if (targetSocketId) io.to(targetSocketId).emit('ice-candidate', data);
  });

  socket.on('disconnect', () => {
    if (socket.uid) delete users[socket.uid];
    io.emit('online-users-list', Object.keys(users));
  });
});

http.listen(3000, '0.0.0.0', () => {
  console.log('Сервер Храм запущен на порту 3000');
});
