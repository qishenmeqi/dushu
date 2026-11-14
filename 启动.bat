@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 读书
node server.js
if errorlevel 1 (
  echo.
  echo 启动失败。检查一下电脑里有没有安装 Node.js。
  echo 下载地址：https://nodejs.org
  echo.
  pause
)
