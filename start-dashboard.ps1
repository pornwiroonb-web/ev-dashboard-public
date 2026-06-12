Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot
try {
  node .\server.js
}
finally {
  Pop-Location
}

