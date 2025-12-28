const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const panel = document.getElementById('settingsPanel');
const btn = document.getElementById('settingsBtn');
const overlay = document.getElementById('overlay');
const clearBtn = document.getElementById('clearAllBtn');

let W = window.innerWidth;
let H = window.innerHeight;
canvas.width = W;
canvas.height = H;

// Состояние камеры
let scale = 1;          
let tx = 0, ty = 0;     
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

// Состояние кисти
let state = { size: 3, textSize: 24, color: '#000000' };
let lines = [];   
let texts = [];   

// Флаги взаимодействия
let drawing = false;
let lastWorld = null;      
let draggingText = null;
let pressTimer = null;
let pendingTextCoords = null; 

// Pinch / Pan / Inertia
let pinch = null; 
let inertiaFrame = null;
let panVx = 0, panVy = 0;

// --- Панель настроек ---
btn.onclick = () => { panel.classList.add('open'); overlay.classList.add('show'); };
overlay.onclick = () => { 
    panel.classList.remove('open'); 
    overlay.classList.remove('show'); 
    closeModals();
};

// --- Трансформация координат ---
function screenToWorld(sx, sy) {
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
}
function worldToScreen(wx, wy) {
    return { x: wx * scale + tx, y: wy * scale + ty };
}

// --- Отрисовка ---
function redraw() {
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0, 0, W, H);

    // Рисуем линии
    for (const l of lines) {
        const a = worldToScreen(l.from.x, l.from.y);
        const b = worldToScreen(l.to.x, l.to.y);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = l.size * scale;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }
    // Рисуем тексты
    for (const t of texts) {
        const fontSize = Math.max(6, t.size * scale);
        ctx.font = `${fontSize}px Arial`;
        ctx.fillStyle = t.color;
        const pos = worldToScreen(t.x, t.y);
        ctx.fillText(t.text, pos.x, pos.y);
    }
}

// --- Инерция ---
function startInertia() {
    if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
    function step() {
        tx += panVx;
        ty += panVy;
        panVx *= 0.92;
        panVy *= 0.92;
        redraw();
        if (Math.abs(panVx) > 0.1 || Math.abs(panVy) > 0.1) {
            inertiaFrame = requestAnimationFrame(step);
        } else {
            inertiaFrame = null;
        }
    }
    inertiaFrame = requestAnimationFrame(step);
}

// --- Вспомогательные функции для тача ---
function dist(p1, p2) { return Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY); }
function midPoint(p1, p2) { return { x: (p1.clientX + p2.clientX)/2, y: (p1.clientY + p2.clientY)/2 }; }

function textHitTest(sx, sy) {
    for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        const fontSize = Math.max(6, t.size * scale);
        ctx.font = `${fontSize}px Arial`;
        const width = ctx.measureText(t.text).width;
        const pos = worldToScreen(t.x, t.y);
        if (sx >= pos.x - 10 && sx <= pos.x + width + 10 && sy >= pos.y - fontSize && sy <= pos.y + 10) return t;
    }
    return null;
}

// --- ОБРАБОТЧИКИ ТАЧА ---
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; panVx = panVy = 0; }

    if (e.touches.length === 2) {
        const a = e.touches[0], b = e.touches[1];
        pinch = {
            startDist: dist(a, b),
            startScale: scale,
            startTx: tx, startTy: ty,
            startCenter: midPoint(a, b),
            lastCenter: midPoint(a, b),
            lastTime: performance.now()
        };
        return;
    }

    const t = e.touches[0];
    const world = screenToWorld(t.clientX, t.clientY);
    
    const hit = textHitTest(t.clientX, t.clientY);
    if (hit) {
        draggingText = hit;
    } else {
        drawing = true;
        lastWorld = world;
        pendingTextCoords = world;
        // Таймер для вызова модалки текста (Long Press)
        pressTimer = setTimeout(() => {
            drawing = false;
            document.getElementById('textModal').classList.add('show');
            document.getElementById('modalTextInput').focus();
        }, 600);
    }
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }

    if (e.touches.length === 2 && pinch) {
        const m = midPoint(e.touches[0], e.touches[1]);
        const d = dist(e.touches[0], e.touches[1]);
        
        let newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, pinch.startScale * (d / pinch.startDist)));
        
        const pwx = (pinch.startCenter.x - pinch.startTx) / pinch.startScale;
        const pwy = (pinch.startCenter.y - pinch.startTy) / pinch.startScale;
        
        tx = m.x - pwx * newScale;
        ty = m.y - pwy * newScale;
        
        const now = performance.now();
        const dt = Math.max(1, now - pinch.lastTime);
        panVx = (m.x - pinch.lastCenter.x) / (dt / 16);
        panVy = (m.y - pinch.lastCenter.y) / (dt / 16);
        
        pinch.lastCenter = m;
        pinch.lastTime = now;
        scale = newScale;
        redraw();
        return;
    }

    const w = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    if (draggingText) {
        draggingText.x = w.x; draggingText.y = w.y;
        socket.emit('text_move', draggingText);
        redraw();
    } else if (drawing && lastWorld) {
        const line = { from: {x: lastWorld.x, y: lastWorld.y}, to: {x: w.x, y: w.y}, size: state.size, color: state.color };
        lines.push(line);
        socket.emit('draw', line);
        lastWorld = w;
        redraw();
    }
});

canvas.addEventListener('touchend', () => {
    if (pinch && (Math.abs(panVx) > 0.5 || Math.abs(panVy) > 0.5)) startInertia();
    clearTimeout(pressTimer);
    drawing = false;
    pinch = null;
    draggingText = null;
});

// --- ЛОГИКА МОДАЛОК ---
function closeModals() {
    document.querySelectorAll('.custom-modal').forEach(m => m.classList.remove('show'));
    document.getElementById('modalTextInput').value = '';
    document.getElementById('modalPassInput').value = '';
}

document.getElementById('textConfirm').onclick = () => {
    const val = document.getElementById('modalTextInput').value;
    if (val && pendingTextCoords) {
        const tObj = { id: Date.now(), text: val, x: pendingTextCoords.x, y: pendingTextCoords.y, size: state.textSize, color: state.color };
        texts.push(tObj);
        socket.emit('text_add', tObj);
        redraw();
    }
    closeModals();
};

clearBtn.onclick = () => document.getElementById('passwordModal').classList.add('show');

document.getElementById('passConfirm').onclick = () => {
    const pwd = document.getElementById('modalPassInput').value;
    socket.emit('clear', { password: pwd });
    closeModals();
};

document.querySelectorAll('#textCancel, #passCancel').forEach(b => b.onclick = closeModals);

// --- SOCKETS ---
socket.on('init', d => { lines = d.lines || []; texts = d.texts || []; redraw(); });
socket.on('draw', l => { lines.push(l); redraw(); });
socket.on('text_add', t => { texts.push(t); redraw(); });
socket.on('text_move', t => { 
    const i = texts.findIndex(x => x.id === t.id); 
    if(i !== -1) texts[i] = t; 
    redraw(); 
});
socket.on('clear', () => { lines = []; texts = []; redraw(); });

// Настройки из панели
document.getElementById('brushSize').oninput = e => state.size = +e.target.value;
document.getElementById('textSize').oninput = e => state.textSize = +e.target.value;

window.onresize = () => { W = window.innerWidth; H = window.innerHeight; canvas.width = W; canvas.height = H; redraw(); };
