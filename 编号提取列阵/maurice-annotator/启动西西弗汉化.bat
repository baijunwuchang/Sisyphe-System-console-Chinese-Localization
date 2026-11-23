@echo off
setlocal

rem Copy the extension to a local ASCII path, then launch a Chromium browser
rem with a dedicated profile. Edge is preferred because it reliably supports
rem --load-extension; if Edge is absent, the Windows default browser is used
rem when it is Chromium-based. Firefox/IE/Safari fall back to manual install.

set "EXT=%~dp0"
if "%EXT:~-1%"=="\" set "EXT=%EXT:~0,-1%"

set "APP=%LOCALAPPDATA%\MauriceAnnotator"
set "DEST=%APP%\extension"
set "EXT_ID=pnhhagnmgmpdedjfokknpikmjimpbaio"
set "URL=https://lell1203.github.io/maurice_simul/"
set "FLAGS=--no-first-run --no-default-browser-check --disable-sync --disable-features=DisableLoadExtensionCommandLineSwitch,ExtensionDisableUnsupportedDeveloper"

if not exist "%APP%" mkdir "%APP%" >nul 2>&1
if not exist "%DEST%" mkdir "%DEST%" >nul 2>&1

robocopy "%EXT%" "%DEST%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo Failed to copy extension files. Check folder permissions.
    pause
    exit /b 1
)

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if defined MAURICE_SKIP_EDGE goto detect_default
if exist "%EDGE%" goto use_edge

:detect_default
set "DEFAULT_BROWSER="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect-browser.ps1"`) do set "DEFAULT_BROWSER=%%I"
if defined MAURICE_FORCE_BROWSER set "DEFAULT_BROWSER=%MAURICE_FORCE_BROWSER%"

if not defined DEFAULT_BROWSER goto use_chrome
set "BROWSER=%DEFAULT_BROWSER%"
echo "%BROWSER%" | findstr /i /c:"firefox.exe" /c:"iexplore.exe" /c:"safari.exe" >nul
if not errorlevel 1 goto use_chrome
echo "%BROWSER%" | findstr /i /c:"chrome.exe" >nul
if not errorlevel 1 goto check_default_chrome

set "PROFILE=%APP%\browser-profile-v2"
set "BROWSER_FAMILY=Chromium default browser"
goto prepare_profile

:check_default_chrome
set "CHROME=%BROWSER%"
set "CHROME_VERSION="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Item '%CHROME%').VersionInfo.FileVersion"`) do set "CHROME_VERSION=%%V"
for /f "tokens=1 delims=." %%M in ("%CHROME_VERSION%") do set "CHROME_MAJOR=%%M"
if not defined CHROME_MAJOR goto manual
if %CHROME_MAJOR% GEQ 137 goto manual
set "PROFILE=%APP%\browser-profile-v2"
set "BROWSER_FAMILY=Chrome default browser"
goto prepare_profile

:use_edge
set "BROWSER=%EDGE%"
set "PROFILE=%APP%\edge-profile-v2"
set "BROWSER_FAMILY=Edge"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1
rem The old Edge profile was disabled by Edge's developer-extension rule.
rem A new profile with the feature flag avoids that state. Copy the extension's
rem chrome.storage.local (dictionaries / clientId) on first use.
if not exist "%PROFILE%\Default" (
    if exist "%APP%\edge-profile\Default\Local Extension Settings\%EXT_ID%" (
        robocopy "%APP%\edge-profile\Default\Local Extension Settings\%EXT_ID%" "%PROFILE%\Default\Local Extension Settings\%EXT_ID%" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS >nul
    )
)
goto prepare_profile

:use_chrome
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" goto manual
set "CHROME_VERSION="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Item '%CHROME%').VersionInfo.FileVersion"`) do set "CHROME_VERSION=%%V"
for /f "tokens=1 delims=." %%M in ("%CHROME_VERSION%") do set "CHROME_MAJOR=%%M"
if not defined CHROME_MAJOR goto manual
if %CHROME_MAJOR% GEQ 137 goto manual
set "BROWSER=%CHROME%"
set "PROFILE=%APP%\browser-profile-v2"
set "BROWSER_FAMILY=Chrome fallback"
goto prepare_profile

:prepare_profile
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1
if defined MAURICE_DRY_RUN goto dry_run
start "" "%BROWSER%" %FLAGS% --user-data-dir="%PROFILE%" --disable-extensions-except="%DEST%" --load-extension="%DEST%" "%URL%"
endlocal
exit /b 0

:dry_run
echo Extension: %DEST%
echo Browser: %BROWSER%
echo Profile: %PROFILE%
echo Type: %BROWSER_FAMILY%
exit /b 0

:manual
if defined MAURICE_DRY_RUN (
    echo Manual fallback: this browser cannot auto-load the extension.
    exit /b 2
)
echo Your default browser does not support command-line extension loading
echo (Firefox / Internet Explorer / Safari), and Chrome was not found.
echo.
echo Opening the site with your default browser. To use the plugin, install
echo Microsoft Edge or Google Chrome, then double-click this file again.
echo Manual extension folder:
echo %DEST%
if defined DEFAULT_BROWSER (
    start "" "%DEFAULT_BROWSER%" "%URL%"
) else (
    start "" "%URL%"
)
pause
exit /b 1
