const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

const io = new Server(server, {
  maxHttpBufferSize: 5e8, // 500 MB
  pingTimeout: 120000,
  pingInterval: 25000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const groups = new Map();
const messageHistory = new Map();

const BOT_UID = 'bot-assistant';

io.on('connection', (socket) => {

  socket.on('register', (profile) => {
    if (!profile || !profile.uid) return;
    socket.userData = profile;
    users.set(socket.id, profile);
    socket.join(profile.uid);

    groups.forEach((group, groupId) => {
      if (group.members && group.members.includes(profile.uid)) {
        socket.join(groupId);
      }
    });

    broadcastOnlineUsers();
  });

  socket.on('chat message', (msg) => {
    if (!msg || !msg.targetUid) return;

    if (!msg.id) {
      msg.id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    }

    const chatId = msg.isGroup ? msg.targetUid : (
      [msg.senderUid, msg.targetUid].sort().join('_')
    );

    if (!messageHistory.has(chatId)) {
      messageHistory.set(chatId, []);
    }
    const history = messageHistory.get(chatId);
    
    // Предотвращение дублирования
    if (!history.some(m => m.id === msg.id)) {
      history.push(msg);
      if (history.length > 500) history.shift();
    }

    if (msg.targetUid === BOT_UID) {
      io.to(msg.senderUid).emit('chat message', msg);

      setTimeout(() => {
        const botReply = {
          id: 'bot-msg-' + Date.now(),
          senderUid: BOT_UID,
          senderName: 'ИИ Помощник 🤖',
          targetUid: msg.senderUid,
          isGroup: false,
          type: 'text',
          content: generateBotResponse(msg.content),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        history.push(botReply);
        io.to(msg.senderUid).emit('chat message', botReply);
      }, 500);

      return;
    }

    if (msg.isGroup) {
      io.to(msg.targetUid).emit('chat message', msg);
    } else {
      io.to(msg.targetUid).emit('chat message', msg);
      io.to(msg.senderUid).emit('chat message', msg);
    }
  });

  socket.on('get-chat-history', (data) => {
    if (!data || !data.targetUid || !data.myUid) return;
    const chatId = data.isGroup ? data.targetUid : (
      [data.myUid, data.targetUid].sort().join('_')
    );
    const history = messageHistory.get(chatId) || [];
    socket.emit('chat-history', { chatId, targetUid: data.targetUid, history });
  });

  socket.on('create-group', (groupData) => {
    const groupId = 'group-' + Math.random().toString(36).substring(2, 9);
    const members = Array.from(new Set([...(groupData.members || []), groupData.ownerUid]));

    const newGroup = {
      id: groupId,
      name: groupData.name || 'Новая группа',
      members: members,
      ownerUid: groupData.ownerUid
    };

    groups.set(groupId, newGroup);

    for (const [sId, uProfile] of users.entries()) {
      if (members.includes(uProfile.uid)) {
        const memberSocket = io.sockets.sockets.get(sId);
        if (memberSocket) memberSocket.join(groupId);
      }
    }

    io.to(groupId).emit('group-created', newGroup);
  });

  socket.on('delete-chat', (data) => {
    if (data.isGroup) {
      const chatId = data.chatId;
      groups.delete(chatId);
      messageHistory.delete(chatId);
      io.to(chatId).emit('chat-deleted', { chatId, isGroup: true });
    } else {
      const chatId = [data.userUid, data.chatId].sort().join('_');
      messageHistory.delete(chatId);
      socket.emit('chat-deleted', { chatId: data.chatId, isGroup: false });
    }
  });

  socket.on('sync-contacts', (phones) => {
    if (!Array.isArray(phones)) return;
    const matchedContacts = [];
    const cleanPhones = phones.map(p => String(p).replace(/\D/g, ''));

    users.forEach((profile) => {
      if (profile.phone) {
        const userCleanPhone = String(profile.phone).replace(/\D/g, '');
        if (userCleanPhone && cleanPhones.includes(userCleanPhone)) {
          matchedContacts.push({
            uid: profile.uid,
            name: profile.username,
            avatar: profile.avatar,
            phone: profile.phone
          });
        }
      }
    });

    socket.emit('contacts-synced', matchedContacts);
  });

  // WebRTC Сигналинг (Полная рассылка всем участникам)
  socket.on('call-user', (data) => {
    const senderUid = socket.userData ? socket.userData.uid : data.senderUid;
    const senderName = socket.userData ? socket.userData.username : 'Пользователь';

    io.to(data.targetUid).emit('incoming-call', {
      fromUid: senderUid,
      fromName: senderName,
      offer: data.offer,
      isGroup: data.isGroup,
      targetUid: data.targetUid
    });
  });

  socket.on('make-answer', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    io.to(data.targetUid).emit('call-answered', {
      fromUid: fromUid,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    io.to(data.targetUid).emit('ice-candidate', {
      fromUid: fromUid,
      candidate: data.candidate
    });
  });

  socket.on('end-call', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    if (data.targetUid) {
      io.to(data.targetUid).emit('call-ended', { fromUid });
    }
  });

  socket.on('disconnect', () => {
    users.delete(socket.id);
    broadcastOnlineUsers();
  });

  function broadcastOnlineUsers() {
    const onlineUids = Array.from(new Set(Array.from(users.values()).map(u => u.uid)));
    io.emit('online-users-list', onlineUids);
  }
});

function generateBotResponse(text) {
  const lower = (text || '').toLowerCase();
  if (lower.includes('привет') || lower.includes('здравствуй')) return 'Приветствую! Чем могу помочь в мессенджере Храм?';
  if (lower.includes('как дела')) return 'Всё отлично, работаю 24/7!';
  return `Вы написали: "${text}". Я ИИ Помощник!`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер ХРАМ запущен на порту ${PORT}`);
});
