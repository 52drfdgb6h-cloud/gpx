param(
  [Parameter(Mandatory = $true)]
  [string]$Proxy
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$headers = @{}
if ($null -ne $payload.headers) {
  $payload.headers.psobject.Properties | ForEach-Object { $headers[$_.Name] = $_.Value }
}

$request = @{ Uri = $payload.url; Method = $payload.method; Headers = $headers; Proxy = $Proxy; ProxyUseDefaultCredentials = $true; UseBasicParsing = $true }
if ($null -ne $payload.body) {
  $request.Body = $payload.body
  $request.ContentType = $payload.contentType
}

try {
  $result = Invoke-RestMethod @request
  ConvertTo-Json -InputObject $result -Depth 100 -Compress
} catch {
  $message = $_.ErrorDetails.Message
  if ([string]::IsNullOrWhiteSpace($message) -and $null -ne $_.Exception.Response) {
    $responseStream = $_.Exception.Response.GetResponseStream()
    if ($null -ne $responseStream) {
      $reader = [System.IO.StreamReader]::new($responseStream)
      $message = $reader.ReadToEnd()
      $reader.Dispose()
    }
  }
  if ([string]::IsNullOrWhiteSpace($message)) { $message = $_.Exception.Message }
  [Console]::Error.WriteLine($message)
  exit 1
}
