const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8 // 100 MB для пересылки больших файлов, аудио и видео
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ХРАНИЛИЩА ДАННЫХ В ПАМЯТИ СЕРВЕРА
// ==========================================
// Подключенные пользователи: socket.id -> profileData
const users = new Map();

// Сохраненные группы: groupId -> { id, name, members, ownerUid }
const groups = new Map();

// История сообщений: chatId -> [ array of messages ]
const messageHistory = new Map();

// ИИ Помощник Бот
const BOT_UID = 'bot-assistant';

// ==========================================
// ОСНОВНАЯ ЛОГИКА SOCKET.IO
// ==========================================
io.on('connection', (socket) => {

  // ------------------------------------------
  // 1. РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ И АВТО-ВХОД В КОМНАТЫ
  // ------------------------------------------
  socket.on('register', (profile) => {
    if (!profile || !profile.uid) return;

    socket.userData = profile;
    users.set(socket.id, profile);

    // Присоединяем персональный сокет к комнате собственного UID (нужно для синхронизации нескольких устройств)
    socket.join(profile.uid);

    // Автоматически подключаем к комнатам групп, где состоит этот UID
    groups.forEach((group, groupId) => {
      if (group.members.includes(profile.uid) || group.ownerUid === profile.uid) {
        socket.join(groupId);
      }
    });

    // Отправляем обновленный список онлайн-пользователей
    broadcastOnlineUsers();
  });

  // ------------------------------------------
  // 2. ОБРАБОТКА И МАРШРУТИЗАЦИЯ СООБЩЕНИЙ
  // ------------------------------------------
  socket.on('chat message', (msg) => {
    if (!msg || !msg.targetUid) return;

    const chatId = msg.isGroup ? msg.targetUid : (
      [msg.senderUid, msg.targetUid].sort().join('_')
    );

    // Сохраняем в историю сервера
    if (!messageHistory.has(chatId)) {
      messageHistory.set(chatId, []);
    }
    messageHistory.get(chatId).push(msg);

    // Если сообщение адресовано ИИ-Помощнику
    if (msg.targetUid === BOT_UID) {
      // Отправляем само сообщение отправителю
      io.to(msg.senderUid).emit('chat message', msg);

      // Генерируем авто-ответ от ИИ Помощника
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
        
        if (!messageHistory.has(chatId)) messageHistory.set(chatId, []);
        messageHistory.get(chatId).push(botReply);

        io.to(msg.senderUid).emit('chat message', botReply);
      }, 600);

      return;
    }

    // Если это ГРУППОВОЙ ЧАТ
    if (msg.isGroup) {
      // Рассылаем абсолютно всем в комнате группы (включая все устройства отправителя)
      io.to(msg.targetUid).emit('chat message', msg);
    } 
    // Если это ЛИЧНЫЙ ЧАТ
    else {
      // 1. Отправляем получателю (на все его устройства)
      io.to(msg.targetUid).emit('chat message', msg);

      // 2. Дублируем отправку на ВСЕ остальные устройства самого отправителя
      io.to(msg.senderUid).emit('chat message', msg);
    }
  });

  // ------------------------------------------
  // 3. ЗАПРОС ИСТОРИИ СООБЩЕНИЙ С СЕРВЕРА
  // ------------------------------------------
  socket.on('get-chat-history', (data) => {
    const chatId = data.isGroup ? data.targetUid : (
      [data.myUid, data.targetUid].sort().join('_')
    );
    const history = messageHistory.get(chatId) || [];
    socket.emit('chat-history', { chatId, history });
  });

  // ------------------------------------------
  // 4. СОЗДАНИЕ И УПРАВЛЕНИЕ ГРУППАМИ
  // ------------------------------------------
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

    // Подключаем все сокеты найденных онлайн-участников к новой комнате Socket.IO
    for (const [sId, uProfile] of users.entries()) {
      if (members.includes(uProfile.uid)) {
        const memberSocket = io.sockets.sockets.get(sId);
        if (memberSocket) {
          memberSocket.join(groupId);
        }
      }
    }

    // Рассылаем уведомление о создании всем участникам
    io.to(groupId).emit('group-created', newGroup);
  });

  // ------------------------------------------
  // 5. УДАЛЕНИЕ ЧАТА / ГРУППЫ
  // ------------------------------------------
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

  // ------------------------------------------
  // 6. СИНХРОНИЗАЦИЯ И ПОИСК КОНТАКТОВ
  // ------------------------------------------
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

  // ------------------------------------------
  // 7. WEBRTC СИГНАЛИНГ (ЗВОНКИ И ВИДЕО)
  // ------------------------------------------
  socket.on('call-user', (data) => {
    const senderUid = socket.userData ? socket.userData.uid : data.senderUid;
    const senderName = socket.userData ? socket.userData.username : 'Пользователь';

    if (data.isGroup) {
      socket.to(data.targetUid).emit('incoming-call', {
        fromUid: senderUid,
        fromName: senderName,
        offer: data.offer,
        isGroup: true,
        targetUid: data.targetUid
      });
    } else {
      socket.to(data.targetUid).emit('incoming-call', {
        fromUid: senderUid,
        fromName: senderName,
        offer: data.offer,
        isGroup: false
      });
    }
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
    if (data.isGroup) {
      socket.to(data.targetUid).emit('call-ended', { fromUid: fromUid });
    } else {
      socket.to(data.targetUid).emit('call-ended', { fromUid: fromUid });
    }
  });

  // ------------------------------------------
  // 8. ОТКЛЮЧЕНИЕ СОКЕТА
  // ------------------------------------------
  socket.on('disconnect', () => {
    users.delete(socket.id);
    broadcastOnlineUsers();
  });

  // Вспомогательная функция отправки онлайн-пользователей
  function broadcastOnlineUsers() {
    const onlineUids = Array.from(new Set(Array.from(users.values()).map(u => u.uid)));
    io.emit('online-users-list', onlineUids);
  }
});

// ------------------------------------------
// ПРОСТАЯ ЛОГИКА ОТВЕТОВ ИИ ПОМОЩНИКА
// ------------------------------------------
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

// ------------------------------------------
// ЗАПУСК СЕРВЕРА
// ------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Сервер ХРАМ успешно запущен на порту ${PORT}`);
  console.log(`=================================`);
});
