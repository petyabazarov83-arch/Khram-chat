const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Поддержка передачи тяжелых файлов до 70 ГБ
app.use(express.json({ limit: '70gb' }));
app.use(express.urlencoded({ limit: '70gb', extended: true }));

const io = new Server(server, {
  maxHttpBufferSize: 1e9,
  cors: { origin: "*" }
});

app.use(express.static('public'));

const registeredUsers = new Map();
const socketToUid = new Map();
const groups = new Map();

// Создаем глобальную группу по умолчанию "храм"
const DEFAULT_GROUP_ID = 'group-hram-main';
groups.set(DEFAULT_GROUP_ID, {
  id: DEFAULT_GROUP_ID,
  name: 'храм',
  ownerUid: 'system',
  admins: new Set(['system']),
  members: new Set(),
  bgImage: ''
});

function broadcastOnlineUsers() {
  const onlineUids = Array.from(socketToUid.values());
  io.emit('online-users-list', Array.from(new Set(onlineUids)));
}

io.on('connection', (socket) => {

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

    // Добавляем всех по умолчанию в главную группу "храм"
    const hramGroup = groups.get(DEFAULT_GROUP_ID);
    if (hramGroup) {
      hramGroup.members.add(user.uid);
      socket.join(DEFAULT_GROUP_ID);
    }

    groups.forEach((g) => {
      if (g.members.has(user.uid)) {
        socket.join(g.id);
      }
    });

    broadcastOnlineUsers();

    io.emit('user-profile-updated', {
      uid: userData.uid,
      username: userData.username,
      avatar: userData.avatar
    });
  });

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

  socket.on('create-group', ({ name, members, ownerUid }) => {
    const groupId = 'group-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    const membersSet = new Set(members);
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
      if (u) {
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

  // Отправка и гарантированная передача сообщений (текст, фото, кружки, файлы)
  socket.on('chat message', (data) => {
    const sender = registeredUsers.get(data.senderUid) || {
      uid: data.senderUid,
      username: 'Пользователь',
      avatar: ''
    };

    const msgPayload = {
      id: data.id || (Date.now() + '-' + Math.random().toString(36).substring(2, 7)),
      senderUid: sender.uid,
      senderName: sender.username,
      senderAvatar: sender.avatar,
      targetUid: data.targetUid,
      isGroup: data.isGroup || false,
      type: data.type || 'text',
      content: data.content || '',
      fileName: data.fileName || '',
      fileSize: data.fileSize || 0,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (data.isGroup) {
      // Рассылка всем участникам группы (включая отправителя)
      io.to(data.targetUid).emit('chat message', msgPayload);
      return;
    }

    if (data.targetUid === 'bot-assistant') {
      socket.emit('chat message', msgPayload);
      setTimeout(() => {
        socket.emit('chat message', {
          id: Date.now() + 1,
          senderUid: 'bot-assistant',
          senderName: 'ИИ Помощник 🤖',
          targetUid: sender.uid,
          isGroup: false,
          type: 'text',
          content: `🤖 Получил ваше сообщение: "${data.content || '['+data.type+']'}"`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }, 500);
      return;
    }

    // Личные сообщения (ЛС)
    io.to(sender.uid).emit('chat message', msgPayload);
    if (sender.uid !== data.targetUid) {
      io.to(data.targetUid).emit('chat message', msgPayload);
    }
  });

  socket.on('delete message', (data) => {
    if (data.isGroup) {
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    } else {
      io.to(data.senderUid).emit('message deleted', { msgId: data.msgId });
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    }
  });

  // Логика звонков с WebRTC
  socket.on('call-user', (data) => {
    const sender = registeredUsers.get(data.senderUid);
    if (data.isGroup) {
      socket.to(data.targetUid).emit('incoming-call', {
        fromUid: data.senderUid,
        fromName: sender ? sender.username : 'Собеседник',
        fromAvatar: sender ? sender.avatar : '',
        fromSocketId: socket.id,
        offer: data.offer,
        isGroup: true,
        groupId: data.targetUid
      });
    } else {
      io.to(data.targetUid).emit('incoming-call', {
        fromUid: data.senderUid,
        fromName: sender ? sender.username : 'Собеседник',
        fromAvatar: sender ? sender.avatar : '',
        fromSocketId: socket.id,
        offer: data.offer,
        isGroup: false
      });
    }
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
      io.to(data.targetUid).emit('call-ended', { reason: data.reason || 'ended' });
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
