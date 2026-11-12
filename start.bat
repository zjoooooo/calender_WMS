@echo off
rem WMS local development on Windows (section 11.3): opens start-backend.bat and start-frontend.bat in
rem two console windows. Office: http://localhost:5173/   Drivers on the same network: http://PC-IP:5173/driver
rem The admin password of the first start is printed in the "WMS backend" window.
cd /d "%~dp0"
start "WMS backend" cmd /k start-backend.bat
start "WMS frontend" cmd /k start-frontend.bat
