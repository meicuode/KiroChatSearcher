# 生成市场图标 media/icon-128.png（256×256，vsce 要求至少 128×128）。
#
# 为什么用脚本画而不是直接放一张图：图标是**提交进仓库的二进制产物**，
# 没有生成方式的话，日后想改个颜色或描边粗细就只能重新找工具、凭眼睛对齐。
# 这个脚本只依赖 Windows 自带的 GDI+，不引入任何构建期依赖。
#
# 构型与 media/icon.svg（活动栏那个单色图标）保持一致：放大镜 + 镜片里两行对话文字。
# 活动栏图标必须单色（VSCode 会重新着色），所以那份留作 SVG；这份是市场用的彩色版。
#
# 用法： pwsh -NoProfile -File scripts/generate-icon.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$out = Join-Path $PSScriptRoot '..\media\icon-128.png'

# icon.svg 的 viewBox 是 0 0 24 24；把它映射到画布中间，四周留白
$vb = 24.0
$scale = $size / $vb * 0.72
$offset = ($size - $vb * $scale) / 2.0
function X([double]$v) { $offset + $v * $scale }

$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

# 背景：圆角方块 + 紫色渐变（取 Kiro 对话面板发送按钮那个紫）
$radius = [int]($size * 0.2)
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$bg.AddArc(0, 0, $d, $d, 180, 90)
$bg.AddArc($size - $d, 0, $d, $d, 270, 90)
$bg.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$bg.AddArc(0, $size - $d, $d, $d, 90, 90)
$bg.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.ColorTranslator]::FromHtml('#8B6CFF'),
  [System.Drawing.ColorTranslator]::FromHtml('#5B3FD6')
)
$g.FillPath($brush, $bg)

# 前景：白色描边，圆头圆角，粗细沿用 svg 的 stroke-width 1.7
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float](1.7 * $scale))
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

# <circle cx="10.5" cy="10.5" r="6.5"/>
$r = 6.5 * $scale
$g.DrawEllipse($pen, [float]((X 10.5) - $r), [float]((X 10.5) - $r), [float]($r * 2), [float]($r * 2))
# <path d="M20 20l-4.35-4.35"/>  放大镜手柄
$g.DrawLine($pen, [float](X 20), [float](X 20), [float](X 15.65), [float](X 15.65))
# 镜片里的两行「对话」
$g.DrawLine($pen, [float](X 7.5), [float](X 10.5), [float](X 13.5), [float](X 10.5))
$g.DrawLine($pen, [float](X 7.5), [float](X 8), [float](X 11.5), [float](X 8))

$g.Dispose()
$resolved = [System.IO.Path]::GetFullPath($out)
$bmp.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$pen.Dispose(); $brush.Dispose(); $bg.Dispose()

$info = Get-Item $resolved
Write-Output ("已生成 " + $resolved + "  " + $size + "x" + $size + "  " + [math]::Round($info.Length / 1KB, 1) + "KB")
