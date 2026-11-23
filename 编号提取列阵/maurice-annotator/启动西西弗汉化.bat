@echo off
setlocal

rem Copy the extension to a local ASCII path, then launch Edge with a dedicated profile.
rem Double-click this file to use the plugin without installing it manually.

set "EXT=%~dp0"
if "%EXT:~-1%"=="\" set "EXT=%EXT:~0,-1%"

set "APP=%LOCALAPPDATA%\MauriceAnnotator"
set "DEST=%APP%\extension"
set "PROFILE=%APP%\edge-profile-v2"
set "OLD_PROFILE=%APP%\edge-profile"
set "EXT_ID=pnhhagnmgmpdedjfokknpikmjimpbaio"

if not exist "%APP%" mkdir "%APP%" >nul 2>&1
if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

rem The old profile was disabled by Edge's "developer extension" rule.
rem A new profile with the feature flag enabled avoids that state.
rem Copy the extension's chrome.storage.local (dictionaries) into the new profile.
if not exist "%PROFILE%\Default" (
    if exist "%OLD_PROFILE%\Default\Local Extension Settings\%EXT_ID%" (
        robocopy "%OLD_PROFILE%\Default\Local Extension Settings\%EXT_ID%" "%PROFILE%\Default\Local Extension Settings\%EXT_ID%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
    )
)

robocopy "%EXT%" "%DEST%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo Failed to copy extension files. Check folder permissions.
    pause
    exit /b 1
)

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"

if not exist "%EDGE%" (
    echo Microsoft Edge was not found.
    echo You can open the Edge extensions page and load this folder manually:
    echo %DEST%
    pause
    exit /b 1
)

if not defined MAURICE_DRY_RUN goto launch
echo Extension: %DEST%
echo Browser: %EDGE%
echo Profile: %PROFILE%
exit /b 0

:launch
start "" "%EDGE%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-sync --disable-features=ExtensionDisableUnsupportedDeveloper --disable-extensions-except="%DEST%" --load-extension="%DEST%" "https://lell1203.github.io/maurice_simul/"
endlocal
