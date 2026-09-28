@echo off
chcp 65001 >nul
title Torneum Dota 2 - сервер драфта
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js не установлен.
  echo  Скачайте LTS-версию с https://nodejs.org, установите и запустите этот файл снова.
  echo.
  pause
  exit /b 1
)

rem Через 2 секунды открываем админ-панель в браузере
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
