@echo off
rem WMS local development and trials on Windows (section 11.3).
rem Serves the API, plus the built app once build.bat has run, on port 8080 of every network interface:
rem http://localhost:8080/ on this PC, http://PC-IP:8080/ from other devices on the office network.
rem The first start creates backend\data and prints the admin password; it is also written to
rem backend\data\initial-admin.txt, which is deleted after the first password change (R33).
rem To use another data folder, for example a copy of a VPS backup, run first in the same window:
rem   set WMS_DATA_DIR=C:\path\to\folder
cd /d "%~dp0"
where php >nul 2>nul || (echo PHP is not installed or not on PATH. Install PHP 8.3 and add its folder to PATH; see README.md. & pause & exit /b 1)
php -r "exit(PHP_VERSION_ID >= 80300 ? 0 : 1);" || (echo PHP 8.3 or newer is required. This PC has: & php -v & pause & exit /b 1)
if not exist backend\public\app mkdir backend\public\app
php backend\tools\init.php
if errorlevel 1 (echo The data folder could not be prepared; see the message above. & pause & exit /b 1)
echo WMS backend on http://localhost:8080/ - API check: http://localhost:8080/api/health - Ctrl+C stops it.
:loop
php -S 0.0.0.0:8080 -t backend\public\app backend\public\index.php
echo Backend stopped, restarting in 2 s...
timeout /t 2 /nobreak >nul
goto loop
