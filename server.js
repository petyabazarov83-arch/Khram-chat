const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Лимит 100MB для файлов, аудио и видео-кружочков
const io = new Server(server, {
    maxHttpBufferSize: 1e8
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище подписок на Web Push
let pushSubscriptions = [];

app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    pushSubscriptions.push(subscription);
    res.status(201).json({});
});

function sendPushNotification(title, body) {
    const payload = JSON.stringify({ title, body });
    pushSubscriptions.forEach((sub, index) => {
        webpush.sendNotification(sub, payload).catch(() => {
            pushSubscriptions.splice(index, 1);
        });
    });
}

// Socket.IO
io.on('connection', (socket) => {
    console.log('Пользователь подключился:', socket.id);

    // Обработка сообщений
    socket.on('sendMessage', (data) => {
        io.emit('newMessage', {
            sender: socket.id,
            ...data
        });

        let notifText = 'Новое сообщение';
        if (data.type === 'image') notifText = '📷 Новое фото';
        if (data.type === 'audio') notifText = '🎤 Голосовое сообщение';
        if (data.type === 'circle') notifText = '⭕ Видеосообщение (кружочек)';
        if (data.type === 'file') notifText = '📁 Новый файл';

        sendPushNotification('Khram Messenger', notifText);
    });

    // WebRTC Сигнализация для видеозвонков
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер успешно запущен на порту ${PORT}`);
});
