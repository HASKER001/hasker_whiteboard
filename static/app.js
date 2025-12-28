// ==========================
// app.js — клиент (рисование, текст, pinch-to-zoom + pan, inertia)
// ==========================
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

// трансформация "камеры"
let scale = 1;          // масштаб
let tx = 0, ty = 0;     // смещение (в пикселях экрана)
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

// состояние кисти / текста
let state = { size: 3, textSize: 24, color: '#000000' };

let lines = [];   // сохранённые линии (world coords)
let texts = [];   // сохранённые тексты (world coords)

// взаимодействие
let drawing = false;
let lastWorld = null;      // last point in world coords while drawing
let draggingText = null;
let pressTimer = null;

// pinch / pan
let pinch = null; // { startDist, startScale, startTx, startTy, startCenterScreen, lastCenterScreen, lastTime, velocityX, velocityY }
let inertiaFrame = null;

// UI panel
btn.onclick = () => { panel.classList.add('open'); overlay.classList.add('show'); };
overlay.onclick = () => { panel.classList.remove('open'); overlay.classList.remove('show'); };

// Prevent context menu on canvas (for right-click)
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ------------ coordinate transforms ------------
function screenToWorld(screenX, screenY) {
    // world = (screen - translate) / scale
    return { x: (screenX - tx) / scale, y: (screenY - ty) / scale };
}
function worldToScreen(worldX, worldY) {
    return { x: worldX * scale + tx, y: worldY * scale + ty };
}

// ------------ drawing helpers ------------
function drawLineOnScreen(ax, ay, bx, by, size, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * scale; // optionally scale stroke thickness visually
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
}
function drawTextOnScreen(t) {
    const fontSize = Math.max(6, t.size * scale);
    ctx.font = `${fontSize}px Arial`;
    ctx.fillStyle = t.color;
    const pos = worldToScreen(t.x, t.y);
    ctx.fillText(t.text, pos.x, pos.y);
}

function redraw() {
    ctx.setTransform(1,0,0,1,0,0); // reset
    ctx.clearRect(0, 0, W, H);
    // We'll draw using world->screen conversions for clarity
    // Draw lines
    for (const l of lines) {
        const a = worldToScreen(l.from.x, l.from.y);
        const b = worldToScreen(l.to.x, l.to.y);
        drawLineOnScreen(a.x, a.y, b.x, b.y, l.size, l.color);
    }
    // Draw texts
    for (const t of texts) {
        drawTextOnScreen(t);
    }
}

// ------------ hit tests ------------
function textHitTest(screenX, screenY) {
    // returns text object if hit
    for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        // measure text width at scaled size
        const fontSize = Math.max(6, t.size * scale);
        ctx.font = `${fontSize}px Arial`;
        const width = ctx.measureText(t.text).width;
        const pos = worldToScreen(t.x, t.y);
        const height = fontSize * 1.2;
        const left = pos.x - 12;
        const right = pos.x + width + 12;
        const top = pos.y - height / 2;
        const bottom = pos.y + height / 2;
        if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) return t;
    }
    return null;
}

// ------------ touch utilities ------------
function dist(p1, p2) {
    const dx = p1.clientX - p2.clientX;
    const dy = p1.clientY - p2.clientY;
    return Math.hypot(dx, dy);
}
function midPoint(p1, p2) {
    return { x: (p1.clientX + p2.clientX)/2, y: (p1.clientY + p2.clientY)/2 };
}

// ------------ inertia ------------
let panVx = 0, panVy = 0;
function startInertia() {
    if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
    function step() {
        // apply velocity
        tx += panVx;
        ty += panVy;
        panVx *= 0.92;
        panVy *= 0.92;
        redraw();
        if (Math.abs(panVx) > 0.1 || Math.abs(panVy) > 0.1) {
            inertiaFrame = requestAnimationFrame(step);
        } else {
            inertiaFrame = null;
            panVx = 0; panVy = 0;
        }
    }
    inertiaFrame = requestAnimationFrame(step);
}

// ------------ touch handlers ------------
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; panVx = panVy = 0; }

    if (e.touches.length === 2) {
        // start pinch/pan
        const a = e.touches[0], b = e.touches[1];
        const d = dist(a,b);
        const m = midPoint(a,b);
        pinch = {
            startDist: d,
            startScale: scale,
            startTx: tx,
            startTy: ty,
            startCenter: m,
            lastCenter: m,
            lastTime: performance.now()
        };
        return;
    }

    // single touch: test if hits text
    const t = e.touches[0];
    const hit = textHitTest(t.clientX, t.clientY);
    if (hit) {
        draggingText = hit;
        return;
    }

    // normal drawing: record starting world point
    const world = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    drawing = true;
    lastWorld = world;

    // long press for text addition
    pressTimer = setTimeout(() => {
        const text = prompt('Введите текст:');
        if (!text) return;
        const tObj = { id: Date.now(), text, x: world.x, y: world.y, size: state.textSize, color: state.color };
        texts.push(tObj);
        socket.emit('text_add', tObj);
        redraw();
    }, 500);
});

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }

    if (e.touches.length === 2 && pinch) {
        const a = e.touches[0], b = e.touches[1];
        const d = dist(a,b);
        const m = midPoint(a,b);
        // compute new scale
        let newScale = pinch.startScale * (d / pinch.startDist);
        newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));

        // adjust tx/ty so that the world point under the center remains under the center
        // world coord under center at start:
        // p_world = (center - startTx) / startScale
        const sx = pinch.startCenter.x;
        const sy = pinch.startCenter.y;
        const pwx = (sx - pinch.startTx) / pinch.startScale;
        const pwy = (sy - pinch.startTy) / pinch.startScale;
        // tx,ty so that pw maps to new center m (we prefer to keep center aligned to current center)
        tx = m.x - pwx * newScale;
        ty = m.y - pwy * newScale;

        // also add additional pan due to movement of center between frames
        const dtCenterX = m.x - pinch.lastCenter.x;
        const dtCenterY = m.y - pinch.lastCenter.y;
        tx += dtCenterX;
        ty += dtCenterY;

        // velocity for inertia
        const now = performance.now();
        const dt = Math.max(1, now - pinch.lastTime);
        panVx = dtCenterX / (dt / 16.67); // normalized per 16.67ms
        panVy = dtCenterY / (dt / 16.67);
        pinch.lastCenter = m;
        pinch.lastTime = now;

        scale = newScale;
        redraw();
        return;
    }

    // single touch move handlers
    const w = screenToWorld(e.touches[0].clientX, e.touches[0].clientY);
    if (draggingText) {
        draggingText.x = w.x;
        draggingText.y = w.y;
        socket.emit('text_move', draggingText);
        redraw();
        return;
    }

    if (drawing && lastWorld) {
        const line = { from: {x: lastWorld.x, y: lastWorld.y}, to: {x: w.x, y: w.y}, size: state.size, color: state.color };
        lines.push(line);
        socket.emit('draw', line);
        // draw incremental
        const a = worldToScreen(line.from.x, line.from.y);
        const b = worldToScreen(line.to.x, line.to.y);
        drawLineOnScreen(a.x, a.y, b.x, b.y, line.size, line.color);
        lastWorld = w;
    }
});

canvas.addEventListener('touchend', (e) => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (pinch) {
        // start inertia if velocity exists
        if (Math.abs(panVx) > 0.2 || Math.abs(panVy) > 0.2) startInertia();
        pinch = null;
    }
    drawing = false;
    draggingText = null;
    lastWorld = null;
});

// ------------ mouse support (wheel zoom + left-draw, middle-pan) ------------
let isMouseDown = false;
let mouseMode = null; // "draw" or "pan" or "dragtext"
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1 || e.button === 2) { // middle or right -> pan
        mouseMode = 'pan';
        isMouseDown = true;
        last = { x: e.clientX, y: e.clientY };
        if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; panVx = panVy = 0; }
        return;
    }
    // left button: check text hit
    const hit = textHitTest(e.clientX, e.clientY);
    if (hit) {
        mouseMode = 'dragtext';
        draggingText = hit;
        isMouseDown = true;
        return;
    }
    // else draw
    mouseMode = 'draw';
    isMouseDown = true;
    lastWorld = screenToWorld(e.clientX, e.clientY);
});
canvas.addEventListener('mousemove', (e) => {
    if (!isMouseDown) return;
    if (mouseMode === 'pan') {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        tx += dx;
        ty += dy;
        panVx = dx; panVy = dy;
        last = { x: e.clientX, y: e.clientY };
        redraw();
    } else if (mouseMode === 'dragtext' && draggingText) {
        const w = screenToWorld(e.clientX, e.clientY);
        draggingText.x = w.x;
        draggingText.y = w.y;
        socket.emit('text_move', draggingText);
        redraw();
    } else if (mouseMode === 'draw') {
        const w = screenToWorld(e.clientX, e.clientY);
        const line = { from: {x: lastWorld.x, y: lastWorld.y}, to: {x: w.x, y: w.y}, size: state.size, color: state.color };
        lines.push(line);
        socket.emit('draw', line);
        const a = worldToScreen(line.from.x, line.from.y);
        const b = worldToScreen(line.to.x, line.to.y);
        drawLineOnScreen(a.x, a.y, b.x, b.y, line.size, line.color);
        lastWorld = w;
    }
});
canvas.addEventListener('mouseup', (e) => {
    isMouseDown = false;
    mouseMode = null;
    draggingText = null;
    lastWorld = null;
    // start inertia
    if (Math.abs(panVx) > 1 || Math.abs(panVy) > 1) startInertia();
});
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.12 : 0.9;
    const mx = e.clientX, my = e.clientY;
    // compute world point under mouse BEFORE scale change:
    const worldX = (mx - tx) / scale;
    const worldY = (my - ty) / scale;
    // apply scale
    let newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * delta));
    // recompute tx/ty to keep world point under mouse
    tx = mx - worldX * newScale;
    ty = my - worldY * newScale;
    scale = newScale;
    redraw();
}, { passive: false });

// ------------ socket events ------------
socket.on('init', data => {
    lines = data.lines || [];
    texts = data.texts || [];
    redraw();
});
socket.on('draw', l => { lines.push(l); redraw(); });
socket.on('text_add', t => { texts.push(t); redraw(); });
socket.on('text_move', t => { const i = texts.findIndex(x => x.id === t.id); if (i !== -1) texts[i] = t; redraw(); });
socket.on('clear', () => { lines = []; texts = []; redraw(); });
socket.on('clear_denied', d => alert(d.msg));

// ------------ panel controls ------------
document.getElementById('brushSize').oninput = e => state.size = +e.target.value;
document.getElementById('textSize').oninput = e => state.textSize = +e.target.value;
clearBtn.onclick = () => {
    const pwd = prompt('Введите пароль для очистки:');
    if (!pwd) return;
    socket.emit('clear', { password: pwd });
};

// resize handling
window.addEventListener('resize', () => {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W; canvas.height = H;
    redraw();
});