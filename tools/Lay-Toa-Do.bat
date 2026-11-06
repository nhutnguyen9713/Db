@echo off
title TN5 - Lay toa do chuot
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wms-auto-export.ps1" -ToaDo
