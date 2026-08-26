@echo off
rem One-time setup for the completions proxy and the pirun CLI.
rem Safe to re-run. Pass --help for options.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
	echo [setup] Node.js was not found on PATH.
	echo [setup] Install Node 22.18 or newer from https://nodejs.org and run this again.
	pause
	exit /b 1
)

node bin\install.ts %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
endlocal & exit /b %EXITCODE%
