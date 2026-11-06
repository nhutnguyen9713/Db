@echo off
title TN5 - Chay thu 1 luot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wms-auto-export.ps1" -MotLuot
pause
