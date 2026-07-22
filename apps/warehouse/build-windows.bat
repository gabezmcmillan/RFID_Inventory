@echo off
REM Builds the standalone Windows app for the RFID Inventory tool.
REM Run this on a Windows machine from this apps\warehouse folder (double-click
REM works). Copy the WHOLE repo onto the machine, not just this folder --
REM requirements.txt installs the shared contract from ..\..\packages\contract.
REM Prereq: Python 3.10+ from python.org, installed with
REM         "Add python.exe to PATH" checked.

py -3 -m pip install --upgrade pip || goto :error
py -3 -m pip install -r requirements.txt pyinstaller || goto :error
py -3 -m PyInstaller RFIDInventory.spec --noconfirm || goto :error

REM Ship the editable per-machine settings next to the exe.
copy /Y settings.ini dist\RFIDInventory\ >nul

echo.
echo Build complete: dist\RFIDInventory\RFIDInventory.exe
echo Copy the whole dist\RFIDInventory folder to wherever the app should live.
pause
exit /b 0

:error
echo.
echo Build FAILED -- see the messages above.
pause
exit /b 1
