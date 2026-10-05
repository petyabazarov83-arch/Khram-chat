const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Увеличиваем лимиты размера передаваемых данных
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Настройки WebSocket для поддержки передачи файлов и работы под Render
const io = new Server(server, {
  maxHttpBufferSize: 1e9, // Лимит 1 ГБ на пакет
  pingTimeout: 60000,     // 60 секунд ожидания ответа
  pingInterval: 25000,    // Пинг каждые 25 секунд
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Хранилища данных сервера Храма
const registeredUsers = new Map();
const socketToUid = new Map();
const groups = new Map();

function broadcastOnlineUsers() {
  const onlineUids = Array.from(socketToUid.values());
  io.emit('online-users-list', Array.from(new Set(onlineUids)));
}

function cleanPhone(phoneStr) {
  if (!phoneStr) return '';
  const digits = String(phoneStr).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

io.on('connection', (socket) => {

  // Регистрация / сохранение профиля
  socket.on('register', (user) => {
    if (!user || !user.uid) return;

    socketToUid.set(socket.id, user.uid);

    let userData = registeredUsers.get(user.uid) || { socketIds: new Set() };
    userData.uid = user.uid;
    userData.username = user.username || 'Путник';
    userData.avatar = user.avatar || '';
    userData.phoneRaw = user.phone || '';
    userData.phoneClean = cleanPhone(user.phone);

    if (!userData.socketIds) userData.socketIds = new Set();
    userData.socketIds.add(socket.id);

    registeredUsers.set(user.uid, userData);
    
    socket.join(user.uid);

    // Присоединяем к ранее созданным группам
    groups.forEach((g) => {
      if (g.members && g.members.has(user.uid)) {
        socket.join(g.id);
      }
    });

    broadcastOnlineUsers();

    io.emit('user-profile-updated', {
      uid: userData.uid,
      username: userData.username,
      avatar: userData.avatar,
      phone: userData.phoneRaw
    });
  });

  // Синхронизация контактов по телефонам
  socket.on('sync-contacts', (phoneNumbers) => {
    if (!Array.isArray(phoneNumbers)) return;

    const searchPhonesClean = phoneNumbers
      .map(p => cleanPhone(p))
      .filter(p => p.length >= 7);

    const matchedUsers = [];

    registeredUsers.forEach((u) => {
      if (u.phoneClean && searchPhonesClean.includes(u.phoneClean)) {
        matchedUsers.push({
          uid: u.uid,
          name: u.username,
          avatar: u.avatar,
          phone: u.phoneRaw
        });
      }
    });

    socket.emit('contacts-synced', matchedUsers);
  });

  // Создание групп
  socket.on('create-group', ({ name, members, ownerUid }) => {
    const groupId = 'group-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    const membersSet = new Set(members || []);
    membersSet.add(ownerUid);

    const newGroup = {
      id: groupId,
      name: name || 'Новая Группа',
      ownerUid: ownerUid,
      admins: new Set([ownerUid]),
      members: membersSet,
      bgImage: ''
    };

    groups.set(groupId, newGroup);

    membersSet.forEach(mUid => {
      const u = registeredUsers.get(mUid);
      if (u && u.socketIds) {
        u.socketIds.forEach(sId => {
          const clientSocket = io.sockets.sockets.get(sId);
          if (clientSocket) clientSocket.join(groupId);
        });
      }
      
      io.to(mUid).emit('group-created', {
        id: newGroup.id,
        name: newGroup.name,
        ownerUid: newGroup.ownerUid,
        admins: Array.from(newGroup.admins),
        members: Array.from(newGroup.members),
        bgImage: newGroup.bgImage
      });
    });
  });

  // Изменение и синхронизация фона в группе
  socket.on('update-group-bg', ({ groupId, bgImage, userUid }) => {
    const g = groups.get(groupId);
    if (g) {
      g.bgImage = bgImage;
      io.to(groupId).emit('group-bg-updated', { groupId, bgImage });
    }
  });

  // Отправка сообщений, файлов и медиа
  socket.on('chat message', (data) => {
    if (!data) return;

    const sender = registeredUsers.get(data.senderUid) || {
      uid: data.senderUid,
      username: 'Пользователь',
      avatar: ''
    };

    const msgPayload = {
      id: data.id || Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      senderUid: sender.uid,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetUid: data.targetUid,
      isGroup: Boolean(data.isGroup),
      type: data.type || 'text',
      content: data.content || '',
      fileData: data.fileData || null,
      fileName: data.fileName || '',
      fileSize: data.fileSize || 0,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (data.isGroup) {
      io.to(data.targetUid).emit('chat message', msgPayload);
      return;
    }

    // Ответ ИИ Помощника Храма
    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgPayload);
      setTimeout(() => {
        socket.emit('chat message', {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          targetUid: sender.uid,
          type: 'text',
          content: `🤖 Принято в Храме! Файл/Сообщение "${data.fileName || data.content || 'Файл'}" успешно обработано.`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }, 400);
      return;
    }

    io.to(sender.uid).emit('chat message', msgPayload);
    io.to(data.targetUid).emit('chat message', msgPayload);
  });

  // Удаление сообщений
  socket.on('delete message', (data) => {
    if (data.isGroup) {
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    } else {
      io.to(data.senderUid).emit('message deleted', { msgId: data.msgId });
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    }
  });

  // Удаление чатов
  socket.on('delete-chat', ({ chatId, isGroup, userUid }) => {
    if (isGroup) {
      groups.delete(chatId);
      io.to(chatId).emit('chat-deleted', { chatId, isGroup: true });
    } else {
      io.to(userUid).emit('chat-deleted', { chatId, isGroup: false });
      io.to(chatId).emit('chat-deleted', { chatId, isGroup: false });
    }
  });

  // Звонки (личные и групповые)
  socket.on('call-user', (data) => {
    const sender = registeredUsers.get(data.senderUid);
    const payload = {
      fromUid: data.senderUid,
      fromName: sender ? sender.username : 'Собеседник',
      fromAvatar: sender ? sender.avatar : '',
      offer: data.offer,
      isGroup: data.isGroup || false,
      targetUid: data.targetUid
    };

    if (data.isGroup) {
      socket.to(data.targetUid).emit('incoming-call', payload);
    } else {
      io.to(data.targetUid).emit('incoming-call', payload);
    }
  });

  socket.on('make-answer', (data) => {
    if (data.isGroup) {
      socket.to(data.targetUid).emit('call-answered', {
        answer: data.answer,
        fromUid: socketToUid.get(socket.id)
      });
    } else if (data.targetUid) {
      io.to(data.targetUid).emit('call-answered', {
        answer: data.answer,
        fromUid: socketToUid.get(socket.id)
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    if (data.isGroup) {
      socket.to(data.targetUid).emit('ice-candidate', {
        candidate: data.candidate,
        fromUid: socketToUid.get(socket.id)
      });
    } else if (data.targetUid) {
      io.to(data.targetUid).emit('ice-candidate', {
        candidate: data.candidate,
        fromUid: socketToUid.get(socket.id)
      });
    }
  });

  socket.on('end-call', (data) => {
    if (data.targetUid) {
      if (data.isGroup) {
        socket.to(data.targetUid).emit('call-ended', {
          fromUid: socketToUid.get(socket.id),
          reason: data.reason || 'ended'
        });
      } else {
        io.to(data.targetUid).emit('call-ended', { reason: data.reason || 'ended' });
      }
    }
  });

  socket.on('disconnect', () => {
    const uid = socketToUid.get(socket.id);
    if (uid && registeredUsers.has(uid)) {
      const u = registeredUsers.get(uid);
      if (u.socketIds) u.socketIds.delete(socket.id);
    }
    socketToUid.delete(socket.id);
    broadcastOnlineUsers();
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер Храма запущен на порту ${PORT}`);
});
