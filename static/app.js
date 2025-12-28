const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const panel = document.getElementById('settingsPanel');
const widgetContainer = document.getElementById('widget-container');

// Базовые переменные окружения
let W = window.innerWidth, H = window.innerHeight;
canvas.width = W; 
canvas.height = H;

// Состояние трансформации (Зум и Смещение)
let scale = 1.0;
let tx = 0;
let ty = 0;

// Состояние кисти и инструментов
let brushState = {
    size: 3,
    color: '#000000'
};

// Хранилище объектов доски
let lines = [];
let texts = [];
let images = [];
let videos = [];

// Кэш для медиа-элементов (чтобы не моргали при перерисовке)
let imageCache = {};
let videoCache = {};

// Состояние взаимодействия
let drawing = false;
let lastWorld = null;
let draggingObj = null;
let pinch = null;
let isActuallyMoving = false;
let pressTimer = null;
let pendingTextCoords = null;

// Математика координат: Экран -> Мир и Мир -> Экран
const screenToWorld = (sx, sy) => ({
    x: (sx - tx) / scale,
    y: (sy - ty) / scale
});

const worldToScreen = (wx, wy) => ({
    x: wx * scale + tx,
    y: wy * scale + ty
});

// ГЛАВНАЯ ФУНКЦИЯ ОТРИСОВКИ
function redraw() {
    // Сброс матрицы трансформации для очистки экрана
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Рисуем Видео и Картинки
    const allMedia = [...videos, ...images];
    allMedia.forEach(item => {
        const media = item.type === 'video' ? ensureVideo(item) : ensureImage(item);
        if (!media) return;

        // Проверка готовности (для картинок) или метаданных (для видео)
        const isReady = item.type === 'video' ? media.videoWidth > 0 : media.complete;
        if (!isReady) return;

        const pos = worldToScreen(item.x, item.y);
        const baseW = item.type === 'video' ? media.videoWidth : media.width;
        const baseH = item.type === 'video' ? media.videoHeight : media.height;
        
        const drawW = baseW * (item.scale || 0.5) * scale;
        const drawH = baseH * (item.scale || 0.5) * scale;

        // --- ДОБАВЛЕНО: ОТРИСОВКА ТОНКОЙ ЧЕРНОЙ РАМКИ ---
        ctx.save(); // Сохраняем состояние контекста
        ctx.strokeStyle = '#000000'; // Черный цвет
        ctx.lineWidth = 1.5 * scale;  // Тонкая линия, масштабируемая с зумом
        // Рисуем рамку чуть шире контента, чтобы она была видна поверх краев
        ctx.strokeRect(pos.x - drawW / 2, pos.y - drawH / 2, drawW, drawH);
        ctx.restore(); // Возвращаем состояние

        // Рисуем само изображение или кадр видео
        ctx.drawImage(media, pos.x - drawW / 2, pos.y - drawH / 2, drawW, drawH);

        // Индикатор паузы для видео
        if (item.type === 'video' && media.paused) {
            ctx.fillStyle = "rgba(0,0,0,0.4)";
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, 40 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.moveTo(pos.x - 15 * scale, pos.y - 20 * scale);
            ctx.lineTo(pos.x + 25 * scale, pos.y);
            ctx.lineTo(pos.x - 15 * scale, pos.y + 20 * scale);
            ctx.fill();
        }
    });

    // Рисуем Линии (Кисть)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    lines.forEach(l => {
        const start = worldToScreen(l.from.x, l.from.y);
        const end = worldToScreen(l.to.x, l.to.y);
        ctx.strokeStyle = l.color || '#000000';
        ctx.lineWidth = (l.size || 3) * scale;
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
    });

    // Рисуем Текст
    texts.forEach(t => {
        const fontSize = Math.max(8, 24 * scale);
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.fillStyle = '#000000';
        const pos = worldToScreen(t.x, t.y);
        ctx.fillText(t.text, pos.x, pos.y);
    });
}

// Утилиты кэширования медиа
function ensureImage(d) {
    if (!imageCache[d.id]) {
        const img = new Image();
        img.src = d.src;
        img.onload = () => redraw();
        imageCache[d.id] = img;
    }
    return imageCache[d.id];
}

function ensureVideo(d) {
    if (!videoCache[d.id]) {
        const v = document.createElement('video');
        v.src = d.src;
        v.loop = true;
        v.muted = true; 
        v.playsInline = true;
        v.crossOrigin = "anonymous";
        v.onloadedmetadata = () => redraw();
        videoCache[d.id] = v;
    }
    return videoCache[d.id];
}

// Цикл анимации (60 FPS)
function animate() {
    redraw();
    requestAnimationFrame(animate);
}
animate();

// СОБЫТИЯ СЕНСОРА (TOUCH)
canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    isActuallyMoving = false;

    // Режим ZOOM (Два пальца)
    if (e.touches.length === 2) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const center = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2
        };
        pinch = { dist, scale, tx, ty, center };
        return;
    }

    // Режим Одиночного касания
    const touch = e.touches[0];
    const worldPos = screenToWorld(touch.clientX, touch.clientY);

    // Проверка попадания в объект (приоритет медиа)
    let hit = [...images, ...videos, ...texts].find(obj => {
        const sPos = worldToScreen(obj.x, obj.y);
        // Зона клика зависит от размера объекта
        const d = Math.hypot(sPos.x - touch.clientX, sPos.y - touch.clientY);
        return d < 70 * scale; 
    });

    if (hit) {
        draggingObj = hit;
    } else {
        // Рисование или подготовка к тексту
        drawing = true;
        lastWorld = worldPos;
        pendingTextCoords = worldPos;
        pressTimer = setTimeout(() => {
            if (drawing && !isActuallyMoving) {
                drawing = false;
                showTextModal();
            }
        }, 650);
    }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    clearTimeout(pressTimer);
    isActuallyMoving = true;

    // Логика ZOOM
    if (e.touches.length === 2 && pinch) {
        const t1 = e.touches[0], t2 = e.touches[1];
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const newScale = Math.max(0.1, Math.min(10, pinch.scale * (dist / pinch.dist)));
        
        // Масштабирование относительно центра пальцев
        const midX = (t1.clientX + t2.clientX) / 2;
        const midY = (t1.clientY + t2.clientY) / 2;

        scale = newScale;
        tx = midX - ((pinch.center.x - pinch.tx) / pinch.scale) * scale;
        ty = midY - ((pinch.center.y - pinch.ty) / pinch.scale) * scale;
        return;
    }

    const touch = e.touches[0];
    const worldPos = screenToWorld(touch.clientX, touch.clientY);

    // Перемещение объекта
    if (draggingObj) {
        draggingObj.x = worldPos.x;
        draggingObj.y = worldPos.y;
        socket.emit('media_move', draggingObj);
    } 
    // Рисование линии
    else if (drawing && lastWorld) {
        const newLine = {
            from: { x: lastWorld.x, y: lastWorld.y },
            to: { x: worldPos.x, y: worldPos.y },
            size: brushState.size,
            color: brushState.color
        };
        lines.push(newLine); // Локально пушим сразу для плавности
        socket.emit('draw', newLine);
        lastWorld = worldPos;
    }
}, { passive: false });

canvas.addEventListener('touchend', e => {
    // Переключение Play/Pause
    if (!isActuallyMoving && draggingObj && draggingObj.type === 'video') {
        const v = videoCache[draggingObj.id];
        if (v) {
            if (v.paused) {
                v.play().catch(() => {});
                v.muted = false;
            } else {
                v.pause();
            }
        }
    }
    drawing = false;
    draggingObj = null;
    pinch = null;
});

// ИНТЕРФЕЙС И КНОПКИ
function showTextModal() {
    document.getElementById('textModal').classList.add('show');
    const input = document.getElementById('modalTextInput');
    input.value = "";
    input.focus();
}

document.getElementById('textConfirm').onclick = () => {
    const val = document.getElementById('modalTextInput').value;
    if (val && pendingTextCoords) {
        const textObj = {
            id: 't' + Date.now(),
            text: val,
            x: pendingTextCoords.x,
            y: pendingTextCoords.y
        };
        texts.push(textObj);
        socket.emit('text_add', textObj);
    }
    document.getElementById('textModal').classList.remove('show');
};

// --- БЕЗОПАСНЫЙ БЛОК КНОПОК ---

// Кнопка открытия модалки пароля
const clearBtn = document.getElementById('clearAllBtn');
if (clearBtn) {
    clearBtn.onclick = () => {
        const passModal = document.getElementById('passwordModal');
        if (passModal) passModal.classList.add('show');
    };
}

// Кнопка подтверждения пароля
const passConf = document.getElementById('passConfirm');
if (passConf) {
    passConf.onclick = () => {
        const passInput = document.getElementById('modalPassInput');
        if (passInput) {
            socket.emit('clear', { password: passInput.value });
            passInput.value = "";
        }
        const passModal = document.getElementById('passwordModal');
        if (passModal) passModal.classList.remove('show');
    };
}

// Кнопка отмены пароля
const passCanc = document.getElementById('passCancel');
if (passCanc) {
    passCanc.onclick = () => {
        const passModal = document.getElementById('passwordModal');
        if (passModal) passModal.classList.remove('show');
    };
}

// Кнопка отмены текста
const textCanc = document.getElementById('textCancel');
if (textCanc) {
    textCanc.onclick = () => {
        const textModal = document.getElementById('textModal');
        if (textModal) textModal.classList.remove('show');
    };
}
// --- КОНЕЦ БЕЗОПАСНОГО БЛОКА ---


document.getElementById('brushSize').oninput = e => {
    brushState.size = parseInt(e.target.value);
};

document.getElementById('settingsBtn').onclick = () => {
    panel.classList.toggle('open');
    document.getElementById('overlay').classList.toggle('show');
};

document.getElementById('overlay').onclick = () => {
    panel.classList.remove('open');
    document.getElementById('overlay').classList.remove('show');
};

// ЗАГРУЗКА ФАЙЛОВ
document.getElementById('mediaUpload').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;

    const quality = parseFloat(document.getElementById('uploadQuality').value || 0.6);
    const scaleVal = parseFloat(document.getElementById('mediaScale').value || 0.5);
    const reader = new FileReader();

    reader.onload = event => {
        const isImg = file.type.startsWith('image');
        const worldCenter = screenToWorld(W/2, H/2);

        if (isImg) {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const tempCanvas = document.createElement('canvas');
                const tCtx = tempCanvas.getContext('2d');
                tempCanvas.width = img.width * quality;
                tempCanvas.height = img.height * quality;
                tCtx.drawImage(img, 0, 0, tempCanvas.width, tempCanvas.height);
                
                const dataUrl = tempCanvas.toDataURL('image/jpeg', quality);
                const obj = {
                    id: 'img_' + Date.now(),
                    type: 'image',
                    src: dataUrl,
                    x: worldCenter.x,
                    y: worldCenter.y,
                    scale: scaleVal
                };
                images.push(obj);
                socket.emit('media_add', obj);
            };
        } else {
            const obj = {
                id: 'vid_' + Date.now(),
                type: 'video',
                src: event.target.result,
                x: worldCenter.x,
                y: worldCenter.y,
                scale: scaleVal
            };
            videos.push(obj);
            socket.emit('media_add', obj);
        }
    };
    reader.readAsDataURL(file);
};

// СЕТЕВЫЕ СОБЫТИЯ
socket.on('init', data => {
    lines = data.lines || [];
    texts = data.texts || [];
    images = data.images || [];
    videos = data.videos || [];
    redraw();
});

socket.on('draw', line => {
    lines.push(line);
});

socket.on('text_add', t => {
    texts.push(t);
});

socket.on('media_add', m => {
    if (m.type === 'image') images.push(m);
    else videos.push(m);
});

socket.on('media_move', m => {
    let list = m.type === 'image' ? images : (m.type === 'video' ? videos : texts);
    let found = list.find(x => x.id === m.id);
    if (found) {
        found.x = m.x;
        found.y = m.y;
    }
});

socket.on('clear', () => {
    lines = []; texts = []; images = []; videos = [];
    imageCache = {}; videoCache = {};
    location.reload();
});

window.onresize = () => {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
    redraw();
};

