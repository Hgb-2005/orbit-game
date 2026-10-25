@echo off
setlocal
cd /d "%~dp0"

rem Use the project environment so another Python installation cannot interfere.
if not exist ".venv\Scripts\python.exe" (
    echo Please set up the project first:
    echo   python -m venv .venv
    echo   .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)

echo Game URL: http://127.0.0.1:5000/
echo Keep this window open while playing. Press Ctrl+C to stop the server.
echo.
".venv\Scripts\python.exe" app.py
if errorlevel 1 (
    echo.
    echo The server could not start. See the error above and README.md.
    pause
)
