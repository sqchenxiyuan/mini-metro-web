$ErrorActionPreference = 'Stop'
$metroRoot = Split-Path -Parent $PSScriptRoot
$artifactPath = Join-Path $metroRoot 'artifacts'
New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
$sourceEntries = @('src','tests','scripts','examples','package.json','package-lock.json','tsconfig.json','tsconfig.sdk.json','vite.config.ts','vitest.config.ts','index.html','README.md','AGENT.md','FIDELITY.md','VALIDATION.md','NOTICE.md','LICENSE.md') | ForEach-Object { Join-Path $metroRoot $_ }
Compress-Archive -LiteralPath $sourceEntries -DestinationPath (Join-Path $artifactPath 'orchard-metro-source.zip') -Force
$distEntries = Get-ChildItem -LiteralPath (Join-Path $metroRoot 'dist') | ForEach-Object FullName
Compress-Archive -LiteralPath $distEntries -DestinationPath (Join-Path $artifactPath 'orchard-metro-web.zip') -Force
Copy-Item -LiteralPath (Join-Path $metroRoot 'test-results/production/node-agent.json') -Destination (Join-Path $artifactPath 'sample-journey.json') -Force
Copy-Item -LiteralPath (Join-Path $metroRoot 'test-results/production/orchard-town.png') -Destination (Join-Path $artifactPath 'orchard-metro.png') -Force
Get-ChildItem -LiteralPath $artifactPath | Select-Object Name,Length
