# Secure one-time credential capture for the DSH balance plugin.
# The password never leaves this dialog in plaintext: it is encrypted with DPAPI
# (CurrentUser scope) and written to ~/.dsh/easycompute-credentials.bin
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Security

$ErrorActionPreference = 'Stop'
$dshRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
[System.IO.Directory]::CreateDirectory($dshRoot) | Out-Null
$out = Join-Path $dshRoot 'easycompute-credentials.bin'

$form = New-Object System.Windows.Forms.Form
$form.Text = '清华算力凭据（仅本机加密保存）'
$form.Size = New-Object System.Drawing.Size(420, 230)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true
$form.MinimizeBox = $false

$labelUser = New-Object System.Windows.Forms.Label
$labelUser.Text = '账号（学号/工作证号）'
$labelUser.SetBounds(20, 18, 360, 20)
$form.Controls.Add($labelUser)

$textUser = New-Object System.Windows.Forms.TextBox
$textUser.SetBounds(20, 40, 370, 24)
$form.Controls.Add($textUser)

$labelPass = New-Object System.Windows.Forms.Label
$labelPass.Text = '密码'
$labelPass.SetBounds(20, 74, 360, 20)
$form.Controls.Add($labelPass)

$textPass = New-Object System.Windows.Forms.TextBox
$textPass.SetBounds(20, 96, 370, 24)
$textPass.UseSystemPasswordChar = $true
$form.Controls.Add($textPass)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = '使用 Windows DPAPI 加密，仅当前 Windows 账户可解密。'
$hint.SetBounds(20, 128, 370, 20)
$hint.ForeColor = [System.Drawing.Color]::Gray
$form.Controls.Add($hint)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = '保存'
$ok.SetBounds(220, 158, 80, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.SetBounds(310, 158, 80, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)

$form.AcceptButton = $ok
$form.CancelButton = $cancel

$dialog = $form.ShowDialog()
if ($dialog -ne [System.Windows.Forms.DialogResult]::OK) {
  Write-Output 'CANCELLED'
  exit 0
}

$user = $textUser.Text.Trim()
$pass = $textPass.Text
if ([string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrEmpty($pass)) {
  [System.Windows.Forms.MessageBox]::Show('账号或密码为空', '未保存') | Out-Null
  Write-Output 'EMPTY'
  exit 1
}

$json = @{ username = $user; password = $pass } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.IO.File]::WriteAllBytes($out, $protected)

# lock the file down to the current user
$acl = Get-Acl $out
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, 'FullControl', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl $out $acl

Write-Output ('SAVED ' + $out + ' (' + $protected.Length + ' bytes)')
$textPass.Clear()
