const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройка Express для приема больших payload (до 500 МБ)
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Настройки Socket.IO с увеличенными таймаутами для файлов и медиа
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

// ==========================================
// ХРАНИЛИЩА ДАННЫХ В ПАМЯТИ СЕРВЕРА
// ==========================================
const users = new Map(); // socket.id -> profile
const groups = new Map(); // groupId -> groupObject
const messageHistory = new Map(); // chatId -> Array of messages

const BOT_UID = 'bot-assistant';

// ==========================================
// ОСНОВНАЯ ЛОГИКА SOCKET.IO
// ==========================================
io.on('connection', (socket) => {

  // 1. РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ
  socket.on('register', (profile) => {
    if (!profile || !profile.uid) return;

    socket.userData = profile;
    users.set(socket.id, profile);

    // Подключаем сокет к комнате с его UID
    socket.join(profile.uid);

    // Авто-вход во все его группы
    groups.forEach((group, groupId) => {
      if (group.members && group.members.includes(profile.uid)) {
        socket.join(groupId);
      }
    });

    broadcastOnlineUsers();
  });

  // 2. ОБРАБОТКА И МАРШРУТИЗАЦИЯ СООБЩЕНИЙ (КРУЖКИ, ФАЙЛЫ, ТЕКСТ)
  socket.on('chat message', (msg) => {
    if (!msg || !msg.targetUid) return;

    // Гарантируем наличие уникального ID сообщения
    if (!msg.id) {
      msg.id = 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    }

    const chatId = msg.isGroup ? msg.targetUid : (
      [msg.senderUid, msg.targetUid].sort().join('_')
    );

    // Сохранение истории на сервере
    if (!messageHistory.has(chatId)) {
      messageHistory.set(chatId, []);
    }
    const history = messageHistory.get(chatId);
    history.push(msg);

    // Ограничение истории в ОЗУ (до 500 сообщений)
    if (history.length > 500) history.shift();

    // ОБРАБОТКА БОТА
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

    // МАРШРУТИЗАЦИЯ ОБЫЧНЫХ И ГРУППОВЫХ ЧАТОВ
    if (msg.isGroup) {
      // Отправляем ВСЕМ в комнате группы (включая отправителя)
      io.to(msg.targetUid).emit('chat message', msg);
    } else {
      // 1. Отправка Получателю
      io.to(msg.targetUid).emit('chat message', msg);
      // 2. Отправка Отправителю (на все его устройства)
      io.to(msg.senderUid).emit('chat message', msg);
    }
  });

  // 3. ЗАПРОС ИСТОРИИ СООБЩЕНИЙ
  socket.on('get-chat-history', (data) => {
    if (!data || !data.targetUid || !data.myUid) return;
    
    const chatId = data.isGroup ? data.targetUid : (
      [data.myUid, data.targetUid].sort().join('_')
    );
    const history = messageHistory.get(chatId) || [];
    socket.emit('chat-history', { chatId, targetUid: data.targetUid, history });
  });

  // 4. СОЗДАНИЕ ГРУППЫ
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

    // Подключаем участников к комнате Socket.IO
    for (const [sId, uProfile] of users.entries()) {
      if (members.includes(uProfile.uid)) {
        const memberSocket = io.sockets.sockets.get(sId);
        if (memberSocket) memberSocket.join(groupId);
      }
    }

    io.to(groupId).emit('group-created', newGroup);
  });

  // 5. УДАЛЕНИЕ ЧАТА
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

  // 6. СИНХРОНИЗАЦИЯ КОНТАКТОВ
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

  // 7. WEBRTC СИГНАЛИНГ
  socket.on('call-user', (data) => {
    const senderUid = socket.userData ? socket.userData.uid : data.senderUid;
    const senderName = socket.userData ? socket.userData.username : 'Пользователь';

    socket.to(data.targetUid).emit('incoming-call', {
      fromUid: senderUid,
      fromName: senderName,
      offer: data.offer,
      isGroup: data.isGroup,
      targetUid: data.targetUid
    });
  });

  socket.on('make-answer', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    socket.to(data.targetUid).emit('call-answered', {
      fromUid: fromUid,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    socket.to(data.targetUid).emit('ice-candidate', {
      fromUid: fromUid,
      candidate: data.candidate
    });
  });

  socket.on('end-call', (data) => {
    const fromUid = socket.userData ? socket.userData.uid : '';
    socket.to(data.targetUid).emit('call-ended', {
      fromUid: fromUid
    });
  });

  // 8. ОТКЛЮЧЕНИЕ СОКЕТА
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
  if (lower.includes('привет') || lower.includes('здравствуй')) {
    return 'Приветствую! Чем могу помочь в мессенджере Храм?';
  }
  if (lower.includes('как дела')) {
    return 'Всё отлично, работаю 24/7 и готов передавать твои сообщения!';
  }
  if (lower.includes('звонок') || lower.includes('видео')) {
    return 'Чтобы совершить звонок, открой нужный чат и нажми кнопку «📞 Звонок» сверху.';
  }
  return `Вы написали: "${text}". Я ИИ Помощник, ваш локальный ассистент!`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Сервер ХРАМ успешно запущен на порту ${PORT}`);
  console.log(`=================================`);
});
