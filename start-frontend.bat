@echo off
rem WMS local development on Windows (section 11.3): the Vite dev server on port 5173 of every network
rem interface, with /api proxied to the backend at http://127.0.0.1:8080 (start-backend.bat).
rem Office: http://localhost:5173/   Drivers on the same network: http://PC-IP:5173/driver
cd /d "%~dp0frontend"
where node >nul 2>nul || (echo Node.js is not installed or not on PATH. Install Node.js 22; see README.md. & pause & exit /b 1)
node -e "process.exit(process.versions.node.split('.')[0] === '22' ? 0 : 1)" || (echo Node.js 22 is required. This PC has: & node -v & pause & exit /b 1)
rem Install the packages on the first start, and again whenever package-lock.json is newer than the
rem installed packages, for example after a git pull.
node -e "const f=require('fs');try{process.exit(f.statSync('package-lock.json').mtimeMs>f.statSync('node_modules/.package-lock.json').mtimeMs?1:0)}catch(e){process.exit(1)}" || call :install || exit /b 1
call npm run dev -- --host 0.0.0.0 --port 5173
exit /b

:install
echo Installing the frontend packages with npm ci. The first time this takes a few minutes...
call npm ci
if errorlevel 1 (echo. & echo npm ci failed: check the internet connection, then run this script again. & pause & exit /b 1)
exit /b 0
