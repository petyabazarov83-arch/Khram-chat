const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Лимит 100 МБ для файлов и медиа
});

app.use(express.static('public'));

// Хранилище подключенных пользователей: socketId -> { uid, username, avatar }
const onlineUsers = new Map();

// Простая база знаний и ответов для ИИ-бота
function getAdvancedBotResponse(query) {
  const q = query.toLowerCase();

  if (q.includes('салат') || q.includes('как приготовить салат')) {
    return "🥗 **Рецепт классического овощного салата:**\n\n1. **Ингредиенты:** 2 свежих огурца, 2 помидора, 1 болгарский перец, зелень (петрушка/укроп), оливковое или подсолнечное масло, соль и перец по вкусу.\n2. **Приготовление:** Помойте овощи, нарежьте огурцы и помидоры средними ломтиками, перец — соломкой. Мелко накрошите зелень.\n3. **Заправка:** Сложите всё в салатник, посолите, заправьте 1-2 ст. ложками масла и аккуратно перемешайте.\n\nПриятного аппетита! 😋";
  }
  
  if (q.includes('погода') || q.includes('погоду')) {
    return "☀️ Чтобы узнать точную погоду в вашем городе, уточните название города или воспользуйтесь сервисом Яндекс.Погода / Gismeteo!";
  }

  if (q.includes('привет') || q.includes('здравствуй') || q.includes('хай')) {
    return "Приветствую! Я ИИ-помощник Храма. Чем могу помочь? Могу подсказать рецепт, ответить на вопрос или помочь с советом!";
  }

  if (q.includes('кто ты') || q.includes('что умеешь')) {
    return "🤖 Я виртуальный ассистент Храма. Я умею отвечать на вопросы, давать кулинарные рецепты, помогать с поисками и поддерживать диалог!";
  }

  return `🤖 Ответ на Ваш запрос: "${query}"\n\nЯ проанализировал вопрос. Если вам нужен конкретный рецепт, совет или информация по настройкам Храма — просто спросите меня напрямую!`;
}

io.on('connection', (socket) => {
  // Регистрация / обновление профиля
  socket.on('register', (data) => {
    onlineUsers.set(socket.id, {
      uid: data.uid,
      username: data.username || 'Путник',
      avatar: data.avatar || ''
    });
    
    // Рассылаем список онлайн пользователей
    broadcastOnlineStatus();
  });

  // Передача сообщений
  socket.on('chat message', (data) => {
    const sender = onlineUsers.get(socket.id) || { uid: data.senderUid, username: 'Пользователь' };

    const msgPayload = {
      id: data.id || Date.now(),
      senderUid: sender.uid,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetUid: data.targetUid,
      type: data.type, // 'text', 'image', 'audio', 'circle', 'file'
      content: data.content,
      fileName: data.fileName,
      fileSize: data.fileSize,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Общение с ИИ Ботом
    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgPayload);
      setTimeout(() => {
        const botReply = {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          senderAvatar: '',
          targetUid: sender.uid,
          type: 'text',
          content: getAdvancedBotResponse(data.content),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        socket.emit('chat message', botReply);
      }, 700);
      return;
    }

    // Ищем recipient socket
    let targetSocketId = null;
    for (let [sId, user] of onlineUsers.entries()) {
      if (user.uid === data.targetUid) {
        targetSocketId = sId;
        break;
      }
    }

    // Отправляем себе и получателю
    socket.emit('chat message', msgPayload);
    if (targetSocketId && targetSocketId !== socket.id) {
      io.to(targetSocketId).emit('chat message', msgPayload);
    }
  });

  // Удаление сообщения
  socket.on('delete message', (data) => {
    io.emit('message deleted', { msgId: data.msgId, targetUid: data.targetUid });
  });

  // WebRTC Сигналинг звонков
  socket.on('call-user', (data) => {
    for (let [sId, user] of onlineUsers.entries()) {
      if (user.uid === data.targetUid) {
        io.to(sId).emit('incoming-call', {
          fromSocketId: socket.id,
          fromUid: onlineUsers.get(socket.id)?.uid,
          fromName: onlineUsers.get(socket.id)?.username || 'Собеседник',
          offer: data.offer
        });
        break;
      }
    }
  });

  socket.on('make-answer', (data) => {
    io.to(data.toSocketId).emit('call-answered', {
      fromSocketId: socket.id,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    for (let [sId, user] of onlineUsers.entries()) {
      if (user.uid === data.targetUid) {
        io.to(sId).emit('ice-candidate', { candidate: data.candidate });
      }
    }
  });

  socket.on('end-call', (data) => {
    for (let [sId, user] of onlineUsers.entries()) {
      if (user.uid === data.targetUid) {
        io.to(sId).emit('call-ended');
      }
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineStatus();
  });

  function broadcastOnlineStatus() {
    const activeUids = Array.from(onlineUsers.values()).map(u => u.uid);
    io.emit('online-users-list', activeUids);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Храма запущен на порту ${PORT}`);
});
