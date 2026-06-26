/* UNIPULT - Frontend Client Logic */

// Глобальное состояние приложения
let socket = null;
let socketUrl = `ws://${window.location.host}/ws`;
let reconnectInterval = 2000; // Попытка переподключения каждые 2 сек
let isConnected = false;

// Локальные данные, приходящие от робота / редактируемые пользователем
let arucoMarkers = [];
let waypoints = [];

// Переменные для интерактивной карты
let scale = 35; // Пикселей на метр (масштаб)
let robotPose = { x: 0.0, y: 0.0, z: 0.0, yaw: 0.0 };
let robotTrail = []; // Массив пройденных точек для отрисовки следа

// Переменные перемещения (панорамирования) карты
let isPanning = false;
let startX = 0;
let startY = 0;
let panX = 0;
let panY = 0;

// Переменные для сглаживания и троттлинга джойстика
let lastSendTime = 0;
const sendThrottleMs = 50; // Отправка координат джойстика с частотой 20 Гц

// Инициализация при загрузке страницы
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    initJoystick();
    initControlButtons();
    initMapInteraction();
    initTheme();
    window.addEventListener("resize", drawMap);
});

/* ================= РАБОТА С WEBSOCKET ================= */
function initWebSocket() {
    console.log(`[UNIPULT] Подключение к WebSocket: ${socketUrl}`);
    socket = new WebSocket(socketUrl);

    socket.onopen = () => {
        console.log("[UNIPULT] WebSocket соединение установлено");
        isConnected = true;
        updateConnectionStatus(true);
    };

    socket.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleServerMessage(message);
        } catch (e) {
            console.error("[UNIPULT] Ошибка разбора сообщения от сервера:", e);
        }
    };

    socket.onclose = () => {
        console.warn("[UNIPULT] Соединение закрыто. Переподключение...");
        isConnected = false;
        updateConnectionStatus(false);
        setTimeout(initWebSocket, reconnectInterval);
    };

    socket.onerror = (error) => {
        console.error("[UNIPULT] Ошибка WebSocket:", error);
    };
}

function updateConnectionStatus(connected) {
    const indicator = document.getElementById("conn-indicator");
    const connText = document.getElementById("conn-text");
    
    if (connected) {
        indicator.className = "status-indicator connected";
        connText.innerText = "ОНЛАЙН";
        connText.style.color = "var(--accent-success)";
    } else {
        indicator.className = "status-indicator disconnected";
        connText.innerText = "ОФФЛАЙН";
        connText.style.color = "var(--accent-danger)";
    }
}

// Обработка входящих сообщений
function handleServerMessage(msg) {
    if (msg.type === "init") {
        // Первоначальная загрузка списков из файлов бэкенда
        arucoMarkers = msg.aruco || [];
        waypoints = msg.waypoints || [];
        renderArucoTable();
        renderWaypointsTable();
        drawMap();
    } else if (msg.type === "telemetry") {
        // Обновление числовых показателей на панели
        const d = msg.data || {};
        
        if (d.x !== undefined) document.getElementById("tele-x").innerText = d.x.toFixed(3);
        if (d.y !== undefined) document.getElementById("tele-y").innerText = d.y.toFixed(3);
        if (d.z !== undefined) document.getElementById("tele-z").innerText = d.z.toFixed(3);
        
        if (d.yaw !== undefined) document.getElementById("tele-yaw").innerText = d.yaw.toFixed(1) + "°";
        if (d.roll !== undefined) document.getElementById("tele-roll").innerText = d.roll.toFixed(1) + "°";
        if (d.pitch !== undefined) document.getElementById("tele-pitch").innerText = d.pitch.toFixed(1) + "°";
        
        if (d.battery !== undefined) {
            document.getElementById("battery-value").innerText = d.battery.toFixed(1) + " В";
            
            // Расчет процента заряда для стандартной 3S батареи (10.0 В - 12.6 В)
            const minV = 10.0;
            const maxV = 12.6;
            let pct = ((d.battery - minV) / (maxV - minV)) * 100;
            pct = Math.max(0, Math.min(100, Math.round(pct)));
            document.getElementById("battery-percent").innerText = `(${pct}%)`;
        }
        
        if (d.state !== undefined) {
            const stateEl = document.getElementById("robot-state");
            stateEl.innerText = d.state.toUpperCase();
            
            // Визуальный эффект для кнопки E-STOP и текста при экстренной остановке
            const estopBtn = document.getElementById("estop-btn");
            if (d.state.toUpperCase() === "E-STOP" || d.state.toUpperCase() === "ESTOP") {
                stateEl.className = "e-stop";
                estopBtn.classList.add("active");
            } else {
                stateEl.className = "";
                estopBtn.classList.remove("active");
            }
        }

        // Обновление позиции робота на интерактивной карте и запись пройденного следа
        if (d.x !== undefined && d.y !== undefined) {
            robotPose.x = d.x;
            robotPose.y = d.y;
            robotPose.z = d.z || 0.0;
            robotPose.yaw = d.yaw || 0.0;

            // Добавляем точку в пройденный след, если робот сдвинулся более чем на 5 см от последней точки
            if (robotTrail.length === 0) {
                robotTrail.push({ x: d.x, y: d.y });
            } else {
                const last = robotTrail[robotTrail.length - 1];
                const dist = Math.hypot(d.x - last.x, d.y - last.y);
                if (dist > 0.05) {
                    robotTrail.push({ x: d.x, y: d.y });
                    if (robotTrail.length > 1000) {
                        robotTrail.shift(); // Ограничиваем длину во избежание утечки памяти
                    }
                }
            }
            drawMap();
        }
    }
}

/* ================= КНОПКИ УПРАВЛЕНИЯ ================= */
function initControlButtons() {
    // Аварийный стоп (E-STOP) - отправка мгновенно
    document.getElementById("estop-btn").addEventListener("click", () => {
        sendWsMessage({ type: "estop" });
    });

    // Запуск автоматического движения по траектории
    document.getElementById("auto-start-btn").addEventListener("click", () => {
        sendWsMessage({ type: "auto_start" });
    });

    // Остановка автоматического движения
    document.getElementById("auto-stop-btn").addEventListener("click", () => {
        sendWsMessage({ type: "auto_stop" });
    });

    // Отправка точек траектории на робота
    document.getElementById("send-route-btn").addEventListener("click", () => {
        sendWsMessage({ type: "waypoints_update", waypoints: waypoints });
        alert("Маршрут отправлен на робота!");
    });
}

function sendWsMessage(obj) {
    if (isConnected && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
    }
}

/* ================= ВИРТУАЛЬНЫЙ ДЖОЙСТИК (NIPPLE.JS) ================= */
function initJoystick() {
    const zone = document.getElementById("joystick-zone");
    const coordsDisplay = document.getElementById("joystick-coords");

    const manager = nipplejs.create({
        zone: zone,
        mode: "static",
        position: { left: "50%", top: "50%" },
        color: "var(--accent-primary)",
        size: 130,
        threshold: 0.1
    });

    manager.on("move", (evt, data) => {
        if (!data.vector) return;
        
        // Преобразуем полярные координаты nipplejs в декартовы нормированные (-1.0 ... 1.0)
        // Y инвертируем, так как в веб-координатах ось Y направлена вниз, а у робота - вперед
        const distance = data.distance / 65.0; // Нормализуем по радиусу джойстика (130 / 2 = 65)
        const rad = data.angle.radian;
        
        const x = Math.cos(rad) * distance;
        const y = Math.sin(rad) * distance;
        
        // Ограничиваем диапазон [-1, 1]
        const clampedX = Math.max(-1, Math.min(1, x));
        const clampedY = Math.max(-1, Math.min(1, y));

        coordsDisplay.innerText = `X: ${clampedX.toFixed(2)} | Y: ${clampedY.toFixed(2)}`;
        
        // Отправляем с ограничением частоты (throttling)
        const now = Date.now();
        if (now - lastSendTime >= sendThrottleMs) {
            sendWsMessage({ type: "joystick", x: clampedX, y: clampedY });
            lastSendTime = now;
        }
    });

    manager.on("end", () => {
        // При отпускании джойстика мгновенно отправляем сигнал остановки (0, 0)
        coordsDisplay.innerText = "X: 0.00 | Y: 0.00";
        sendWsMessage({ type: "joystick", x: 0.0, y: 0.0 });
        lastSendTime = Date.now();
    });
}

/* ================= ВКЛАДКИ ================= */
function openTab(evt, tabId) {
    // Скрываем все вкладки
    const tabContents = document.getElementsByClassName("tab-content");
    for (let i = 0; i < tabContents.length; i++) {
        tabContents[i].classList.remove("active");
    }

    // Убираем активный класс у всех кнопок вкладок
    const tabLinks = document.getElementsByClassName("tab-link");
    for (let i = 0; i < tabLinks.length; i++) {
        tabLinks[i].classList.remove("active");
    }

    // Показываем текущую вкладку и делаем кнопку активной
    document.getElementById(tabId).classList.add("active");
    evt.currentTarget.classList.add("active");
}

/* ================= УПРАВЛЕНИЕ ТАБЛИЦЕЙ ARUCO ================= */
function renderArucoTable() {
    const tbody = document.querySelector("#aruco-table tbody");
    tbody.innerHTML = "";

    arucoMarkers.forEach((marker, index) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><b style="color: var(--accent-primary); font-size: 1rem;">${marker.tag}</b></td>
            <td><input type="number" step="0.01" class="coords-input" value="${marker.x}" onchange="updateArucoField(${index}, 'x', this.value)"></td>
            <td><input type="number" step="0.01" class="coords-input" value="${marker.y}" onchange="updateArucoField(${index}, 'y', this.value)"></td>
            <td><input type="number" step="0.01" class="coords-input" value="${marker.z}" onchange="updateArucoField(${index}, 'z', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${marker.roll}" onchange="updateArucoField(${index}, 'roll', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${marker.pitch}" onchange="updateArucoField(${index}, 'pitch', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${marker.yaw}" onchange="updateArucoField(${index}, 'yaw', this.value)"></td>
            <td>
                <button class="icon-btn delete" onclick="deleteArucoMarker(${index})">🗑</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function addArucoMarker() {
    const tagInput = document.getElementById("aruco-form-tag");
    const xInput = document.getElementById("aruco-form-x");
    const yInput = document.getElementById("aruco-form-y");
    const zInput = document.getElementById("aruco-form-z");
    const rInput = document.getElementById("aruco-form-roll");
    const pInput = document.getElementById("aruco-form-pitch");
    const yawInput = document.getElementById("aruco-form-yaw");

    const tag = parseInt(tagInput.value);

    if (isNaN(tag)) {
        alert("Заполните Tag ID!");
        return;
    }

    // Создаем новую метку
    const marker = {
        tag: tag,
        x: parseFloat(xInput.value) || 0.0,
        y: parseFloat(yInput.value) || 0.0,
        z: parseFloat(zInput.value) || 0.0,
        roll: parseFloat(rInput.value) || 0.0,
        pitch: parseFloat(pInput.value) || 0.0,
        yaw: parseFloat(yawInput.value) || 0.0
    };

    arucoMarkers.push(marker);
    renderArucoTable();
    drawMap();
    
    // Отправляем обновленный список на сервер для автосохранения в файл
    sendWsMessage({ type: "aruco_update", aruco: arucoMarkers });

    // Сброс полей формы
    tagInput.value = "";
    xInput.value = "";
    yInput.value = "";
    zInput.value = "";
    rInput.value = "";
    pInput.value = "";
    yawInput.value = "";
}

function deleteArucoMarker(index) {
    if (confirm(`Удалить метку Aruco с ID ${arucoMarkers[index].tag}?`)) {
        arucoMarkers.splice(index, 1);
        renderArucoTable();
        drawMap();
        sendWsMessage({ type: "aruco_update", aruco: arucoMarkers });
    }
}

function updateArucoField(index, field, value) {
    arucoMarkers[index][field] = parseFloat(value) || 0.0;
    // Отправляем измененные данные на сервер
    sendWsMessage({ type: "aruco_update", aruco: arucoMarkers });
    drawMap();
}

/* ================= УПРАВЛЕНИЕ ТАБЛИЦЕЙ WAYPOINTS ================= */
function renderWaypointsTable() {
    const tbody = document.querySelector("#waypoints-table tbody");
    tbody.innerHTML = "";

    waypoints.forEach((wp, index) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><b style="color: var(--text-secondary);">${index + 1}</b></td>
            <td><input type="number" step="0.01" class="coords-input" value="${wp.x}" onchange="updateWaypointField(${index}, 'x', this.value)"></td>
            <td><input type="number" step="0.01" class="coords-input" value="${wp.y}" onchange="updateWaypointField(${index}, 'y', this.value)"></td>
            <td><input type="number" step="0.01" class="coords-input" value="${wp.z}" onchange="updateWaypointField(${index}, 'z', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${wp.roll}" onchange="updateWaypointField(${index}, 'roll', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${wp.pitch}" onchange="updateWaypointField(${index}, 'pitch', this.value)"></td>
            <td><input type="number" step="0.1" class="coords-input" value="${wp.yaw}" onchange="updateWaypointField(${index}, 'yaw', this.value)"></td>
            <td>
                <button class="icon-btn" onclick="moveWaypoint(${index}, -1)" ${index === 0 ? 'disabled style="opacity:0.2;"' : ''}>▲</button>
                <button class="icon-btn" onclick="moveWaypoint(${index}, 1)" ${index === waypoints.length - 1 ? 'disabled style="opacity:0.2;"' : ''}>▼</button>
            </td>
            <td>
                <button class="icon-btn delete" onclick="deleteWaypoint(${index})">🗑</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function addWaypoint() {
    const xInput = document.getElementById("wp-form-x");
    const yInput = document.getElementById("wp-form-y");
    const zInput = document.getElementById("wp-form-z");
    const rInput = document.getElementById("wp-form-roll");
    const pInput = document.getElementById("wp-form-pitch");
    const yawInput = document.getElementById("wp-form-yaw");

    const wp = {
        x: parseFloat(xInput.value) || 0.0,
        y: parseFloat(yInput.value) || 0.0,
        z: parseFloat(zInput.value) || 0.0,
        roll: parseFloat(rInput.value) || 0.0,
        pitch: parseFloat(pInput.value) || 0.0,
        yaw: parseFloat(yawInput.value) || 0.0
    };

    waypoints.push(wp);
    renderWaypointsTable();
    drawMap();

    // Сброс формы
    xInput.value = "";
    yInput.value = "";
    zInput.value = "";
    rInput.value = "";
    pInput.value = "";
    yawInput.value = "";
}

function deleteWaypoint(index) {
    waypoints.splice(index, 1);
    renderWaypointsTable();
    drawMap();
}

function updateWaypointField(index, field, value) {
    waypoints[index][field] = parseFloat(value) || 0.0;
    drawMap();
}

function moveWaypoint(index, direction) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= waypoints.length) return;
    
    // Перестановка элементов в массиве
    const temp = waypoints[index];
    waypoints[index] = waypoints[targetIndex];
    waypoints[targetIndex] = temp;
    
    renderWaypointsTable();
    drawMap();
}

function clearWaypoints() {
    if (confirm("Вы действительно хотите удалить ВСЕ точки маршрута?")) {
        waypoints = [];
        renderWaypointsTable();
        drawMap();
    }
}

/* ================= ЭКСПОРТ ДАННЫХ В JSON ФАЙЛЫ ================= */
function exportData(type) {
    const data = type === 'aruco' ? arucoMarkers : waypoints;
    const filename = type === 'aruco' ? 'aruco_coordinates.json' : 'robot_waypoints.json';
    
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/* ================= ИМПОРТ ДАННЫХ ИЗ JSON ФАЙЛОВ ================= */
function importData(event, type) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data)) {
                alert("Ошибка: Импортируемый JSON должен быть массивом!");
                return;
            }

            if (type === 'aruco') {
                // Фильтруем и загружаем метки (без Type)
                arucoMarkers = data.map(item => ({
                    tag: parseInt(item.tag) || 0,
                    x: parseFloat(item.x) || 0.0,
                    y: parseFloat(item.y) || 0.0,
                    z: parseFloat(item.z) || 0.0,
                    roll: parseFloat(item.roll) || 0.0,
                    pitch: parseFloat(item.pitch) || 0.0,
                    yaw: parseFloat(item.yaw) || 0.0
                }));
                renderArucoTable();
                drawMap();
                sendWsMessage({ type: "aruco_update", aruco: arucoMarkers });
                alert(`Успешно импортировано меток: ${arucoMarkers.length}`);
            } else if (type === 'waypoints') {
                // Загружаем точки маршрута
                waypoints = data.map(item => ({
                    x: parseFloat(item.x) || 0.0,
                    y: parseFloat(item.y) || 0.0,
                    z: parseFloat(item.z) || 0.0,
                    roll: parseFloat(item.roll) || 0.0,
                    pitch: parseFloat(item.pitch) || 0.0,
                    yaw: parseFloat(item.yaw) || 0.0
                }));
                renderWaypointsTable();
                drawMap();
                alert(`Успешно импортировано точек: ${waypoints.length}`);
            }
        } catch (err) {
            alert("Ошибка разбора файла JSON: " + err.message);
        }
        event.target.value = ""; // Сброс инпута
    };
    reader.readAsText(file);
}

/* ================= ИНТЕРАКТИВНАЯ КАРТА (CANVAS) ================= */
function getGridSpacing() {
    // scale - количество пикселей на 1 метр.
    // Мы хотим, чтобы расстояние между линиями на экране составляло не менее 40 пикселей.
    const minPixels = 45;
    const targetSpacing = minPixels / scale; // шаг в метрах
    
    // Округляем шаг до ближайшего десятичного интервала (1, 2 или 5, умноженные на степень 10)
    const log = Math.log10(targetSpacing);
    const powerOfTen = Math.pow(10, Math.floor(log));
    const ratio = targetSpacing / powerOfTen;
    
    let spacing;
    if (ratio < 2.0) spacing = 1 * powerOfTen;
    else if (ratio < 5.0) spacing = 2 * powerOfTen;
    else spacing = 5 * powerOfTen;
    
    // Ограничиваем минимальный шаг сетки 1 миллиметром (0.001 м)
    return Math.max(0.001, spacing);
}

function addWaypointAtScreenCoords(screenX, screenY) {
    const canvas = document.getElementById("nav-map");
    if (!canvas) return;
    const width = canvas.width;
    const height = canvas.height;

    // Учитываем текущий сдвиг карты при расчете центра
    const originX = width / 2 + panX;
    const originY = height / 2 + panY;

    // Перевод пикселей в метры (ось Y инвертирована)
    const x = (screenX - originX) / scale;
    const y = (originY - screenY) / scale;

    // Привязка курсора к узлам сетки в текущем масштабе
    const gridSpacing = getGridSpacing();
    const xSnapped = Math.round(x / gridSpacing) * gridSpacing;
    const ySnapped = Math.round(y / gridSpacing) * gridSpacing;

    const wp = {
        x: parseFloat(xSnapped.toFixed(4)),
        y: parseFloat(ySnapped.toFixed(4)),
        z: 0.0,
        roll: 0.0,
        pitch: 0.0,
        yaw: 0.0
    };

    waypoints.push(wp);
    renderWaypointsTable();
    drawMap();
}

function zoomMapAt(factor, screenX, screenY) {
    const oldScale = scale;
    scale = Math.max(5, Math.min(50000, scale * factor));
    const r = scale / oldScale;
    
    const canvas = document.getElementById("nav-map");
    if (!canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    
    // Сдвигаем панорамирование, чтобы точка под курсором осталась на месте
    panX = (1 - r) * (screenX - width / 2) + r * panX;
    panY = (1 - r) * (screenY - height / 2) + r * panY;
    
    drawMap();
}

function initMapInteraction() {
    const canvas = document.getElementById("nav-map");
    if (!canvas) return;

    // Дополнительные переменные для touch-событий на мобильных устройствах
    let isTouching = false;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;

    // Предотвращаем вызов контекстного меню на холсте, чтобы можно было перемещаться правой кнопкой
    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
    });

    // Обработчик нажатия кнопок мыши
    canvas.addEventListener("mousedown", (e) => {
        // Перемещаемся по карте (панорамирование) при нажатии:
        // - Колесика мыши (button === 1)
        // - Правой кнопки мыши (button === 2)
        // - Левой кнопки мыши с зажатым Shift (button === 0 && e.shiftKey)
        if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
            isPanning = true;
            startX = e.clientX;
            startY = e.clientY;
            canvas.style.cursor = "grabbing";
            e.preventDefault();
        } else if (e.button === 0) {
            // Обычный левый клик — добавляем точку маршрута
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            addWaypointAtScreenCoords(screenX, screenY);
        }
    });

    // Обработчик перемещения мыши
    canvas.addEventListener("mousemove", (e) => {
        if (isPanning) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            panX += dx;
            panY += dy;
            startX = e.clientX;
            startY = e.clientY;
            drawMap();
        }
    });

    // Отмена перемещения при отпускании кнопок мыши
    window.addEventListener("mouseup", (e) => {
        if (isPanning) {
            isPanning = false;
            if (canvas) canvas.style.cursor = "move";
        }
    });

    // Зуммирование колесиком мыши (сфокусированное на курсоре)
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.15 : 0.85;
        zoomMapAt(factor, screenX, screenY);
    }, { passive: false });

    // === ТАЧ-СОБЫТИЯ ДЛЯ МОБИЛЬНЫХ УСТРОЙСТВ ===
    canvas.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) {
            isTouching = true;
            touchMoved = false;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            startX = touchStartX;
            startY = touchStartY;
        }
    }, { passive: true });

    canvas.addEventListener("touchmove", (e) => {
        if (isTouching && e.touches.length === 1) {
            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            
            const dx = currentX - startX;
            const dy = currentY - startY;
            
            // Если сдвиг пальца больше 8 пикселей, считаем это перемещением карты
            const dist = Math.hypot(currentX - touchStartX, currentY - touchStartY);
            if (dist > 8) {
                touchMoved = true;
            }
            
            if (touchMoved) {
                panX += dx;
                panY += dy;
                startX = currentX;
                startY = currentY;
                drawMap();
                if (e.cancelable) e.preventDefault(); // Предотвращаем прокрутку самой страницы
            }
        }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
        if (isTouching) {
            isTouching = false;
            if (!touchMoved) {
                // Если палец не двигался — это тап для добавления точки
                const rect = canvas.getBoundingClientRect();
                const screenX = touchStartX - rect.left;
                const screenY = touchStartY - rect.top;
                addWaypointAtScreenCoords(screenX, screenY);
            }
        }
    });
}

function zoomMap(factor) {
    scale = Math.max(5, Math.min(50000, scale * factor)); // Увеличиваем макс. масштаб для миллиметров
    drawMap();
}

function clearTrail() {
    robotTrail = [];
    drawMap();
}

// Делаем функции глобальными для HTML событий
window.zoomMap = zoomMap;
window.clearTrail = clearTrail;
window.clearWaypoints = clearWaypoints;
window.importData = importData;

/* ================= ИНИЦИАЛИЗАЦИЯ И УПРАВЛЕНИЕ ТЕМОЙ ================= */
function initTheme() {
    const toggleBtn = document.getElementById("theme-toggle");
    const themeIcon = document.getElementById("theme-icon");
    
    // Проверяем сохраненную тему в localStorage
    const savedTheme = localStorage.getItem("theme") || "dark";
    if (savedTheme === "light") {
        document.body.classList.add("light-theme");
        if (themeIcon) themeIcon.innerText = "☀️";
    } else {
        document.body.classList.remove("light-theme");
        if (themeIcon) themeIcon.innerText = "🌙";
    }
    
    if (toggleBtn) {
        // Очищаем старые слушатели перед добавлением нового (для избежания дублирования)
        const newToggle = toggleBtn.cloneNode(true);
        toggleBtn.parentNode.replaceChild(newToggle, toggleBtn);
        
        newToggle.addEventListener("click", () => {
            document.body.classList.toggle("light-theme");
            const isLight = document.body.classList.contains("light-theme");
            localStorage.setItem("theme", isLight ? "light" : "dark");
            
            const newIcon = document.getElementById("theme-icon");
            if (newIcon) newIcon.innerText = isLight ? "☀️" : "🌙";
            
            drawMap(); // Перерисовываем карту с новыми цветами
        });
    }
}
window.initTheme = initTheme;

function drawMap() {
    const canvas = document.getElementById("nav-map");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // Корректируем разрешение холста под CSS размеры (для чёткости)
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const width = canvas.width;
    const height = canvas.height;

    const isLightTheme = document.body.classList.contains("light-theme");

    // 1. Очистка холста
    ctx.fillStyle = isLightTheme ? "#ffffff" : "#05070c";
    ctx.fillRect(0, 0, width, height);

    // Центр холста с учетом смещения панорамирования
    const originX = width / 2 + panX;
    const originY = height / 2 + panY;

    // 2. Сетка
    ctx.strokeStyle = isLightTheme ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 1;
    ctx.fillStyle = isLightTheme ? "rgba(0, 0, 0, 0.5)" : "rgba(255, 255, 255, 0.25)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Получаем динамический шаг сетки
    const gridSpacing = getGridSpacing();

    // Находим границы видимой области в метрах с учетом смещения
    const leftX = (0 - originX) / scale;
    const rightX = (width - originX) / scale;
    const bottomY = (originY - height) / scale;
    const topY = (originY - 0) / scale;
    
    const startGridX = Math.floor(leftX / gridSpacing) * gridSpacing;
    const endGridX = Math.ceil(rightX / gridSpacing) * gridSpacing;
    
    const startGridY = Math.floor(bottomY / gridSpacing) * gridSpacing;
    const endGridY = Math.ceil(topY / gridSpacing) * gridSpacing;

    // Вертикальные линии сетки
    for (let x = startGridX; x <= endGridX; x += gridSpacing) {
        const screenX = originX + x * scale;
        ctx.beginPath();
        ctx.moveTo(screenX, 0);
        ctx.lineTo(screenX, height);
        ctx.stroke();

        if (Math.abs(x) > 0.0001) {
            // Форматируем подписи в зависимости от размера единиц
            let label = "";
            if (gridSpacing >= 1.0) {
                label = x.toFixed(0) + "m";
            } else if (gridSpacing >= 0.01) {
                label = (x * 100).toFixed(0) + "cm";
            } else {
                label = (x * 1000).toFixed(0) + "mm";
            }
            ctx.fillText(label, screenX, originY + 12);
        }
    }

    // Горизонтальные линии сетки
    for (let y = startGridY; y <= endGridY; y += gridSpacing) {
        const screenY = originY - y * scale;
        ctx.beginPath();
        ctx.moveTo(0, screenY);
        ctx.lineTo(width, screenY);
        ctx.stroke();

        if (Math.abs(y) > 0.0001) {
            let label = "";
            if (gridSpacing >= 1.0) {
                label = y.toFixed(0) + "m";
            } else if (gridSpacing >= 0.01) {
                label = (y * 100).toFixed(0) + "cm";
            } else {
                label = (y * 1000).toFixed(0) + "mm";
            }
            ctx.fillText(label, originX - 22, screenY);
        }
    }

    // 3. Главные оси координат
    ctx.strokeStyle = isLightTheme ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1.5;
    
    // Ось X
    ctx.beginPath();
    ctx.moveTo(0, originY);
    ctx.lineTo(width, originY);
    ctx.stroke();

    // Ось Y
    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(originX, height);
    ctx.stroke();

    ctx.fillText("0,0", originX - 22, originY + 12);

    // 4. Отрисовка меток Aruco
    arucoMarkers.forEach(m => {
        const screenX = originX + m.x * scale;
        const screenY = originY - m.y * scale;

        // Неоновый оранжевый квадрат
        ctx.fillStyle = "rgba(245, 158, 11, 0.15)";
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(screenX - 8, screenY - 8, 16, 16);
        ctx.fill();
        ctx.stroke();

        // Текст ID метки
        ctx.fillStyle = isLightTheme ? "#1f2937" : "#f3f4f6";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText("ID:" + m.tag, screenX, screenY + 16);
    });

    // 5. Отрисовка пройденного реального пути (следа)
    if (robotTrail.length > 1) {
        ctx.strokeStyle = isLightTheme ? "#059669" : "rgba(16, 185, 129, 0.85)"; // Яркий зеленый неон (чуть темнее для светлой темы)
        ctx.lineWidth = 2.5;
        if (!isLightTheme) {
            ctx.shadowBlur = 8;
            ctx.shadowColor = "rgba(16, 185, 129, 0.5)";
        }
        ctx.beginPath();

        const startX = originX + robotTrail[0].x * scale;
        const startY = originY - robotTrail[0].y * scale;
        ctx.moveTo(startX, startY);

        for (let i = 1; i < robotTrail.length; i++) {
            const screenX = originX + robotTrail[i].x * scale;
            const screenY = originY - robotTrail[i].y * scale;
            ctx.lineTo(screenX, screenY);
        }
        ctx.stroke();
        ctx.shadowBlur = 0; // Сброс свечения
    }

    // 6. Отрисовка планируемого маршрута (точек)
    if (waypoints.length > 0) {
        // Соединительная линия (пунктир)
        ctx.strokeStyle = isLightTheme ? "rgba(79, 70, 229, 0.5)" : "rgba(99, 102, 241, 0.5)";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();

        const startX = originX + waypoints[0].x * scale;
        const startY = originY - waypoints[0].y * scale;
        ctx.moveTo(startX, startY);

        for (let i = 1; i < waypoints.length; i++) {
            const screenX = originX + waypoints[i].x * scale;
            const screenY = originY - waypoints[i].y * scale;
            ctx.lineTo(screenX, screenY);
        }
        ctx.stroke();
        ctx.setLineDash([]); // Сброс пунктира

        // Сами точки
        waypoints.forEach((wp, index) => {
            const screenX = originX + wp.x * scale;
            const screenY = originY - wp.y * scale;

            // Внешнее полупрозрачное кольцо
            ctx.fillStyle = isLightTheme ? "rgba(79, 70, 229, 0.12)" : "rgba(99, 102, 241, 0.2)";
            ctx.strokeStyle = "var(--accent-primary)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(screenX, screenY, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Центральная точка
            ctx.fillStyle = "var(--text-primary)";
            ctx.beginPath();
            ctx.arc(screenX, screenY, 2, 0, Math.PI * 2);
            ctx.fill();

            // Номер точки
            ctx.fillStyle = isLightTheme ? "#4338ca" : "#a5b4fc";
            ctx.font = "bold 10px sans-serif";
            ctx.fillText(index + 1, screenX, screenY - 14);
        });
    }

    // 7. Отрисовка робота (направленный шеврон)
    const robotScreenX = originX + robotPose.x * scale;
    const robotScreenY = originY - robotPose.y * scale;

    ctx.save();
    ctx.translate(robotScreenX, robotScreenY);

    // Угол Yaw приходит в градусах, переводим в радианы
    // В ROS/стандартной математике Yaw увеличивается против часовой стрелки.
    // Так как ось Y холста направлена вниз, угол поворота инвертируем.
    const yawRad = -robotPose.yaw * Math.PI / 180.0;
    ctx.rotate(yawRad);

    // Рисуем робот
    ctx.fillStyle = isLightTheme ? "rgba(79, 70, 229, 0.25)" : "rgba(99, 102, 241, 0.4)";
    ctx.strokeStyle = isLightTheme ? "#4f46e5" : "var(--accent-primary)";
    ctx.lineWidth = 2;
    if (!isLightTheme) {
        ctx.shadowBlur = 12;
        ctx.shadowColor = "var(--accent-primary)";
    }

    ctx.beginPath();
    ctx.moveTo(15, 0);       // Нос (вперед по оси X)
    ctx.lineTo(-10, -8);     // Левое заднее крыло
    ctx.lineTo(-5, 0);       // Вырез
    ctx.lineTo(-10, 8);      // Правое заднее крыло
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Стрелка направления курса
    ctx.strokeStyle = isLightTheme ? "#4338ca" : "#a5b4fc";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(25, 0);
    ctx.stroke();

    ctx.restore();
}

function resetMap() {
    panX = 0;
    panY = 0;
    scale = 35;
    drawMap();
}
window.resetMap = resetMap;
