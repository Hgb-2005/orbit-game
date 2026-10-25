@echo off
setlocal
cd /d "%~dp0"
set "HOST=0.0.0.0"
echo LAN mode: friends should open this computer's LAN URL, not 127.0.0.1.
echo If port 5000 is busy, stop the old start.bat server first.
call "%~dp0start.bat"
