const messages = {
  'chrome-profile-in-use': '旧版专用 Chrome 仍在运行。请完成登录后退出该专用 Chrome（Mac 上仅关闭窗口可能仍占用），再点「重新登录」。',
  'chrome-not-found': '未找到 Google Chrome，请先安装 Chrome 后重试。',
  'chrome-not-ready': '专用 Chrome 未能启动。请确认已关闭专用登录窗口，再重试。',
  'refresh-busy': '正在刷新，请稍候再试。',
  'credentials-missing': '尚未保存可用凭据。请点击「保存凭据」，或选择「重新登录」手动登录。',
  'captcha-required': '清华登录要求验证码，请点击「重新登录」并在专用窗口中手动完成。',
  'keychain-helper-unavailable': '凭据窗口启动失败，请检查 Xcode Command Line Tools 是否已安装。',
  'login-timeout': '登录未能完成，请点击「重新登录」检查账号和登录提示。',
  'login-window-closed': '登录窗口被关闭，登录未完成。请在专用窗口完成登录后点「立即刷新」。',
  'second-factor-required': '清华登录需要二次认证：请选择「企业微信」或「短信」接收验证码，填入后提交。',
  'no-second-factor': '当前没有等待二次认证的登录，请先点「立即刷新」。',
  'invalid-second-factor-method': '不支持的二次认证方式。',
  'second-factor-method-missing': '二次认证页面上没找到该选项，请改用「重新登录」在窗口中完成。',
  'second-factor-code-page-missing': '已提交认证方式，但没有出现验证码输入框。请稍后点「立即刷新」再试，或改用「重新登录」。',
  'invalid-second-factor-code': '验证码格式不正确（4–8 位数字）。',
  'second-factor-code-field-missing': '没找到验证码输入框，请改用「重新登录」在窗口中完成。',
  'second-factor-code-rejected': '验证码未通过或已过期，请重新获取后再试。',
  'untrusted-login-page': '登录页面地址不在允许范围内，已停止自动填充。请使用「重新登录」。',
};

export function errorMessage(code) {
  return messages[code] || '刷新暂未成功，请稍后重试；也可在专用 Chrome 窗口中重新登录。';
}
