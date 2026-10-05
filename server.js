const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

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

function broadcastOnlineUsers() {
  const onlineUids = Array.from(socketToUid.values());
  io.emit('online-users-list', Array.from(new Set(onlineUids)));
}

// Нормализация номера до 10 последних цифр
function normalizePhone10(phoneStr) {
  if (!phoneStr) return '';
  const digits = String(phoneStr).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

io.on('connection', (socket) => {

  socket.on('register', (user) => {
    if (!user || !user.uid) return;

    socketToUid.set(socket.id, user.uid);

    let userData = registeredUsers.get(user.uid) || { socketIds: new Set() };
    userData.uid = user.uid;
    userData.username = user.username || 'Путник';
    userData.avatar = user.avatar || '';
    userData.phone = normalizePhone10(user.phone);
    userData.socketIds.add(socket.id);

    registeredUsers.set(user.uid, userData);
    
    socket.join(user.uid);

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

  // ТОЧНЫЙ ПОИСК И ПОДКЛЮЧЕНИЕ ЧАТОВ ПО НОМЕРАМ
  socket.on('sync-contacts', (phoneNumbers) => {
    if (!Array.isArray(phoneNumbers)) return;

    const searchPhones10 = phoneNumbers
      .map(p => normalizePhone10(p))
      .filter(Boolean);

    const matchedUsers = [];

    registeredUsers.forEach((u) => {
      if (u.phone) {
        const userPhone10 = normalizePhone10(u.phone);
        if (userPhone10 && searchPhones10.includes(userPhone10)) {
          matchedUsers.push({
            uid: u.uid,
            name: u.username,
            avatar: u.avatar,
            phone: u.phone
          });
        }
      }
    });

    // Возвращаем найденных пользователей текущему сокету
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

  socket.on('update-group-bg', ({ groupId, bgImage, userUid }) => {
    const g = groups.get(groupId);
    if (g && (g.ownerUid === userUid || g.admins.has(userUid))) {
      g.bgImage = bgImage;
      io.to(groupId).emit('group-bg-updated', { groupId, bgImage });
    }
  });

  socket.on('chat message', (data) => {
    const sender = registeredUsers.get(data.senderUid) || {
      uid: data.senderUid,
      username: 'Пользователь',
      avatar: ''
    };

    const msgPayload = {
      id: data.id || Date.now() + Math.random(),
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
          type: 'text',
          content: `🤖 Получил ваше сообщение: "${data.content || '['+data.type+']'}"`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }, 500);
      return;
    }

    io.to(sender.uid).emit('chat message', msgPayload);
    io.to(data.targetUid).emit('chat message', msgPayload);
  });

  socket.on('delete message', (data) => {
    if (data.isGroup) {
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    } else {
      io.to(data.senderUid).emit('message deleted', { msgId: data.msgId });
      io.to(data.targetUid).emit('message deleted', { msgId: data.msgId });
    }
  });

  socket.on('delete-chat', ({ chatId, isGroup, userUid }) => {
    if (isGroup) {
      groups.delete(chatId);
      io.to(chatId).emit('chat-deleted', { chatId, isGroup: true });
    } else {
      io.to(userUid).emit('chat-deleted', { chatId, isGroup: false });
      io.to(chatId).emit('chat-deleted', { chatId, isGroup: false });
    }
  });

  socket.on('call-user', (data) => {
    const sender = registeredUsers.get(data.senderUid);
    if (data.isGroup) {
      socket.to(data.targetUid).emit('incoming-call', {
        fromUid: data.senderUid,
        fromName: sender ? sender.username : 'Собеседник',
        fromAvatar: sender ? sender.avatar : '',
        offer: data.offer,
        isGroup: true,
        groupId: data.targetUid
      });
    } else {
      io.to(data.targetUid).emit('incoming-call', {
        fromUid: data.senderUid,
        fromName: sender ? sender.username : 'Собеседник',
        fromAvatar: sender ? sender.avatar : '',
        offer: data.offer,
        isGroup: false
      });
    }
  });

  socket.on('make-answer', (data) => {
    if (data.targetUid) {
      io.to(data.targetUid).emit('call-answered', {
        answer: data.answer,
        fromUid: socketToUid.get(socket.id)
      });
    }
  });

  socket.on('ice-candidate', (data) => {
    if (data.targetUid) {
      io.to(data.targetUid).emit('ice-candidate', { candidate: data.candidate });
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
