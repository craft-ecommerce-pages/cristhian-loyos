@echo off
rem Doble clic: ejecuta el instalador de la estacion Munch (caja/cocina) sin cambiar la politica del sistema.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-estacion.ps1"
pause
