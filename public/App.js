const socket = io();

let localStream = null;
let peerConnection = null;
let mediaRecorder = null;
let recordedChunks = [];
let isAudioRecording = false;
let isCircleRecording = false;
let currentFacingMode = 'user'; // 'user' или 'environment'

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// --- 1. РЕГИСТРАЦИЯ SERVICE WORKER И УВЕДОМЛЕНИЙ ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

if ('Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
}

function triggerNotification(title, body) {
    if (document.hidden && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icon.png' });
    }
}

// --- 2. ОБРАБОТКА ЧАТА И МЕДИАФАЙЛОВ ---
function sendTextMessage() {
    const input = document.getElementById('message-input');
    if (!input.value.trim()) return;
    socket.emit('sendMessage', { type: 'text', content: input.value });
    input.value = '';
}

function sendFile(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const isImg = file.type.startsWith('image/');
        socket.emit('sendMessage', {
            type: isImg ? 'image' : 'file',
            content: e.target.result,
            name: file.name
        });
    };
    reader.readAsDataURL(file);
    input.value = '';
}

// Запись Аудио (ГС) и Кружочков без confirm()
async function toggleAudioRecord() {
    if (!isAudioRecording) {
        await startRecording(false);
        document.getElementById('record-audio-btn').classList.add('active');
        document.getElementById('record-audio-btn').innerText = '⏹ Остановить и отправить';
        isAudioRecording = true;
    } else {
        stopRecording('audio');
        document.getElementById('record-audio-btn').classList.remove('active');
        document.getElementById('record-audio-btn').innerText = '🎤 Записать ГС';
        isAudioRecording = false;
    }
}

async function toggleCircleRecord() {
    if (!isCircleRecording) {
        await startRecording(true);
        document.getElementById('record-circle-btn').classList.add('active');
        document.getElementById('record-circle-btn').innerText = '⏹ Остановить и отправить';
        isCircleRecording = true;
    } else {
        stopRecording('circle');
        document.getElementById('record-circle-btn').classList.remove('active');
        document.getElementById('record-circle-btn').innerText = '⭕ Записать Кружочек';
        isCircleRecording = false;
    }
}

async function startRecording(isVideo) {
    recordedChunks = [];
    const constraints = isVideo 
        ? { audio: true, video: { facingMode: 'user', width: 300, height: 300 } } 
        : { audio: true };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: isVideo ? 'video/webm' : 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
            socket.emit('sendMessage', {
                type: isVideo ? 'circle' : 'audio',
                content: reader.result
            });
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(track => track.stop());
    };

    mediaRecorder.start();
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

// Отображение сообщений в чате
socket.on('newMessage', (msg) => {
    const chatBox = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.style.margin = '8px 0';

    if (msg.type === 'text') {
        div.innerText = msg.content;
    } else if (msg.type === 'image') {
        div.innerHTML = `<img src="${msg.content}" style="max-width: 250px; border-radius: 8px;">`;
    } else if (msg.type === 'audio') {
        div.innerHTML = `<audio controls src="${msg.content}"></audio>`;
    } else if (msg.type === 'circle') {
        div.innerHTML = `<video class="circle-video" controls autoplay loop src="${msg.content}"></video>`;
    } else if (msg.type === 'file') {
        div.innerHTML = `<a href="${msg.content}" download="${msg.name}" style="color: #0088cc;">📁 ${msg.name}</a>`;
    }

    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;

    triggerNotification('Новое сообщение', 'Вам пришло новое медиафайлы или текст.');
});

// --- 3. ЗВОНКИ, КНОПКИ УПРАВЛЕНИЯ И ПЕРЕКЛЮЧЕНИЕ КАМЕР ---

async function initLocalStream() {
    if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { facingMode: currentFacingMode }
        });
        document.getElementById('local-video').srcObject = localStream;
    }
}

function toggleMic() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        document.getElementById('mic-btn').innerText = audioTrack.enabled ? '🎙 Микрофон: Вкл' : '🎙 Микрофон: Выкл';
    }
}

function toggleCam() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        document.getElementById('cam-btn').innerText = videoTrack.enabled ? '📹 Камера: Вкл' : '📹 Камера: Выкл';
    }
}

async function switchCamera() {
    if (!localStream) return;

    currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';

    // Останавливаем текущий видео-трек
    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) oldVideoTrack.stop();

    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { exact: currentFacingMode } }
        });
        const newVideoTrack = newStream.getVideoTracks()[0];

        localStream.removeTrack(oldVideoTrack);
        localStream.addTrack(newVideoTrack);
        document.getElementById('local-video').srcObject = localStream;

        // Если звонок уже активен, подменяем трек для собеседника
        if (peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack);
        }
    } catch (e) {
        console.warn("Выбранная камера недоступна:", e);
    }
}

async function startCall() {
    await initLocalStream();
    createPeerConnection();

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('callUser', { offer });
}

socket.on('incomingCall', async (data) => {
    triggerNotification('Входящий звонок', 'Вам кто-то звонит!');
    if (!confirm('Принять входящий звонок?')) return;

    await initLocalStream();
    createPeerConnection();

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answerCall', { to: data.from, signal: answer });
});

socket.on('callAccepted', async (signal) => {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
});

socket.on('iceCandidate', async (candidate) => {
    if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
});

function createPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('iceCandidate', e.candidate);
    };

    peerConnection.ontrack = (e) => {
        document.getElementById('remote-video').srcObject = e.streams[0];
    };
}

function endCall() {
    if (peerConnection) peerConnection.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    peerConnection = null;
    document.getElementById('local-video').srcObject = null;
    document.getElementById('remote-video').srcObject = null;
    socket.emit('endCall');
}

socket.on('callEnded', () => {
    endCall();
});
