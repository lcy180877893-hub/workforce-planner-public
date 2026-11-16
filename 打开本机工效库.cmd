@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0src\local-catalog-web.js" --open
) else (
  node "%~dp0src\local-catalog-web.js" --open
)
if errorlevel 1 pause
