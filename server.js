const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // Лимит 100 МБ
});

app.use(express.static('public'));

// Хранилище зарегистрированных пользователей: uid -> { uid, username, avatar, phone, socketIds: Set }
const registeredUsers = new Map();
const socketToUid = new Map();

function broadcastOnlineUsers() {
  const onlineUids = Array.from(socketToUid.values());
  io.emit('online-users-list', Array.from(new Set(onlineUids)));
}

io.on('connection', (socket) => {

  // Регистрация профиля на сервере
  socket.on('register', (user) => {
    if (!user || !user.uid) return;

    socketToUid.set(socket.id, user.uid);

    let userData = registeredUsers.get(user.uid) || { socketIds: new Set() };
    userData.uid = user.uid;
    userData.username = user.username || 'Путник';
    userData.avatar = user.avatar || '';
    userData.phone = user.phone ? user.phone.replace(/\D/g, '') : '';
    userData.socketIds.add(socket.id);

    registeredUsers.set(user.uid, userData);

    socket.join(user.uid);
    broadcastOnlineUsers();

    // Рассылаем обновившийся профиль всем для синхронизации
    io.emit('user-profile-updated', {
      uid: userData.uid,
      username: userData.username,
      avatar: userData.avatar
    });
  });

  // Синхронизация контактов с SIM/телефона
  socket.on('sync-contacts', (phoneNumbers) => {
    if (!Array.isArray(phoneNumbers)) return;

    const normalizedPhones = phoneNumbers.map(p => String(p).replace(/\D/g, '')).filter(Boolean);
    const matchedUsers = [];

    registeredUsers.forEach((u) => {
      if (u.phone && normalizedPhones.includes(u.phone)) {
        matchedUsers.push({
          uid: u.uid,
          name: u.username,
          avatar: u.avatar,
          phone: u.phone
        });
      }
    });

    socket.emit('contacts-synced', matchedUsers);
  });

  // Отправка сообщений
  socket.on('chat message', (data) => {
    const sender = registeredUsers.get(data.senderUid) || {
      uid: data.senderUid,
      username: 'Пользователь',
      avatar: ''
    };

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

    // Бот-помощник
    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgPayload);
      setTimeout(() => {
        socket.emit('chat message', {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          targetUid: sender.uid,
          type: 'text',
          content: `🤖 Ответ бота на: "${data.content}"`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }, 500);
      return;
    }

    io.to(sender.uid).emit('chat message', msgPayload);
    io.to(data.targetUid).emit('chat message', msgPayload);
  });

  // Удаление сообщений
  socket.on('delete message', (data) => {
    io.to(data.senderUid).emit('message deleted', { msgId: data.msgId });
    io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
  });

  // WebRTC Сигналинг звонков
  socket.on('call-user', (data) => {
    const sender = registeredUsers.get(data.senderUid);
    io.to(data.targetUid).emit('incoming-call', {
      fromUid: data.senderUid,
      fromName: sender ? sender.username : 'Собеседник',
      fromAvatar: sender ? sender.avatar : '',
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
    const uid = socketToUid.get(socket.id);
    if (uid && registeredUsers.has(uid)) {
      const u = registeredUsers.get(uid);
      u.socketIds.delete(socket.id);
    }
    socketToUid.delete(socket.id);
    broadcastOnlineUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Храма запущен на порту ${PORT}`);
});
