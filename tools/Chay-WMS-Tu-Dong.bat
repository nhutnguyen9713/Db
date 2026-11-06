@echo off
title TN5 - Tu dong Export WMS (dong cua so nay de dung)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wms-auto-export.ps1"
pause
