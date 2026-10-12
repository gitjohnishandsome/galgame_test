@echo off
chcp 65001 >nul
cd /d "%~dp0"
python tools\optimize_assets.py %*
echo.
pause
