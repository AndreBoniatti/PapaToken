# Registra o PacmanToken para iniciar junto com o Windows (Agendador de Tarefas).
# Rode uma vez em um PowerShell comum (não precisa de admin para tarefa de usuário):
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

$repo = Split-Path -Parent $PSScriptRoot
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute $npm -Argument "run start" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "PacmanToken" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Tarefa agendada 'PacmanToken' registrada. O servidor iniciará no próximo logon em http://127.0.0.1:3333"
Write-Host "Para remover: Unregister-ScheduledTask -TaskName PacmanToken"
