const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Лимит 100 МБ для передаваемых фото/видео
});

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  // Текстовые сообщения, фото, голосовые и кружочки
  socket.on('chat message', (data) => {
    io.emit('chat message', {
      id: socket.id,
      type: data.type, // 'text', 'image', 'audio', 'circle'
      content: data.content
    });
  });

  // Логика звонков (WebRTC signaling)
  socket.on('call-user', (data) => {
    socket.broadcast.emit('incoming-call', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('make-answer', (data) => {
    socket.broadcast.emit('call-answered', {
      to: data.to,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', data);
  });

  socket.on('end-call', () => {
    socket.broadcast.emit('call-ended');
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Храм запущен на порту ${PORT}`);
});
