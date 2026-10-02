Add-Type -AssemblyName System.Speech
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'public\voice'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$voice = 'Microsoft Huihui Desktop'
$items = @(
  @{ file = '01-idea.wav'; text = '从一个想法开始' },
  @{ file = '02-agent.wav'; text = 'Agent 理解代码库，帮你完成工作' },
  @{ file = '03-edit.wav'; text = '快速编辑，清晰审查，每一次迭代都在你掌控中' },
  @{ file = '04-preview.wav'; text = '即时预览，让想法变成看得见的结果' },
  @{ file = '05-end.wav'; text = 'Cursor，让你专注于创造。' }
)
foreach ($item in $items) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voice)
  $synth.Rate = 0
  $synth.Volume = 100
  $path = Join-Path $out $item.file
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($item.text)
  $synth.Dispose()
  Write-Output ("generated " + $path)
}
