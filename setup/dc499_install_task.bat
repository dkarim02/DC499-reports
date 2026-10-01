@echo off
:: Registers the DC499 Auto-Refresh scheduled task.
:: Run this instead of the .ps1 directly — bypasses PowerShell execution policy.
chcp 65001 >nul
powershell -ExecutionPolicy Bypass -File "%~dp0dc499_setup_task.ps1"
