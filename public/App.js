const socket = io();

let localStream = null;
let peerConnection = null;
let mediaRecorder = null;
let recordedChunks = [];
let isAudioRecording = false;
let isCircleRecording = false;
let currentFacingMode = 'user';

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Регистрация Service Worker для фона
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
}

if ('Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission();
}

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

// Запись ГС и Кружочков
async function toggleAudioRecord() {
    const btn = document.getElementById('rec-audio-btn');
    if (!isAudioRecording) {
        await startRecording(false);
        btn.classList.add('recording');
        btn.innerText = '⏹ Стоп';
        isAudioRecording = true;
    } else {
        stopRecording();
        btn.classList.remove('recording');
        btn.innerText = '🎙️ ГС';
        isAudioRecording = false;
    }
}

async function toggleCircleRecord() {
    const btn = document.getElementById('rec-circle-btn');
    if (!isCircleRecording) {
        await startRecording(true);
        btn.classList.add('recording');
        btn.innerText = '⏹ Стоп';
        isCircleRecording = true;
    } else {
        stopRecording();
        btn.classList.remove('recording');
        btn.innerText = '⭕ Кружочек';
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

// Отображение сообщений
socket.on('newMessage', (msg) => {
    const container = document.getElementById('chat-container');
    const div = document.createElement('div');
    const isMy = msg.sender === socket.id;
    
    div.className = `msg-row ${isMy ? 'my' : ''}`;

    if (msg.type === 'text') {
        div.innerText = msg.content;
    } else if (msg.type === 'image') {
        div.innerHTML = `<img src="${msg.content}">`;
    } else if (msg.type === 'audio') {
        div.innerHTML = `<audio controls src="${msg.content}"></audio>`;
    } else if (msg.type === 'circle') {
        div.innerHTML = `<video class="circle-video" controls autoplay loop src="${msg.content}"></video>`;
    } else if (msg.type === 'file') {
        div.innerHTML = `<a href="${msg.content}" download="${msg.name}" style="color: #fff;">📁 ${msg.name}</a>`;
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
});

// Звонки и Управление Камерой/Микрофоном
function toggleCallPanel() {
    const panel = document.getElementById('call-section');
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
}

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
        document.getElementById('mic-btn').innerText = audioTrack.enabled ? '🎙️ Мик: Вкл' : '🎙️ Мик: Выкл';
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

        if (peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(newVideoTrack);
        }
    } catch (e) {
        console.warn("Камера недоступна:", e);
    }
}

async function startCall() {
    document.getElementById('call-section').style.display = 'flex';
    await initLocalStream();
    createPeerConnection();

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('callUser', { offer });
}

socket.on('incomingCall', async (data) => {
    document.getElementById('call-section').style.display = 'flex';
    if (!confirm('Принять звонок?')) return;

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
