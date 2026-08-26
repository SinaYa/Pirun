@echo off
rem pirun — drive the Pi coding agent through the local completions proxy.
rem Usage: pirun.bat <command> [options]   (run "pirun.bat help" for the list)
setlocal
node --no-warnings "%~dp0bin\pirun.ts" %*
exit /b %ERRORLEVEL%
