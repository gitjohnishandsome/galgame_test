@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://127.0.0.1:8010/tools/editor/index.html
python tools\editor_server.py
pause
