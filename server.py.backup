from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# Состояние доски (сервер является источником правды)
state = {
    "lines": [],   # каждый элемент: { from: {x,y}, to: {x,y}, size, color }
    "texts": []    # каждый элемент: { id, text, x, y, size, color }
}

CLEAR_PASSWORD = "hasker"

# Статика
@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

# SOCKETS
@socketio.on('connect')
def on_connect():
    emit('init', state)

@socketio.on('draw')
def on_draw(data):
    # сохраняем на сервере (world coords)
    state["lines"].append(data)
    emit('draw', data, broadcast=True, include_self=False)

@socketio.on('text_add')
def on_text_add(data):
    state["texts"].append(data)
    emit('text_add', data, broadcast=True, include_self=False)

@socketio.on('text_move')
def on_text_move(data):
    for i, t in enumerate(state["texts"]):
        if t.get("id") == data.get("id"):
            state["texts"][i] = data
            break
    emit('text_move', data, broadcast=True, include_self=False)

@socketio.on('clear')
def on_clear(data):
    # data expected to be { password: "..." }
    password = data.get('password') if isinstance(data, dict) else None
    if password == CLEAR_PASSWORD:
        state["lines"].clear()
        state["texts"].clear()
        emit('clear', broadcast=True)
    else:
        # отправляем отказ только запросившему
        emit('clear_denied', {'msg': 'Неверный пароль'}, to=request.sid)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000)