$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path $env:BRAIN_HUB_FOLDER_PICKER
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'skill-hub — выбор пути'
$owner.TopMost = $true
$owner.ShowInTaskbar = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.ClientSize = New-Object System.Drawing.Size(340, 70)
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$owner.MaximizeBox = $false
$owner.MinimizeBox = $false
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Выберите путь в системном окне.'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 24)
$owner.Controls.Add($label)
# The modal shell dialog has its own HWND; making only its owner TopMost is insufficient.
$visibilityTimer = New-Object System.Windows.Forms.Timer
$visibilityTimer.Interval = 150
$visibilityTimer.Add_Tick({
    if ([HubFolderPicker]::RevealDialog()) {
        $visibilityTimer.Stop()
        [Console]::WriteLine('{"ready":true}')
        [Console]::Out.Flush()
    }
})
$owner.Show()
$owner.Activate()
$visibilityTimer.Start()
try {
    if ($env:BRAIN_HUB_PICKER_KIND -eq 'file') {
        $picker = New-Object System.Windows.Forms.OpenFileDialog
        $picker.Title = 'Выберите SKILL.md'
        $picker.Filter = 'Скилл (SKILL.md)|SKILL.md'
        $picker.CheckFileExists = $true
        $picker.Multiselect = $false
        if ($env:BRAIN_HUB_PICKER_INITIAL -and (Test-Path -LiteralPath $env:BRAIN_HUB_PICKER_INITIAL -PathType Container)) {
            $picker.InitialDirectory = $env:BRAIN_HUB_PICKER_INITIAL
        }
        $result = $picker.ShowDialog($owner)
        $selected = $picker.FileName
    } else {
        $selected = [HubFolderPicker]::Select($owner.Handle, $env:BRAIN_HUB_PICKER_INITIAL, 'Выберите папку проекта или скилла')
        if ($null -eq $selected) { $result = [System.Windows.Forms.DialogResult]::Cancel }
        else { $result = [System.Windows.Forms.DialogResult]::OK }
    }
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        @{ path = $selected; cancelled = $false } | ConvertTo-Json -Compress
    } else {
        @{ path = $null; cancelled = $true } | ConvertTo-Json -Compress
    }
} finally {
    $visibilityTimer.Stop()
    $visibilityTimer.Dispose()
    if ($picker) { $picker.Dispose() }
    $owner.Close()
    $owner.Dispose()
}
