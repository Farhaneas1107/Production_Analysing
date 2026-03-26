## serve_analyzer.ps1
## Dedicated network server for the Micro Metrics Analyzer Dashboard (V1 & V2)
## - Serves static files from the project folder
## - Forwards all /proxy/* calls to the ENLYZE API proxy on port 8085
## - Uses raw TCP sockets (no admin required)
## - Accessible to anyone on the same LAN

$port = 8086
$folder = "c:\Users\Salam\Desktop\Production\Project_Anti"

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
try {
    $listener.Start()
} catch {
    Write-Host "ERROR: Could not start on port $port - is it already in use?"
    exit 1
}

# Detect LAN IP to display the sharing URL
$lanIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notmatch '^127\.' -and $_.IPAddress -notmatch '^169\.254'
} | Sort-Object PrefixLength -Descending | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "=========================================================="
Write-Host "   NAUE Micro Metrics Analyzer - Network Server Online!"
Write-Host "=========================================================="
Write-Host ""
Write-Host "   LOCAL  (you):        http://localhost:$port/analyzer_v1.html"
if ($lanIP) {
    Write-Host "   NETWORK (colleagues): http://${lanIP}:$port/analyzer_v2.html"
}
Write-Host ""
Write-Host "   Keep this window open to stay online."
Write-Host "   Note: serve.ps1 (port 8085) must also be running!"
Write-Host "=========================================================="
Write-Host ""

Start-Process "http://localhost:$port/analyzer_v1.html"

function Get-MimeType($ext) {
    switch ($ext) {
        ".html" { "text/html; charset=utf-8" }
        ".js"   { "application/javascript; charset=utf-8" }
        ".css"  { "text/css; charset=utf-8" }
        ".json" { "application/json; charset=utf-8" }
        ".png"  { "image/png" }
        ".ico"  { "image/x-icon" }
        default { "text/plain" }
    }
}

function Send-Response($stream, $statusLine, $contentType, $bytes, $extraHeaders = @{}) {
    $header = "$statusLine`r`n"
    $header += "Content-Type: $contentType`r`n"
    $header += "Content-Length: $($bytes.Length)`r`n"
    $header += "Access-Control-Allow-Origin: *`r`n"
    $header += "Access-Control-Allow-Headers: *`r`n"
    $header += "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n"
    foreach ($k in $extraHeaders.Keys) { $header += "${k}: $($extraHeaders[$k])`r`n" }
    $header += "Connection: close`r`n`r`n"
    $hb = [System.Text.Encoding]::UTF8.GetBytes($header)
    $stream.Write($hb, 0, $hb.Length)
    if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length) }
}

while ($true) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 50; continue }

    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 3000
    $stream = $client.GetStream()

    try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $false, 4096, $true)

        # Read request line
        $requestLine = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($requestLine)) { $client.Close(); continue }

        $parts = $requestLine.Trim().Split(" ")
        if ($parts.Length -lt 2) { $client.Close(); continue }

        $method   = $parts[0].ToUpper()
        $fullUrl  = $parts[1]
        $urlPath  = $fullUrl.Split("?")[0]
        $urlQuery = if ($fullUrl.Contains("?")) { "?" + $fullUrl.Split("?",2)[1] } else { "" }

        # Read all headers
        $reqHeaders = @{}
        while ($true) {
            $line = $reader.ReadLine()
            if ([string]::IsNullOrEmpty($line)) { break }
            $idx = $line.IndexOf(":")
            if ($idx -gt 0) {
                $k = $line.Substring(0,$idx).Trim()
                $v = $line.Substring($idx+1).Trim()
                $reqHeaders[$k] = $v
            }
        }

        # Handle CORS preflight
        if ($method -eq "OPTIONS") {
            Send-Response $stream "HTTP/1.1 204 No Content" "text/plain" @()
            $client.Close(); continue
        }

        # ---- PROXY: forward /proxy/* to localhost:8085 ----
        if ($urlPath -match "^/proxy/") {
            $proxyUrl = "http://127.0.0.1:8085${urlPath}${urlQuery}"
            try {
                $proxyReq = [System.Net.WebRequest]::Create($proxyUrl)
                $proxyReq.Method = $method
                $proxyReq.Timeout = 120000
                $proxyReq.ReadWriteTimeout = 120000

                # If POST, read body and forward
                if ($method -eq "POST" -and $reqHeaders.ContainsKey("Content-Length")) {
                    $bodyLen = [int]$reqHeaders["Content-Length"]
                    if ($bodyLen -gt 0) {
                        $proxyReq.ContentType = "application/json"
                        $proxyReq.ContentLength = $bodyLen
                        $bodyBuf = New-Object byte[] $bodyLen
                        $rawStream = $client.GetStream()
                        $total = 0
                        while ($total -lt $bodyLen) {
                            $r = $rawStream.Read($bodyBuf, $total, $bodyLen - $total)
                            if ($r -le 0) { break }
                            $total += $r
                        }
                        $ps = $proxyReq.GetRequestStream()
                        $ps.Write($bodyBuf, 0, $total)
                        $ps.Close()
                    }
                }

                $proxyRes = $proxyReq.GetResponse()
                $ms = New-Object System.IO.MemoryStream
                $proxyRes.GetResponseStream().CopyTo($ms)
                $proxyRes.Close()
                $respBytes = $ms.ToArray()
                Send-Response $stream "HTTP/1.1 200 OK" "application/json" $respBytes
            } catch {
                $errBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"proxy unavailable - is serve.ps1 running?"}')
                Send-Response $stream "HTTP/1.1 502 Bad Gateway" "application/json" $errBytes
            }
            $client.Close(); continue
        }

        # ---- STATIC FILE SERVING ----
        if ($urlPath -eq "/") { $urlPath = "/analyzer_v1.html" }
        $urlPath = $urlPath.Replace("..", "").TrimStart("/")
        $fullPath = Join-Path $folder $urlPath

        if (Test-Path $fullPath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $ext   = [System.IO.Path]::GetExtension($fullPath).ToLower()
            $mime  = Get-MimeType $ext
            Send-Response $stream "HTTP/1.1 200 OK" $mime $bytes
        } else {
            $notFound = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
            Send-Response $stream "HTTP/1.1 404 Not Found" "text/plain" $notFound
        }
    } catch {
        # Silently swallow dropped connections
    } finally {
        $client.Close()
    }
}
