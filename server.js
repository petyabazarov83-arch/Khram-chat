const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Лимит 100 МБ
});

app.use(express.static('public'));

// Хранилище активных пользователей: { socketId: { uid, username } }
const users = {};
const history = {}; // История сообщений по комнатам/чатам

// Простая функция бота
function getBotResponse(text) {
  const q = text.toLowerCase();
  if (q.includes('салат') || q.includes('приготовить салат')) {
    return "🥗 Рецепт простого овощного салата:\n1. Нарежьте 2 огурца и 2 помидора.\n2. Добавьте порезанный зеленый лук и петрушку.\n3. Посолите, заправьте 1 ст. л. подсолнечного или оливкового масла.\n4. Перемешайте — готово!";
  }
  if (q.includes('привет') || q.includes('здравствуй')) {
    return "Приветствую в Храме! Чем могу помочь?";
  }
  if (q.includes('как дела')) {
    return "Всё отлично! Сервер Храма работает стабильно.";
  }
  return "Я простенький ИИ-бот Храма. Задайте вопрос (например: 'как приготовить салат').";
}

io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  // Авторизация / Регистрация аккаунта
  socket.on('register', (data) => {
    users[socket.id] = {
      uid: data.uid || ('khram-user-' + Math.random().toString(36).substring(2, 8)),
      username: data.username || 'Путник'
    };
    socket.emit('registered', users[socket.id]);
  });

  // Отправка сообщений
  socket.on('chat message', (data) => {
    const sender = users[socket.id] || { uid: 'guest', username: 'Аноним' };
    const msgData = {
      id: Date.now(),
      senderUid: sender.uid,
      senderName: sender.username,
      targetUid: data.targetUid,
      type: data.type, // 'text', 'image', 'audio', 'circle', 'file'
      content: data.content,
      fileName: data.fileName,
      fileSize: data.fileSize
    };

    // Если сообщение адресовано ИИ Боту
    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgData); // Сообщение от пользователя
      setTimeout(() => {
        const botAnswer = {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          targetUid: sender.uid,
          type: 'text',
          content: getBotResponse(data.content)
        };
        socket.emit('chat message', botAnswer);
      }, 600);
      return;
    }

    // Рассылка всем или конкретному пользователю
    io.emit('chat message', msgData);
  });

  // WebRTC Сигналинг для звонков
  socket.on('call-user', (data) => {
    socket.broadcast.emit('incoming-call', {
      from: socket.id,
      fromUid: users[socket.id]?.uid || 'Неизвестный',
      fromName: users[socket.id]?.username || 'Путник',
      offer: data.offer
    });
  });

  socket.on('make-answer', (data) => {
    io.to(data.to).emit('call-answered', {
      to: socket.id,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.broadcast.emit('ice-candidate', {
      sender: socket.id,
      candidate: data.candidate || data
    });
  });

  socket.on('end-call', () => {
    socket.broadcast.emit('call-ended');
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Храм запущен на порту ${PORT}`);
});
