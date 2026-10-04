const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Лимит 100 МБ
});

app.use(express.static('public'));

// Хранилище подключенных пользователей: socket.id -> { uid, username, avatar }
const socketToUser = new Map();

function getBotResponse(text) {
  const q = text.toLowerCase();
  if (q.includes('салат') || q.includes('приготовить салат')) {
    return "🥗 **Рецепт вкусного салата:**\n1. Нарежьте 2 огурца и 2 помидора.\n2. Добавьте порезанный зеленый лук и зелень.\n3. Посолите, заправьте оливковым или подсолнечным маслом.\n4. Перемешайте — готово!";
  }
  if (q.includes('привет') || q.includes('хай') || q.includes('здравствуй')) {
    return "Приветствую в Храме! Чем могу помочь?";
  }
  return `🤖 Ответ бота: "${text}". Задайте вопрос (например, "как приготовить салат").`;
}

function broadcastOnlineUsers() {
  const onlineUids = Array.from(socketToUser.values()).map(u => u.uid);
  io.emit('online-users-list', Array.from(new Set(onlineUids)));
}

io.on('connection', (socket) => {

  // Авторизация / Регистрация в комнате UID
  socket.on('register', (user) => {
    if (!user || !user.uid) return;
    
    socketToUser.set(socket.id, {
      uid: user.uid,
      username: user.username || 'Путник',
      avatar: user.avatar || ''
    });

    // Присоединяем данный сокет к комнате с его UID
    socket.join(user.uid);
    broadcastOnlineUsers();
  });

  // Отправка сообщений
  socket.on('chat message', (data) => {
    const sender = socketToUser.get(socket.id) || { uid: data.senderUid, username: 'Пользователь' };

    const msgPayload = {
      id: data.id || Date.now(),
      senderUid: sender.uid,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetUid: data.targetUid,
      type: data.type,
      content: data.content,
      fileName: data.fileName,
      fileSize: data.fileSize,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Бот
    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgPayload);
      setTimeout(() => {
        socket.emit('chat message', {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          targetUid: sender.uid,
          type: 'text',
          content: getBotResponse(data.content),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }, 500);
      return;
    }

    // Отправляем отправителю
    io.to(sender.uid).emit('chat message', msgPayload);
    // Отправляем получателю в его комнату
    io.to(data.targetUid).emit('chat message', msgPayload);
  });

  // Удаление сообщения
  socket.on('delete message', (data) => {
    io.to(data.senderUid).emit('message deleted', { msgId: data.msgId });
    io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
  });

  // WebRTC Звонки (Сигналинг через комнаты UID)
  socket.on('call-user', (data) => {
    const sender = socketToUser.get(socket.id);
    io.to(data.targetUid).emit('incoming-call', {
      fromUid: sender ? sender.uid : data.senderUid,
      fromName: sender ? sender.username : 'Собеседник',
      fromSocketId: socket.id,
      offer: data.offer
    });
  });

  socket.on('make-answer', (data) => {
    io.to(data.toSocketId).emit('call-answered', {
      answer: data.answer,
      fromSocketId: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    if (data.toSocketId) {
      io.to(data.toSocketId).emit('ice-candidate', { candidate: data.candidate });
    } else if (data.targetUid) {
      socket.to(data.targetUid).emit('ice-candidate', { candidate: data.candidate });
    }
  });

  socket.on('end-call', (data) => {
    if (data.targetUid) {
      io.to(data.targetUid).emit('call-ended');
    }
  });

  socket.on('disconnect', () => {
    socketToUser.delete(socket.id);
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Храма запущен на порту ${PORT}`);
});
