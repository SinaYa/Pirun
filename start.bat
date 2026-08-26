@echo off
setlocal
title completions-proxy

rem Start the local completions API proxy.
rem   start.bat            - run in this window
rem   start.bat --port 9000 - override the port from proxy.cfg for this run

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
	echo [completions-proxy] Node.js was not found on PATH.
	echo [completions-proxy] Install Node 22.18 or newer, then run this again.
	exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
	echo [completions-proxy] Node %NODE_MAJOR% is too old. This proxy runs TypeScript directly and needs Node 22.18+.
	exit /b 1
)

if not exist "..\node_modules\yaml" (
	if not exist "node_modules\yaml" (
		echo [completions-proxy] The "yaml" package was not found.
		echo [completions-proxy] Run "npm install" in this folder, or in the parent project.
		exit /b 1
	)
)

echo [completions-proxy] starting...
node --no-warnings src\server.ts %*
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
	echo.
	echo [completions-proxy] exited with code %EXITCODE%
	pause
)
endlocal & exit /b %EXITCODE%
