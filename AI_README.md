# UNIPULT Integration Guide (AI-Ready Cheat Sheet)

> **FOR AI CODING ASSISTANTS:** This file outlines the API, event model, data shapes, and interactive features of the **UNIPULT** robot control panel. Use this guide to easily integrate UNIPULT into the user's existing Python or ROS-based robot control scripts.

---

## 1. Overview & Structure

UNIPULT is a modular, zero-dependency (other than `fastapi` and `uvicorn`) robot control panel. It runs a web server in a background thread and communicates with the client browser using WebSockets.

### Directory Layout
```
UNIPULT/
├── server.py           # Core FastAPI backend class `RobotPanel`
├── templates/
│   └── index.html      # Glassmorphic responsive web UI (supports Dark & Light themes)
├── static/
│   ├── css/style.css   # Theme-aware stylesheet (dark & light glassmorphism)
│   └── js/
│       ├── nipplejs.min.js # Virtual joystick library (offline capable)
│       └── app.js      # WebSocket, client logic, and map gesture engine
└── data/               # Persistent JSON storage (created automatically)
    ├── aruco.json      # Saved Aruco markers coordinates
    └── waypoints.json  # Saved waypoint sequence
```

### Premium UI Features (Dark / Light Themes)
- **Dynamic Themes**: The panel features a 🌙/☀️ toggle in the header, storing the selection in `localStorage` for persistence.
- **Transitional Morphing**: All card boundaries, input forms, telemetry values, and the virtual joystick handles (`.back` and `.front`) smoothly transition using hardware-accelerated CSS variables.
- **Canvas Synchronization**: Toggling the theme triggers a redraw of the HTML5 Canvas map, aligning grid colors, chevron outlines, axis labels, and trail colors with the active theme's palette.

---

## 2. Interactive Navigation Map & Gestures

The right panel features an HTML5 Canvas-based Cartesian coordinate grid ($X$ right, $Y$ up in meters) with an advanced gesture-recognition engine.

### 2.1 Panning (Moving the Camera)
1.  **Middle Mouse Button (Scroll Wheel Drag)**: Hold the wheel click and drag to pan (default browser autoscroll is suppressed).
2.  **Right Mouse Button Drag**: Hold right-click and drag to pan (context menu on the canvas is disabled).
3.  **Shift + Left Click Drag**: Hold the `Shift` key and drag with left-click (extremely convenient for laptop trackpads).
4.  **Touch Drag (Mobile)**: Drag a single finger on mobile screens to pan the coordinate grid.

### 2.2 Zooming
1.  **Mouse Wheel Scroll**: Scroll up/down over the canvas. The engine uses a **cursor-focused zoom algorithm** that adjusts the panning offsets (`panX`, `panY`) so that the exact world point under the mouse cursor remains stationary during scale changes.
2.  **Discrete Controls**: Use the `🔍 +` and `🔍 -` buttons next to the map for stepping, or `🏠` to reset the camera to $(0.0, 0.0)$ at the default scale.

### 2.3 Waypoint Placement
- **PC**: Left-click anywhere (without Shift) to add a waypoint. It automatically snaps to the grid node at the current scale.
- **Mobile**: Tap the screen to add a waypoint. The engine automatically distinguishes a tap (coordinate entry) from a drag (camera panning).

---

## 3. Python API (`server.py`)

To use UNIPULT in a robot project, import and instantiate `RobotPanel`:

```python
from server import RobotPanel

panel = RobotPanel(host="0.0.0.0", port=8080, storage_dir="./data")
```

### 3.1 Event Decorators
Register callbacks using decorators. All callbacks are executed in the background server thread when events occur in the browser:

*   **Joystick Input:**
    ```python
    @panel.on_joystick
    def handle_joystick(x: float, y: float):
        # x, y are normalized floats in range [-1.0, 1.0]
        # Y is positive FORWARD, X is positive RIGHT
        pass
    ```
*   **Emergency Stop:**
    ```python
    @panel.on_estop
    def handle_estop():
        # High-priority emergency stop. Disable all actuators immediately.
        pass
    ```
*   **Autonomous Mode:**
    ```python
    @panel.on_autonomous_start
    def start_auto():
        # User clicked "START AUTO". Begin path following.
        pass

    @panel.on_autonomous_stop
    def stop_auto():
        # User clicked "STOP AUTO". Pause autonomous navigation.
        pass
    ```
*   **Waypoints Update:**
    ```python
    @panel.on_waypoints_update
    def update_waypoints(waypoints: list):
        # Triggered when a new route sequence is sent.
        # waypoints is a list of dicts: [{"x": float, "y": float, "z": float, "roll": float, "pitch": float, "yaw": float}, ...]
        pass
    ```
*   **Aruco Markers Update:**
    ```python
    @panel.on_aruco_update
    def update_aruco(markers: list):
        # Triggered when the Aruco coordinates list is edited.
        # markers is a list of dicts: [{"tag": int, "x": float, "y": float, "z": float, "roll": float, "pitch": float, "yaw": float}, ...]
        pass
    ```

### 3.2 Sending Telemetry (Thread-Safe)
Send real-time updates from your robot's control loop to the web interface by calling `panel.send_telemetry(...)`. This method is safe to call from any thread:

```python
panel.send_telemetry(
    state="manual",  # Options: "idle", "manual", "auto", "e-stop" (triggers UI flashing)
    battery=12.4,    # Float voltage (battery percent is calculated automatically)
    x=1.025,         # Robot coordinates (meters)
    y=0.450,
    z=0.0,
    roll=0.0,        # Robot orientation (degrees)
    pitch=0.0,
    yaw=45.2
)
```

### 3.3 Thread Control
*   `panel.start()`: Starts the web server in a background daemon thread.
*   `panel.stop()`: Shuts down the web server.

---

## 4. Integration Templates

### 4.1 Template A: Pure Python Robot (Serial/GPIO Control)
Use this template to glue UNIPULT to a standard hardware control loop script:

```python
import time
from server import RobotPanel

# 1. Initialize control panel
panel = RobotPanel(host="0.0.0.0", port=8080)

# Global robot states
robot_state = "idle"
battery_voltage = 12.6
pose = {"x": 0.0, "y": 0.0, "z": 0.0, "roll": 0.0, "pitch": 0.0, "yaw": 0.0}

# 2. Register callbacks
@panel.on_joystick
def on_joystick(x, y):
    global robot_state
    if robot_state == "e-stop":
        return
    robot_state = "manual"
    # Drive motors based on x (turning) and y (forward/backward)
    print(f"Driving motors: linear = {y}, angular = {x}")

@panel.on_estop
def on_estop():
    global robot_state
    robot_state = "e-stop"
    # Cut off motor power/GPIO signals immediately
    print("!!! EMERGENCY STOP ACTIVE !!!")

@panel.on_autonomous_start
def on_auto_start():
    global robot_state
    if robot_state != "e-stop":
        robot_state = "auto"
        print("Starting autonomous mission")

@panel.on_autonomous_stop
def on_auto_stop():
    global robot_state
    if robot_state == "auto":
        robot_state = "idle"
        print("Autonomous mission paused")

@panel.on_waypoints_update
def on_waypoints(wps):
    print(f"Received {len(wps)} waypoints. Preparing trajectory planning...")

# 3. Start the panel
panel.start()

# 4. Main Robot Loop
try:
    while True:
        # Simulate hardware sensors reading & physics loop
        if robot_state == "auto":
            # Follow waypoints logic...
            pose["x"] += 0.05
            pose["yaw"] = (pose["yaw"] + 1) % 360
            
        # Simulate battery drain
        battery_voltage = max(10.0, battery_voltage - 0.001)

        # 5. Broadcast telemetry to the dashboard
        panel.send_telemetry(
            state=robot_state,
            battery=battery_voltage,
            x=pose["x"],
            y=pose["y"],
            z=pose["z"],
            roll=pose["roll"],
            pitch=pose["pitch"],
            yaw=pose["yaw"]
        )
        time.sleep(0.1) # 10 Hz loop
except KeyboardInterrupt:
    panel.stop()
```

### 4.2 Template B: ROS 2 Node Integration
Use this template to glue UNIPULT to a ROS 2 workspace (e.g. publishing velocities and subscribing to odometry):

```python
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from nav_msgs.msg import Odometry
from std_msgs.msg import Float32
import math

from server import RobotPanel

class UnipultRosNode(Node):
    def __init__(self):
        super().__init__('unipult_node')
        
        # ROS Publishers & Subscribers
        self.cmd_vel_pub = self.create_publisher(Twist, 'cmd_vel', 10)
        self.odom_sub = self.create_subscription(Odometry, 'odom', self.odom_callback, 10)
        self.battery_sub = self.create_subscription(Float32, 'battery_voltage', self.battery_callback, 10)

        # Robot Local States
        self.robot_state = "idle"
        self.battery_voltage = 12.0
        self.x, self.y, self.z = 0.0, 0.0, 0.0
        self.roll, self.pitch, self.yaw = 0.0, 0.0, 0.0

        # Initialize UNIPULT
        self.panel = RobotPanel(host="0.0.0.0", port=8080)
        self.setup_panel_callbacks()
        self.panel.start()

        # Telemetry Timer (10 Hz)
        self.timer = self.create_timer(0.1, self.telemetry_timer_callback)

    def setup_panel_callbacks(self):
        @self.panel.on_joystick
        def handle_joystick(x, y):
            if self.robot_state == "e-stop":
                return
            self.robot_state = "manual"
            twist = Twist()
            twist.linear.x = y * 0.5   # Scale forward speed (max 0.5 m/s)
            twist.angular.z = -x * 1.0 # Scale rotation speed (max 1.0 rad/s)
            self.cmd_vel_pub.publish(twist)

        @self.panel.on_estop
        def handle_estop():
            self.robot_state = "e-stop"
            # Publish 0 velocity immediately
            self.cmd_vel_pub.publish(Twist())
            self.get_logger().error("EMERGENCY STOP PRESSED FROM WEB TERMINAL!")

        @self.panel.on_autonomous_start
        def handle_auto_start():
            if self.robot_state != "e-stop":
                self.robot_state = "auto"
                # Call ROS navigation actions/services...

        @self.panel.on_autonomous_stop
        def handle_auto_stop():
            if self.robot_state == "auto":
                self.robot_state = "idle"
                self.cmd_vel_pub.publish(Twist())

        @self.panel.on_waypoints_update
        def handle_waypoints(wps):
            self.get_logger().info(f"Loaded {len(wps)} coordinates from Web Panel. Updating ROS Navigation Stack.")

    def odom_callback(self, msg: Odometry):
        # Extract coordinates
        self.x = msg.pose.pose.position.x
        self.y = msg.pose.pose.position.y
        self.z = msg.pose.pose.position.z
        
        # Convert quaternion to euler angles (Roll, Pitch, Yaw)
        q = msg.pose.pose.orientation
        siny_cosp = 2 * (q.w * q.z + q.x * q.y)
        cosy_cosp = 1 - 2 * (q.y * q.y + q.z * q.z)
        self.yaw = math.atan2(siny_cosp, cosy_cosp) * (180.0 / math.pi)

    def battery_callback(self, msg: Float32):
        self.battery_voltage = msg.data

    def telemetry_timer_callback(self):
        # Broadcast ROS states to Web Client
        self.panel.send_telemetry(
            state=self.robot_state,
            battery=self.battery_voltage,
            x=self.x,
            y=self.y,
            z=self.z,
            roll=self.roll,
            pitch=self.pitch,
            yaw=self.yaw
        )

    def destroy_node(self):
        self.panel.stop()
        super().destroy_node()

def main(args=None):
    rclpy.init(args=args)
    node = UnipultRosNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
```

---

## 5. Physical Robot Integration Blueprint (Arduino & RPi 5)

This section outlines standard hardware implementation details developed for Raspberry Pi 5 connected to an Arduino Nano over UART, utilizing a Waveshare UPS HAT (E) for power.

### 5.1 Arduino Nano: Steering Rate Limiter & Watchdog
To prevent current spikes from stalling the Arduino Nano and to ensure safety, implement a watchdog and a rate limiter:

*   **Watchdog (400ms)**: Stop motors and center steering if no valid serial command is parsed for over 400ms.
*   **Servo Rate Limiter**: Smoothly step the physical servo angle toward the target angle at a maximum rate of **45 degrees per second** (calculated using a delta time `dt` in milliseconds inside the main `loop`).

### 5.2 Python: Continuous Heartbeat Streaming (10Hz)
Since the Arduino implements a safety timeout, the Pi's script must stream the target speeds/angles continuously in the main thread at **10Hz (every 100ms)**, even when the joystick is stationary:
- Browser joystick movement only updates the local target state on the Pi.
- The main thread loops constantly, sending the current targets to feed the watchdog.
- **Safety Fallback**: If no clients are connected (`not panel.active_connections`), reset target speed to 0 immediately.
- **Clean Exit on E-STOP**: On E-STOP event, write stop command `(0, F, 0)`, wait 500ms, and exit the script with exit code `0` (`os._exit(0)`).

### 5.3 Python: Waveshare UPS HAT (E) Battery Telemetry (I2C)
Read battery status directly from the UPS HAT's I2C registers to transmit to the dashboard:
- **I2C Address**: `0x2D`
- **Register**: `0x20` (Read block of 12 bytes)
  - `voltage_v = (data[0] | (data[1] << 8)) / 1000.0`
  - `percent = data[4] | (data[5] << 8)`

### 5.4 systemd Service Configuration (`unipult.service`)
Configure a daemon to run the script after Wi-Fi is connected:
- **Service file** (`/etc/systemd/system/unipult.service`):
  ```ini
  [Unit]
  Description=UNIPULT Robot Control Panel Pilot
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  User=pi
  WorkingDirectory=/home/pi/git/vo_realtime
  ExecStart=/home/pi/git/vo_realtime/venv/bin/python3 -u unipult_pilot.py
  Restart=on-failure
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  ```
- Use `Restart=on-failure` combined with `os._exit(0)` on E-STOP so the service remains stopped after an E-STOP event but starts automatically on a new reboot.
