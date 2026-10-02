Add-Type -AssemblyName System.Speech
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'public\voice'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$voice = '__VOICE_NAME__'
$items = @(
__VOICE_ITEMS__
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
