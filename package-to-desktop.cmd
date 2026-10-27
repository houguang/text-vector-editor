@echo off
REM ============================================================
REM  GlyphCut - 一键打包并发布到桌面
REM  用法：双击本文件，或在项目根目录执行  package-to-desktop.cmd
REM  产物：%USERPROFILE%\Desktop\GlyphCut.exe
REM ============================================================
setlocal
cd /d "%~dp0"
set "TARGET=%USERPROFILE%\Desktop\GlyphCut.exe"

echo [1/4] 检查应用是否在运行...
tasklist /FI "IMAGENAME eq GlyphCut.exe" 2>nul | find /I "GlyphCut.exe" >nul
if not errorlevel 1 (
  echo       检测到 GlyphCut 正在运行，正在请求关闭...
  taskkill /IM GlyphCut.exe >nul 2>&1
  timeout /t 3 /nobreak >nul
  tasklist /FI "IMAGENAME eq GlyphCut.exe" 2>nul | find /I "GlyphCut.exe" >nul
  if not errorlevel 1 (
    echo       [失败] 应用未能关闭，请手动退出后重试。
    pause
    exit /b 1
  )
)

echo [2/4] 编译发布版（cargo build --release）...
pushd src-tauri
cargo build --release
if errorlevel 1 (
  popd
  echo.
  echo [失败] 编译未通过，已终止。
  pause
  exit /b 1
)
popd

echo [3/4] 覆盖桌面产物...
copy /Y "src-tauri\target\release\glyphcut.exe" "%TARGET%" >nul
if errorlevel 1 (
  echo [失败] 复制到桌面失败（文件可能仍被占用）。
  pause
  exit /b 1
)

echo [4/4] 完成。
for %%F in ("%TARGET%") do echo       产物：%%~fF  ^(%%~zF 字节^)
echo.
echo 双击桌面 GlyphCut.exe 即可运行，无需安装。
pause
endlocal
