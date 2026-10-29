# AutoVideo icon generator (Windows PowerShell, ASCII-only source)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-Icon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  # rounded-rect background with red->orange gradient
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 255, 77, 48),
    [System.Drawing.Color]::FromArgb(255, 255, 158, 0),
    45.0)
  $radius = [float]($size * 0.22)
  $d = $radius * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $g.FillPath($grad, $p)

  # white play triangle, slightly right of center
  $w = [double]($size * 0.34)
  $h = [double]($size * 0.40)
  $cx = [double]($size * 0.54)
  $cy = [double]($size * 0.50)
  $hw = [double]($w / 2.0)
  $hh = [double]($h / 2.0)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $pt1 = New-Object System.Drawing.PointF([float]($cx - $hw), [float]($cy - $hh))
  $pt2 = New-Object System.Drawing.PointF([float]($cx - $hw), [float]($cy + $hh))
  $pt3 = New-Object System.Drawing.PointF([float]($cx + $hw), [float]$cy)
  $pts = [System.Drawing.PointF[]]@($pt1, $pt2, $pt3)
  $g.FillPolygon($white, $pts)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $grad.Dispose(); $white.Dispose(); $p.Dispose(); $bmp.Dispose()
  Write-Host ("generated " + $path)
}

foreach ($s in 16, 32, 48, 128) {
  New-Icon $s (Join-Path $out ("icon" + $s + ".png"))
}
