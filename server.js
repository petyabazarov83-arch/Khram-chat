const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*" }
});

// 1. Раздаем все статические файлы из текущей папки
app.use(express.static(__dirname));

// 2. Главный маршрут: явно отдаем index.html при заходе на "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер Храм успешно запущен на порту ${PORT}`);
});
