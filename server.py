import os
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'

# Увеличиваем буфер до 30МБ для передачи тяжелых видео и фото в base64
socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=30 * 1024 * 1024)

# Глобальное состояние доски (хранится до перезагрузки сервера)
board_state = {
    "lines": [],
    "texts": [],
    "images": [],
    "videos": []
}

ADMIN_PASSWORD = "hasker"

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

@socketio.on('connect')
def handle_connect():
    print(f"Client connected: {request.sid}")
    # При подключении отправляем пользователю все накопленные данные
    emit('init', board_state)

@socketio.on('draw')
def handle_draw(data):
    # Сохраняем линию в память сервера
    board_state["lines"].append(data)
    # Транслируем всем остальным
    emit('draw', data, broadcast=True, include_self=False)

@socketio.on('text_add')
def handle_text(data):
    board_state["texts"].append(data)
    emit('text_add', data, broadcast=True, include_self=False)

@socketio.on('media_add')
def handle_media(data):
    target = "images" if data.get('type') == 'image' else "videos"
    board_state[target].append(data)
    emit('media_add', data, broadcast=True, include_self=False)

@socketio.on('media_move')
def handle_move(data):
    # Поиск и обновление координат объекта в памяти сервера
    obj_id = data.get('id')
    obj_type = data.get('type')
    
    # Определяем, в каком списке искать (текст, фото или видео)
    target_list = None
    if 'text' in data:
        target_list = board_state["texts"]
    elif obj_type == 'image':
        target_list = board_state["images"]
    else:
        target_list = board_state["videos"]

    if target_list:
        for i, item in enumerate(target_list):
            if item.get('id') == obj_id:
                target_list[i]['x'] = data['x']
                target_list[i]['y'] = data['y']
                break
                
    emit('media_move', data, broadcast=True, include_self=False)

@socketio.on('clear')
def handle_clear(data):
    if data.get('password') == ADMIN_PASSWORD:
        # Полная очистка всех списков
        board_state["lines"].clear()
        board_state["texts"].clear()
        board_state["images"].clear()
        board_state["videos"].clear()
        print("Board cleared by admin")
        emit('clear', broadcast=True)

if __name__ == '__main__':
    # Запуск на порту 5000, доступно по локальной сети
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)

