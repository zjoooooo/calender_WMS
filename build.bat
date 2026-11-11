@echo off
rem WMS local trial on Windows (section 11.3): builds the frontend into backend\public\app. After it,
rem start-backend.bat alone serves the whole app on port 8080: the office at http://PC-IP:8080/ and the
rem drivers at http://PC-IP:8080/driver
cd /d "%~dp0frontend"
where node >nul 2>nul || (echo Node.js is not installed or not on PATH. Install Node.js 22; see README.md. & pause & exit /b 1)
node -e "process.exit(process.versions.node.split('.')[0] === '22' ? 0 : 1)" || (echo Node.js 22 is required. This PC has: & node -v & pause & exit /b 1)
node -e "const f=require('fs');try{process.exit(f.statSync('package-lock.json').mtimeMs>f.statSync('node_modules/.package-lock.json').mtimeMs?1:0)}catch(e){process.exit(1)}" || call :install || exit /b 1
call npm run build
if errorlevel 1 (echo. & echo The build failed; see the messages above. & pause & exit /b 1)
echo.
echo Build done: backend\public\app. Run start-backend.bat and open http://localhost:8080/
pause
exit /b 0

:install
echo Installing the frontend packages with npm ci. The first time this takes a few minutes...
call npm ci
if errorlevel 1 (echo. & echo npm ci failed: check the internet connection, then run this script again. & pause & exit /b 1)
exit /b 0
