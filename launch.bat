@echo off
REM ============================================================
REM  Destroyer Game Server Launcher
REM  Starts the Node.js multiplayer server AND the three CPU bots
REM  (Easy / Normal / Hard), each waiting in its own lobby room.
REM  Two windows open so you can watch the logs; close them to stop.
REM ============================================================
cd /d "%~dp0"
echo [Destroyer] Starting game server...
start "Destroyer Server" cmd /k node server.js
REM Give the server a moment to bind the port before the bots connect
timeout /t 2 /nobreak >nul
echo [Destroyer] Starting Easy/Normal/Hard CPU bots...
start "Destroyer Bots" cmd /k node bot.js
echo [Destroyer] Server + bots launched. Now run play.bat to play.
echo [Destroyer] (The bots auto-reconnect, so they survive a server restart.)
