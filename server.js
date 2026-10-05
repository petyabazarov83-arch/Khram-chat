const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Увеличиваем лимит размера передаваемых данных до 100MB для видео/фото/ГС
const io = new Server(server, {
    maxHttpBufferSize: 1e8
});

app.use(express.json());
// Раздаем статические файлы из единственной папки public
app.use(express.static(path.join(__dirname, 'public')));

// Настройка ключей VAPID для Web Push (фоновые уведомления)
// Сгенерировать новые ключи можно командой: npx web-push generate-vapid-keys
const publicVapidKey = 'YOUR_PUBLIC_VAPID_KEY';
const privateVapidKey = 'YOUR_PRIVATE_VAPID_KEY';

if (publicVapidKey !== 'YOUR_PUBLIC_VAPID_KEY') {
    webpush.setVapidDetails(
        'mailto:admin@khram-mess.onrender.com',
        publicVapidKey,
        privateVapidKey
    );
}

// Хранилище подписок на фоновые Push-уведомления
let pushSubscriptions = [];

// Эндпоинт для подписки на фоновые Push-уведомления
app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    pushSubscriptions.push(subscription);
    res.status(201).json({});
});

// Функция отправки фонового push-уведомления на устройство
function sendPushNotification(title, body) {
    const payload = JSON.stringify({ title, body });
    pushSubscriptions.forEach((sub, index) => {
        webpush.sendNotification(sub, payload).catch((err) => {
            console.error('Ошибка отправки Push:', err);
            pushSubscriptions.splice(index, 1); // Удаляем недействительные подписки
        });
    });
}

// --- Socket.IO Обработка подключений и событий ---
io.on('connection', (socket) => {
    console.log('Пользователь подключен:', socket.id);

    // 1. Прием и рассылка сообщений (текст, фото, аудио, кружочки, файлы)
    socket.on('sendMessage', (data) => {
        // data включает: type ('text'|'image'|'audio'|'circle'|'file'), content, name
        io.emit('newMessage', {
            sender: socket.id,
            ...data
        });

        // Если браузер свернут, отправляем Push-уведомление
        let notifText = 'Новое сообщение';
        if (data.type === 'image') notifText = '📷 Новое фото';
        if (data.type === 'audio') notifText = '🎤 Голосовое сообщение';
        if (data.type === 'circle') notifText = '⭕ Видеосообщение (кружочек)';
        if (data.type === 'file') notifText = '📁 Новый файл';

        sendPushNotification('Khram Messenger', notifText);
    });

    // 2. WebRTC Сигнализация для видеозвонков
    socket.on('callUser', (data) => {
        socket.broadcast.emit('incomingCall', {
            from: socket.id,
            offer: data.offer
        });
        sendPushNotification('Входящий звонок', 'Вам кто-то звонит в Khram Messenger!');
    });

    socket.on('answerCall', (data) => {
        io.to(data.to).emit('callAccepted', data.signal);
    });

    socket.on('iceCandidate', (data) => {
        socket.broadcast.emit('iceCandidate', data);
    });

    socket.on('endCall', () => {
        socket.broadcast.emit('callEnded');
    });

    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
    });
});

// Запуск сервера на порту 3000 или порту от Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер успешно запущен на порту ${PORT}`);
});
