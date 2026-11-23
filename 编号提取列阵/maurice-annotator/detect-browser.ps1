# 读取 Windows 默认浏览器的可执行文件路径。
# 只输出路径；失败时输出空字符串，不抛错。

$ErrorActionPreference = 'SilentlyContinue'

function Get-CommandPath($key) {
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    return $item.'(default)'
}

$progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction SilentlyContinue).ProgId
$command = $null

if ($progId) {
    $command = Get-CommandPath "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command"
    if (-not $command) {
        $command = Get-CommandPath "HKCU:\Software\Classes\$progId\shell\open\command"
    }
}
if (-not $command) {
    $command = Get-CommandPath 'Registry::HKEY_CLASSES_ROOT\http\shell\open\command'
}
if (-not $command) { return }

$exe = $null
if ($command -match '^\s*"([^"]+)"') {
    $exe = $matches[1]
} elseif ($command -match '^\s*(\S+?\.exe)') {
    $exe = $matches[1]
}

if ($exe -and (Test-Path -LiteralPath $exe)) {
    Write-Output $exe
}
