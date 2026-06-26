import os
import json
import asyncio
import threading
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from typing import Callable, Dict, List, Any, Optional

class RobotPanel:
    def __init__(self, host: str = "0.0.0.0", port: int = 8080, storage_dir: str = "./data"):
        """
        Universal Robot Control Panel Server.
        Runs a web-based dashboard with WebSockets for real-time joystick, E-stop, and telemetry.
        """
        self.host = host
        self.port = port
        self.storage_dir = storage_dir
        os.makedirs(self.storage_dir, exist_ok=True)

        self.app = FastAPI(title="UNIPULT Robot Control Panel")
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.server: Optional[uvicorn.Server] = None
        self.thread: Optional[threading.Thread] = None

        # Event Callback Registrations
        self._joystick_cb: Optional[Callable[[float, float], None]] = None
        self._estop_cb: Optional[Callable[[], None]] = None
        self._auto_start_cb: Optional[Callable[[], None]] = None
        self._auto_stop_cb: Optional[Callable[[], None]] = None
        self._waypoints_cb: Optional[Callable[[List[Dict[str, Any]]], None]] = None
        self._aruco_cb: Optional[Callable[[List[Dict[str, Any]]], None]] = None

        # Connected clients
        self.active_connections: List[WebSocket] = []

        self._setup_routes()

    def _setup_routes(self):
        # Map directories relative to this file
        current_dir = os.path.dirname(os.path.abspath(__file__))
        static_dir = os.path.join(current_dir, "static")
        templates_dir = os.path.join(current_dir, "templates")

        # Mount static assets if the folder exists
        if os.path.exists(static_dir):
            self.app.mount("/static", StaticFiles(directory=static_dir), name="static")

        # Serve the main HTML interface
        @self.app.get("/", response_class=HTMLResponse)
        async def get_index():
            index_path = os.path.join(templates_dir, "index.html")
            if os.path.exists(index_path):
                with open(index_path, "r", encoding="utf-8") as f:
                    return f.read()
            return """
            <html>
                <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background: #0b0f19; color: #fff;">
                    <h2>UNIPULT: templates/index.html is missing.</h2>
                    <p>Please ensure templates/index.html exists in the package folder.</p>
                </body>
            </html>
            """

        # Capture the async event loop during startup to allow thread-safe broadcasts later
        @self.app.on_event("startup")
        async def on_startup():
            self.loop = asyncio.get_running_loop()

        # WebSocket endpoint for real-time bi-directional data
        @self.app.websocket("/ws")
        async def websocket_endpoint(websocket: WebSocket):
            await websocket.accept()
            self.active_connections.append(websocket)

            # Send initial persistent data (waypoints and aruco markers) immediately
            try:
                aruco_data = self._load_data("aruco.json")
                waypoints_data = self._load_data("waypoints.json")
                await websocket.send_json({
                    "type": "init",
                    "aruco": aruco_data,
                    "waypoints": waypoints_data
                })

                # Listen for messages from this client
                while True:
                    data = await websocket.receive_json()
                    await self._handle_ws_message(data)

            except WebSocketDisconnect:
                pass
            except Exception as e:
                print(f"[UNIPULT WS Error] {e}")
            finally:
                if websocket in self.active_connections:
                    self.active_connections.remove(websocket)

    async def _handle_ws_message(self, data: Dict[str, Any]):
        msg_type = data.get("type")

        if msg_type == "joystick":
            x = float(data.get("x", 0.0))
            y = float(data.get("y", 0.0))
            if self._joystick_cb:
                self._joystick_cb(x, y)

        elif msg_type == "estop":
            if self._estop_cb:
                self._estop_cb()

        elif msg_type == "auto_start":
            if self._auto_start_cb:
                self._auto_start_cb()

        elif msg_type == "auto_stop":
            if self._auto_stop_cb:
                self._auto_stop_cb()

        elif msg_type == "waypoints_update":
            waypoints = data.get("waypoints", [])
            self._save_data("waypoints.json", waypoints)
            if self._waypoints_cb:
                self._waypoints_cb(waypoints)

        elif msg_type == "aruco_update":
            markers = data.get("aruco", [])
            self._save_data("aruco.json", markers)
            if self._aruco_cb:
                self._aruco_cb(markers)

    # Persistence Helpers
    def _load_data(self, filename: str) -> List[Any]:
        filepath = os.path.join(self.storage_dir, filename)
        if os.path.exists(filepath):
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[UNIPULT Load Error] Failed to read {filename}: {e}")
        return []

    def _save_data(self, filename: str, data: Any):
        filepath = os.path.join(self.storage_dir, filename)
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[UNIPULT Save Error] Failed to write {filename}: {e}")

    # Callback Decorators
    def on_joystick(self, cb: Callable[[float, float], None]) -> Callable[[float, float], None]:
        """Registers a callback for joystick movement. Pass function accepting (x, y) floats."""
        self._joystick_cb = cb
        return cb

    def on_estop(self, cb: Callable[[], None]) -> Callable[[], None]:
        """Registers a callback for the emergency stop button."""
        self._estop_cb = cb
        return cb

    def on_autonomous_start(self, cb: Callable[[], None]) -> Callable[[], None]:
        """Registers a callback for starting autonomous movement."""
        self._auto_start_cb = cb
        return cb

    def on_autonomous_stop(self, cb: Callable[[], None]) -> Callable[[], None]:
        """Registers a callback for stopping autonomous movement."""
        self._auto_stop_cb = cb
        return cb

    def on_waypoints_update(self, cb: Callable[[List[Dict[str, Any]]], None]) -> Callable[[List[Dict[str, Any]]], None]:
        """Registers a callback when the sequence of waypoints changes."""
        self._waypoints_cb = cb
        return cb

    def on_aruco_update(self, cb: Callable[[List[Dict[str, Any]]], None]) -> Callable[[List[Dict[str, Any]]], None]:
        """Registers a callback when the list of Aruco markers changes."""
        self._aruco_cb = cb
        return cb

    # Thread-Safe Telemetry Broadcast
    def send_telemetry(self, **kwargs):
        """
        Sends telemetry variables to all connected clients in a thread-safe way.
        Can be called safely from any thread.
        Example: panel.send_telemetry(battery=12.6, speed=0.5, state="Auto", x=1.2, y=3.4)
        """
        if not self.active_connections or self.loop is None:
            return

        message = {
            "type": "telemetry",
            "data": kwargs
        }

        async def broadcast():
            dead_connections = []
            for ws in self.active_connections:
                try:
                    await ws.send_json(message)
                except Exception:
                    dead_connections.append(ws)
            # Clean up disconnected sockets
            for ws in dead_connections:
                if ws in self.active_connections:
                    self.active_connections.remove(ws)

        # Schedule the broadcast coroutine in the FastAPI event loop
        asyncio.run_coroutine_threadsafe(broadcast(), self.loop)

    # Server Thread Management
    def start(self):
        """Launches the web server in a background daemon thread."""
        self.thread = threading.Thread(target=self._run_server, daemon=True)
        self.thread.start()
        print(f"[UNIPULT] Server started in background at http://{self.host}:{self.port}")

    def _run_server(self):
        # Modern uvicorn auto-detects background thread and disables signal handlers automatically
        config = uvicorn.Config(
            self.app, 
            host=self.host, 
            port=self.port, 
            log_level="warning"
        )
        self.server = uvicorn.Server(config)
        self.server.run()

    def stop(self):
        """Stops the running web server."""
        if self.server:
            self.server.should_exit = True
            print("[UNIPULT] Server shutdown requested.")
