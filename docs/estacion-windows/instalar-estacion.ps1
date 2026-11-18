# Instalador de la estación Munch (Windows 10/11). Sin dependencias.
# - Crea accesos directos "Munch Caja" y "Munch Cocina" con impresión directa (--kiosk-printing).
# - Usa un perfil propio del navegador (%LOCALAPPDATA%\MunchPOS) para que el modo directo
#   aplique aunque el Chrome personal esté abierto. La caja abre también WhatsApp Web en ese
#   mismo perfil: así "Listo y avisar" reutiliza esa pestaña.
# - Deja la impresora térmica elegida como predeterminada.
# Se ejecuta con instalar-estacion.bat (doble clic). No necesita permisos de administrador.
$ErrorActionPreference = "Stop"
$Base = "https://munchec.com"
$Sede = "sede-01"   # UIDE
$Perfil = Join-Path $env:LOCALAPPDATA "MunchPOS"

# 1) Navegador: Chrome; si no existe, Edge (ambos aceptan --kiosk-printing).
$candidatos = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$nav = $candidatos | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $nav) { Write-Host "No encontré Chrome ni Edge. Instala Google Chrome y vuelve a ejecutar." -ForegroundColor Red; exit 1 }
Write-Host "Navegador: $nav"

# 2) Impresora predeterminada.
$impresoras = @(Get-CimInstance Win32_Printer | Sort-Object Name)
if ($impresoras.Count -gt 0) {
  Write-Host "`nImpresoras instaladas:"
  for ($i = 0; $i -lt $impresoras.Count; $i++) { Write-Host ("  [{0}] {1}" -f ($i + 1), $impresoras[$i].Name) }
  $op = Read-Host "`nNúmero de la impresora TÉRMICA (Enter para no cambiar)"
  if ($op -match '^\d+$' -and [int]$op -ge 1 -and [int]$op -le $impresoras.Count) {
    # Windows 10/11 cambia la predeterminada sola si esto está activo: se apaga.
    New-ItemProperty -Path "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows" -Name "LegacyDefaultPrinterMode" -Value 1 -PropertyType DWord -Force | Out-Null
    Invoke-CimMethod -InputObject $impresoras[[int]$op - 1] -MethodName SetDefaultPrinter | Out-Null
    Write-Host ("Predeterminada: {0}" -f $impresoras[[int]$op - 1].Name) -ForegroundColor Green
  }
} else { Write-Host "No hay impresoras instaladas: instala el driver de la térmica y vuelve a ejecutar." -ForegroundColor Yellow }

# 3) Accesos directos en el Escritorio.
$shell = New-Object -ComObject WScript.Shell
$escritorio = [Environment]::GetFolderPath("Desktop")
function Acceso($nombre, $argumentos) {
  $lnk = $shell.CreateShortcut((Join-Path $escritorio "$nombre.lnk"))
  $lnk.TargetPath = $nav
  $lnk.Arguments = $argumentos
  $lnk.WorkingDirectory = Split-Path $nav
  $lnk.Save()
  Write-Host "Creado: $nombre" -ForegroundColor Green
}
$comun = "--kiosk-printing --user-data-dir=`"$Perfil`" --no-first-run"
Acceso "Munch Caja"   "$comun --new-window $Base/panel/pos https://web.whatsapp.com/"
Acceso "Munch Cocina" "$comun --new-window `"$Base/panel/cocina?sede=$Sede`""

# 4) Opcional: abrir la caja al encender la PC.
if ((Read-Host "`n¿Abrir 'Munch Caja' al iniciar Windows? (s/n)") -match '^[sS]') {
  Copy-Item (Join-Path $escritorio "Munch Caja.lnk") ([Environment]::GetFolderPath("Startup")) -Force
  Write-Host "Agregado al inicio de Windows." -ForegroundColor Green
}

Write-Host @"

LISTO. Siguientes pasos:
 1. Cierra el navegador y abre 'Munch Caja' desde el Escritorio.
 2. Inicia sesión en la caja y escanea el QR de WhatsApp Web (solo la primera vez).
 3. Imprime una comanda de prueba: debe salir directo, sin diálogo.
 4. En la PC de cocina, abre 'Munch Cocina' y enciende 'Impresión automática'
    (solo UNA estación por sede con impresión automática).
"@
