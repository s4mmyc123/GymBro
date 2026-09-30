# Zero-install local web server for Custom Fit (uses .NET, built into Windows).
# Run with:  .\serve.ps1
# Then open http://localhost:8080 in Chrome. Press Ctrl+C here to stop it.

$port = 8080
$root = $PSScriptRoot

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving '$root' at http://localhost:$port/  (Ctrl+C to stop)"

$mimeMap = @{
    ".html" = "text/html"
    ".js"   = "application/javascript"
    ".css"  = "text/css"
    ".json" = "application/json"
    ".png"  = "image/png"
    ".svg"  = "image/svg+xml"
    ".ico"  = "image/x-icon"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        # One bad request must not take the server down, so each one is
        # handled in its own try/catch (a HEAD probe, a dropped connection).
        try {
            $reqPath = $context.Request.Url.LocalPath.TrimStart('/')
            if ([string]::IsNullOrEmpty($reqPath)) { $reqPath = "index.html" }
            $filePath = Join-Path $root $reqPath

            if (Test-Path $filePath -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $context.Response.ContentType = $mimeMap[$ext]
                if (-not $context.Response.ContentType) { $context.Response.ContentType = "application/octet-stream" }
                $context.Response.Headers.Add("Cache-Control", "no-cache")
                $context.Response.ContentLength64 = $bytes.Length
                # A HEAD request gets the headers only; writing a body to it throws.
                if ($context.Request.HttpMethod -ne "HEAD") {
                    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } else {
                $context.Response.StatusCode = 404
            }
        } catch {
            Write-Host "Request failed: $($_.Exception.Message)"
        } finally {
            try { $context.Response.OutputStream.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}
