$token = "aaad4edbd7e57de0f34d035176a52842900d3216"
$headers = @{ "Authorization" = "Bearer $token"; "Accept" = "application/json" }
$base = "https://app.enlyze.com/api/v2"

Write-Host "Fetching machines..."
$machinesReq = Invoke-RestMethod -Uri "$base/machines" -Headers $headers -Method GET
$machines = $machinesReq.data
Write-Host "Found $($machines.Count) machines."

$discovery = @{}

foreach ($m in $machines) {
    Write-Host "Fetching variables for machine $($m.name) ($($m.uuid))..."
    $varsUrl = "$base/variables?machine=$($m.uuid)"
    $vars = @()
    
    try {
        $varsRes = Invoke-RestMethod -Uri $varsUrl -Headers $headers -Method GET
        if ($varsRes -and $varsRes.data) {
            $vars += $varsRes.data
            $nextCursor = $varsRes.metadata.next_cursor
            
            while ($nextCursor) {
                $encodedCursor = [uri]::EscapeDataString($nextCursor)
                $nextUrl = "$base/variables?machine=$($m.uuid)&cursor=$encodedCursor"
                $nextRes = Invoke-RestMethod -Uri $nextUrl -Headers $headers -Method GET
                if ($nextRes -and $nextRes.data) {
                    $vars += $nextRes.data
                    $nextCursor = $nextRes.metadata.next_cursor
                } else {
                    $nextCursor = $null
                }
            }
        }
    } catch {
        Write-Host "Error fetching variables for $($m.name): $_"
    }
    
    Write-Host "Found $($vars.Count) variables for $($m.name)"
    
    $discovery[$m.uuid] = @{
        machine = $m
        variables = $vars
    }
}

$discovery | ConvertTo-Json -Depth 10 | Out-File -FilePath "c:\Users\Salam\Desktop\Production\Project_Anti\machines_config.json" -Encoding utf8
Write-Host "Wrote machines_config.json"
