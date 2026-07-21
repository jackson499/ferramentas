@echo off
chcp 65001 >nul
title Reiniciar Validador de WhatsApp
cd /d "%~dp0"

echo ============================================
echo   REINICIANDO O VALIDADOR DE WHATSAPP
echo ============================================
echo.

echo [1/4] Encerrando o servidor atual...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

echo [2/4] Fechando janelas travadas do WhatsApp Web...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*wwebjs_auth*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

echo [3/4] Limpando travas de sessao...
for /d %%D in (".wwebjs_auth\session-*") do (
    del /f /q "%%D\SingletonLock" 2>nul
    del /f /q "%%D\SingletonCookie" 2>nul
    del /f /q "%%D\SingletonSocket" 2>nul
)

echo [4/4] Subindo o servidor de novo...
REM Se a janela INICIAR ainda estiver rodando em loop, ela sobe sozinha em 5s.
REM Se nao estiver, iniciamos aqui (oculto, sem abrir janela preta).
timeout /t 6 /nobreak >nul
powershell -NoProfile -Command "if (-not (Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' })) { Start-Process wscript.exe -ArgumentList '\"%~dp0iniciar_oculto.vbs\"' }" 2>nul

echo.
echo ============================================
echo   PRONTO!
echo   Aguarde ~15 segundos, depois recarregue o
echo   painel: http://localhost:3000
echo ============================================
echo.
timeout /t 5 /nobreak >nul
