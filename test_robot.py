#!/usr/bin/env python3
import time
import math
import sys
from server import RobotPanel

def main():
    print("=========================================================")
    print("         UNIPULT: СИМУЛЯТОР РОБОТА ДЛЯ ТЕСТИРОВАНИЯ      ")
    print("=========================================================")

    # Инициализация панели на порту 8080
    panel = RobotPanel(host="0.0.0.0", port=8080, storage_dir="./data")

    # Переменные симулируемого робота
    robot = {
        "state": "idle",      # Состояния: idle, manual, auto, e-stop
        "battery": 12.6,      # Напряжение батареи
        "x": 0.0,             # Позиция
        "y": 0.0,
        "z": 0.0,
        "roll": 0.0,          # Углы ориентации
        "pitch": 0.0,
        "yaw": 0.0,
        "vel_x": 0.0,         # Скорости (управляются джойстиком)
        "vel_yaw": 0.0,
        "target_wp_idx": 0    # Индекс целевой точки при авто-движении
    }

    # 1. Регистрация коллбэков (обработчиков событий из браузера)

    @panel.on_joystick
    def handle_joystick(x, y):
        """Вызывается при движении джойстика в браузере"""
        if robot["state"] == "e-stop":
            return
        
        # Если пришел сигнал (0,0), переводим робота в режим ожидания (idle)
        if abs(x) < 0.01 and abs(y) < 0.01:
            robot["vel_x"] = 0.0
            robot["vel_yaw"] = 0.0
            if robot["state"] == "manual":
                robot["state"] = "idle"
        else:
            robot["state"] = "manual"
            # Масштабируем скорости: вперед/назад (y) и поворот (x)
            robot["vel_x"] = y * 1.5     # Макс линейная скорость 1.5 м/с
            robot["vel_yaw"] = -x * 60.0  # Макс угловая скорость 60 град/сек
            
        print(f"[РОБОТ] Джойстик: x={x:.2f}, y={y:.2f} -> Скорость: V={robot['vel_x']:.2f} м/с, W={robot['vel_yaw']:.1f} °/с")

    @panel.on_estop
    def handle_estop():
        """Вызывается при нажатии E-STOP"""
        robot["state"] = "e-stop"
        robot["vel_x"] = 0.0
        robot["vel_yaw"] = 0.0
        print("\n[РОБОТ] !!! ВНИМАНИЕ: АВАРИЙНЫЙ СТОП АКТИВИРОВАН !!!\n")

    @panel.on_autonomous_start
    def handle_auto_start():
        """Вызывается при нажатии СТАРТ АВТО"""
        if robot["state"] == "e-stop":
            print("[РОБОТ] Ошибка: Невозможно запустить авто-режим. Активен E-STOP! Сбросьте питание.")
            return
        
        # Проверяем, есть ли точки маршрута
        waypoints_list = panel._load_data("waypoints.json")
        if not waypoints_list:
            print("[РОБОТ] Предупреждение: Список точек маршрута пуст! Задайте точки в интерфейсе.")
            return
            
        robot["state"] = "auto"
        robot["target_wp_idx"] = 0
        print(f"[РОБОТ] Запущен автоматический режим по {len(waypoints_list)} точкам")

    @panel.on_autonomous_stop
    def handle_auto_stop():
        """Вызывается при нажатии СТОП АВТО"""
        if robot["state"] == "auto":
            robot["state"] = "idle"
            robot["vel_x"] = 0.0
            robot["vel_yaw"] = 0.0
            print("[РОБОТ] Автоматический режим приостановлен")

    @panel.on_waypoints_update
    def handle_waypoints(waypoints_list):
        """Вызывается при загрузке/изменении списка точек на панели"""
        print(f"[РОБОТ] Обновлен список точек маршрута. Всего точек: {len(waypoints_list)}")
        for idx, wp in enumerate(waypoints_list):
            print(f"  Точка {idx+1}: X={wp['x']:.2f}, Y={wp['y']:.2f}, Z={wp['z']:.2f}, Yaw={wp['yaw']:.1f}°")

    @panel.on_aruco_update
    def handle_aruco(markers_list):
        """Вызывается при изменении списка меток Aruco"""
        print(f"[РОБОТ] Обновлен список меток Aruco. Всего меток: {len(markers_list)}")
        for m in markers_list:
            print(f"  Tag {m['tag']}: X={m['x']:.2f}, Y={m['y']:.2f}, Z={m['z']:.2f}")

    # 2. Запуск веб-сервера панели в фоновом потоке
    panel.start()

    print("\nИнтерфейс управления доступен в вашей локальной сети:")
    print(f"--> Откройте на ПК или телефоне: http://localhost:8080")
    print("Для остановки симулятора нажмите Ctrl+C\n")

    # 3. Главный цикл симуляции физики робота (10 Гц)
    dt = 0.1
    try:
        while True:
            # Имитация разряда батареи (медленное падение)
            robot["battery"] = max(9.5, robot["battery"] - 0.0005)

            # --- Логика движения в РУЧНОМ режиме ---
            if robot["state"] == "manual":
                # Вычисляем перемещение с учетом текущего угла курса (Yaw)
                yaw_rad = math.radians(robot["yaw"])
                dist = robot["vel_x"] * dt
                robot["x"] += dist * math.cos(yaw_rad)
                robot["y"] += dist * math.sin(yaw_rad)
                robot["yaw"] = (robot["yaw"] + robot["vel_yaw"] * dt) % 360

            # --- Логика движения в АВТОНОМНОМ режиме ---
            elif robot["state"] == "auto":
                # Загружаем текущие точки траектории из файла автосохранения
                wps = panel._load_data("waypoints.json")
                if wps and robot["target_wp_idx"] < len(wps):
                    target = wps[robot["target_wp_idx"]]
                    
                    # Расстояние до целевой точки по осям X, Y, Z
                    dx = target["x"] - robot["x"]
                    dy = target["y"] - robot["y"]
                    dz = target["z"] - robot["z"]
                    distance = math.sqrt(dx*dx + dy*dy + dz*dz)

                    # Если до точки меньше 0.2 метров, переключаемся на следующую
                    if distance < 0.2:
                        print(f"[РОБОТ] Точка {robot['target_wp_idx'] + 1} достигнута!")
                        robot["target_wp_idx"] += 1
                        if robot["target_wp_idx"] >= len(wps):
                            print("[РОБОТ] Маршрут успешно завершен!")
                            robot["state"] = "idle"
                            robot["vel_x"] = 0.0
                            robot["vel_yaw"] = 0.0
                    else:
                        # Движемся к точке
                        # Вычисляем требуемый угол направления на точку
                        target_angle_rad = math.atan2(dy, dx)
                        target_angle_deg = math.degrees(target_angle_rad) % 360
                        
                        # Медленно поворачиваем курс робота в сторону цели
                        angle_diff = (target_angle_deg - robot["yaw"] + 180) % 360 - 180
                        turn_step = math.copysign(min(abs(angle_diff), 45.0 * dt), angle_diff) # Макс поворот 45 град/сек
                        robot["yaw"] = (robot["yaw"] + turn_step) % 360

                        # Движемся вперед со скоростью 0.8 м/с
                        robot["vel_x"] = 0.8
                        yaw_rad = math.radians(robot["yaw"])
                        robot["x"] += robot["vel_x"] * dt * math.cos(yaw_rad)
                        robot["y"] += robot["vel_x"] * dt * math.sin(yaw_rad)
                        
                        # Плавно меняем высоту Z
                        z_diff = target["z"] - robot["z"]
                        z_step = math.copysign(min(abs(z_diff), 0.5 * dt), z_diff)
                        robot["z"] += z_step
                        
                        # Симулируем углы крена и тангажа (вибрации)
                        robot["roll"] = 2.0 * math.sin(time.time() * 5)
                        robot["pitch"] = 2.0 * math.cos(time.time() * 5)
                else:
                    # Если дошли до конца списка точек
                    robot["state"] = "idle"
                    robot["vel_x"] = 0.0
                    robot["vel_yaw"] = 0.0
                    print("[РОБОТ] Остановка: Точки маршрута закончились")

            # 4. Отправка телеметрии на веб-интерфейс
            panel.send_telemetry(
                state=robot["state"],
                battery=robot["battery"],
                x=robot["x"],
                y=robot["y"],
                z=robot["z"],
                roll=robot["roll"],
                pitch=robot["pitch"],
                yaw=robot["yaw"]
            )

            time.sleep(dt)

    except KeyboardInterrupt:
        print("\n[РОБОТ] Завершение симуляции...")
    finally:
        panel.stop()
        print("[РОБОТ] Сервер остановлен. До свидания!")

if __name__ == "__main__":
    main()
