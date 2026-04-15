/**
 * accountPanelProvider.ts - 账号管理面板 WebView 提供者
 * 提供可视化的账号管理界面
 */

import * as vscode from 'vscode';
import { AccountManager, Account } from '../services/accountManager';
import { AccountSwitcher } from '../services/accountSwitcher';
import { ApiHelper } from '../services/apiHelper';

/**
 * 账号面板提供者
 */
export class AccountPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'windsurfSwitch.accountPanel';

  private _view?: vscode.WebviewView;
  private _accountManager: AccountManager;
  private _accountSwitcher: AccountSwitcher;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    accountManager: AccountManager,
    accountSwitcher: AccountSwitcher
  ) {
    this._accountManager = accountManager;
    this._accountSwitcher = accountSwitcher;
  }

  /**
   * 解析 WebView
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 处理来自 WebView 的消息
    webviewView.webview.onDidReceiveMessage(async (data: any) => {
      switch (data.type) {
        case 'getAccounts':
          await this._sendAccountList();
          break;

        case 'getCurrentAccount':
          await this._sendCurrentAccount();
          break;

        case 'switchAccount':
          await this._switchAccount(data.accountId);
          break;

        case 'addAccount':
          await this._addAccount(data.email, data.password);
          break;

        case 'deleteAccount':
          await this._deleteAccount(data.accountId);
          break;

        case 'copyApiKey':
          await this._copyApiKey(data.accountId);
          break;

        case 'copyCredentials':
          await this._copyCredentials(data.accountId);
          break;

        case 'updateRemark':
          await this._updateRemark(data.accountId, data.remark);
          break;
      }
    });

    // 初始加载数据
    this._sendAccountList();
    this._sendCurrentAccount();
  }

  /**
   * 刷新面板
   */
  public refresh() {
    if (this._view) {
      this._sendAccountList();
      this._sendCurrentAccount();
    }
  }

  /**
   * 发送账号列表到 WebView
   */
  private async _sendAccountList() {
    if (!this._view) return;

    const accounts = await this._accountManager.getAccounts();
    this._view.webview.postMessage({
      type: 'accountList',
      accounts: accounts.map(acc => ({
        id: acc.id,
        email: acc.email,
        name: acc.name,
        remark: acc.remark || '',
        planName: acc.planName,
        hasPassword: Boolean(acc.password)
      }))
    });
  }

  /**
   * 发送当前账号到 WebView
   */
  private async _sendCurrentAccount() {
    if (!this._view) return;

    const accounts = await this._accountManager.getAccounts();
    const current = await this._accountSwitcher.getCurrentAccount();
    let currentAccount: { email: string; name: string; remark: string } | null = null;

    if (current) {
      const matchedAccount = accounts.find(acc => acc.email === current.email);
      currentAccount = {
        email: current.email,
        name: current.name,
        remark: matchedAccount?.remark || ''
      };

      if (matchedAccount) {
        const matchedIndex = accounts.findIndex(acc => acc.id === matchedAccount.id);
        if (matchedIndex >= 0) {
          await this._accountManager.setCurrentAccountIndex(matchedIndex);
        }
      }
    } else if (accounts.length > 0) {
      const storedIndex = this._accountManager.getCurrentAccountIndex();
      const fallbackIndex = storedIndex >= 0 && storedIndex < accounts.length ? storedIndex : 0;
      const fallbackAccount = accounts[fallbackIndex];

      currentAccount = {
        email: fallbackAccount.email,
        name: fallbackAccount.name,
        remark: fallbackAccount.remark || ''
      };
    }

    this._view.webview.postMessage({
      type: 'currentAccount',
      account: currentAccount
    });
  }

  /**
   * 切换账号
   */
  private async _switchAccount(accountId: string) {
    const account = await this._accountManager.getAccount(accountId);
    if (!account) {
      this._sendMessage('error', '账号不存在');
      return;
    }

    const accounts = await this._accountManager.getAccounts();
    const accountIndex = accounts.findIndex(acc => acc.id === accountId);

    this._sendMessage('info', '正在切换账号...');

    try {
      const result = await this._accountSwitcher.switchAccount(account);

      if (accountIndex >= 0) {
        await this._accountManager.setCurrentAccountIndex(accountIndex);
        await this._sendCurrentAccount();
      }

      if (result.needsRestart) {
        this._sendMessage('info', '补丁已应用，正在重启 Windsurf...');
      } else if (result.success && result.method === 'injection') {
        this._sendMessage('success', '切换成功（补丁注入），窗口即将重载...');
      } else if (result.method === 'fallback') {
        this._sendMessage('error', `注入未成功，已尝试备用方案。请查看「Windsurf 换号」输出面板获取详细日志。`);
      } else {
        this._sendMessage('error', `切换失败: ${result.error || '未知错误'}`);
      }
    } catch (error) {
      const msg = (error as Error).message;
      this._sendMessage('error', `切换异常: ${msg}`);
      this._accountSwitcher.showLog();
    }
  }

  /**
   * 添加账号
   */
  private async _addAccount(email: string, password: string) {
    const parsed = this._parseAccountCredentials(email, password);

    if (parsed.invalidSegments.length > 0) {
      const preview = parsed.invalidSegments.slice(0, 3).join(' ; ');
      this._sendMessage('error', `以下条目格式无效（应为 邮箱,密码，用 ; 分隔）：${preview}${parsed.invalidSegments.length > 3 ? ' ...' : ''}`);
      if (parsed.pairs.length === 0) {
        return;
      }
    }

    if (parsed.isBatch) {
      const apiHelper = new ApiHelper();
      let successCount = 0;
      let failCount = 0;

      this._sendMessage('info', `开始批量验证并导入，共 ${parsed.pairs.length} 个账号...`);

      for (let i = 0; i < parsed.pairs.length; i++) {
        const pair = parsed.pairs[i];
        this._sendMessage('info', `(${i + 1}/${parsed.pairs.length}) 正在验证 ${pair.email}...`);

        const result = await apiHelper.login(pair.email, pair.password);
        if (result.success) {
          await this._accountManager.addAccount({
            email: result.email!,
            name: result.name!,
            apiKey: result.apiKey!,
            apiServerUrl: result.apiServerUrl!,
            refreshToken: result.refreshToken!,
            password: pair.password,
            planName: 'Pro'
          });
          successCount++;
          this._sendMessage('success', `账号 ${result.email} 添加成功！`);
        } else {
          failCount++;
          this._sendMessage('error', `账号 ${pair.email} 登录失败: ${result.error}`);
        }
      }

      await this._sendAccountList();
      this._sendMessage('success', `批量导入完成：成功 ${successCount}，失败 ${failCount}`);
      return;
    }

    this._sendMessage('info', '正在登录...');

    const apiHelper = new ApiHelper((msg) => {
      this._sendMessage('info', msg);
    });

    const result = await apiHelper.login(email, password);

    if (result.success) {
      await this._accountManager.addAccount({
        email: result.email!,
        name: result.name!,
        apiKey: result.apiKey!,
        apiServerUrl: result.apiServerUrl!,
        refreshToken: result.refreshToken!,
        password,
        planName: 'Pro'
      });

      this._sendMessage('success', `账号 ${result.email} 添加成功！`);
      await this._sendAccountList();
    } else {
      this._sendMessage('error', `登录失败: ${result.error}`);
    }
  }

  private _parseAccountCredentials(email: string, password: string): {
    isBatch: boolean;
    pairs: Array<{ email: string; password: string }>;
    invalidSegments: string[];
  } {
    const rawEmail = (email ?? '').trim().replace(/；/g, ';').replace(/，/g, ',');
    const rawPassword = password ?? '';

    const isBatch = rawEmail.includes(';') || (rawEmail.includes(',') && rawPassword.trim() === '');
    if (!isBatch) {
      return {
        isBatch: false,
        pairs: [{ email: rawEmail, password: rawPassword }],
        invalidSegments: []
      };
    }

    const segments = rawEmail
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);

    const pairs: Array<{ email: string; password: string }> = [];
    const invalidSegments: string[] = [];

    for (const seg of segments) {
      const commaIndex = seg.indexOf(',');
      if (commaIndex <= 0 || commaIndex === seg.length - 1) {
        invalidSegments.push(seg);
        continue;
      }

      const e = seg.slice(0, commaIndex).trim();
      const p = seg.slice(commaIndex + 1).trim();

      if (!e || !p) {
        invalidSegments.push(seg);
        continue;
      }

      pairs.push({ email: e, password: p });
    }

    return { isBatch: true, pairs, invalidSegments };
  }

  /**
   * 删除账号
   */
  private async _deleteAccount(accountId: string) {
    const account = await this._accountManager.getAccount(accountId);
    if (!account) {
      this._sendMessage('error', '账号不存在');
      return;
    }

    await this._accountManager.removeAccount(accountId);
    this._sendMessage('success', `账号 ${account.email} 已删除`);
    await this._sendAccountList();
  }

  /**
   * 复制 API Key
   */
  private async _copyApiKey(accountId: string) {
    const account = await this._accountManager.getAccount(accountId);
    if (!account) {
      this._sendMessage('error', '账号不存在');
      return;
    }

    await vscode.env.clipboard.writeText(account.apiKey);
    this._sendMessage('success', 'API Key 已复制');
  }

  /**
   * 复制账号密码
   */
  private async _copyCredentials(accountId: string) {
    const account = await this._accountManager.getAccount(accountId);
    if (!account) {
      this._sendMessage('error', '账号不存在');
      return;
    }

    if (!account.password) {
      this._sendMessage('error', '该账号未保存密码，无法复制');
      return;
    }

    await vscode.env.clipboard.writeText(`${account.email},${account.password}`);
    this._sendMessage('success', '账号密码已复制（邮箱,密码）');
  }

  /**
   * 更新备注名
   */
  private async _updateRemark(accountId: string, remark: string) {
    const account = await this._accountManager.getAccount(accountId);
    if (!account) {
      this._sendMessage('error', '账号不存在');
      return;
    }

    const normalizedRemark = (remark ?? '').trim();
    const updated = await this._accountManager.updateAccount(accountId, { remark: normalizedRemark });

    if (!updated) {
      this._sendMessage('error', '更新备注失败');
      return;
    }

    this._sendMessage('success', normalizedRemark ? `备注已更新：${normalizedRemark}` : '备注已清除');
    await this._sendAccountList();
  }

  /**
   * 发送消息到 WebView
   */
  private _sendMessage(msgType: 'info' | 'success' | 'error', text: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'message', msgType, text });
    }
  }

  /**
   * 生成 WebView HTML
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Windsurf 账号管理</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
    }
    
    .section {
      margin-bottom: 16px;
    }
    
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    
    .current-account {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    
    .current-account .email {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    
    .current-account .name {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .current-account .remark {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    
    .current-account .badge {
      display: inline-block;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      margin-top: 6px;
    }
    
    .no-account {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    
    .account-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    .account-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      background: var(--vscode-editor-background);
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .account-item:hover {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-hoverBackground);
    }
    
    .account-item.current {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground);
    }
    
    .account-item .info {
      flex: 1;
      min-width: 0;
    }
    
    .account-item .email {
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .account-item .name {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .account-item .remark {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .account-item .remark.empty {
      font-style: italic;
    }
    
    .account-item .actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    
    .account-item:hover .actions {
      opacity: 1;
    }
    
    .icon-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .icon-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 8px 12px;
      border: none;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .add-form {
      display: none;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }
    
    .add-form.show {
      display: flex;
    }
    
    .input {
      width: 100%;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 13px;
    }
    
    .input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    
    .form-actions {
      display: flex;
      gap: 8px;
    }
    
    .form-actions .btn {
      flex: 1;
    }
    
    .message {
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
      margin-bottom: 12px;
      display: none;
    }
    
    .message.show {
      display: block;
    }
    
    .message.info {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    
    .message.success {
      background: rgba(40, 167, 69, 0.2);
      border: 1px solid rgba(40, 167, 69, 0.5);
      color: #28a745;
    }
    
    .message.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }
    
    .empty-state {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .empty-state .icon {
      font-size: 32px;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div id="message" class="message"></div>
  
  <div class="section">
    <div class="section-title">当前账号</div>
    <div id="currentAccount" class="current-account">
      <div class="no-account">加载中...</div>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">添加账号</div>
    <div id="addForm" class="add-form">
      <input type="email" id="emailInput" class="input" placeholder="邮箱地址">
      <input type="password" id="passwordInput" class="input" placeholder="密码">
      <div class="form-actions">
        <button class="btn btn-primary" onclick="submitAdd()">登录添加</button>
        <button class="btn btn-secondary" onclick="cancelAdd()">取消</button>
      </div>
    </div>
    <button id="addBtn" class="btn btn-primary" onclick="showAddForm()">
      <span>+</span> 添加账号
    </button>
  </div>
  
  <div class="section">
    <div class="section-title">账号列表</div>
    <div id="accountList" class="account-list">
      <div class="empty-state">
        <div class="icon">📭</div>
        <div>暂无账号</div>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    let accounts = [];
    let currentEmail = null;

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
    
    // 请求数据
    vscode.postMessage({ type: 'getAccounts' });
    vscode.postMessage({ type: 'getCurrentAccount' });
    
    // 接收消息
    window.addEventListener('message', event => {
      const data = event.data;
      
      switch (data.type) {
        case 'accountList':
          accounts = data.accounts;
          renderAccountList();
          break;
          
        case 'currentAccount':
          currentEmail = data.account?.email;
          renderCurrentAccount(data.account);
          renderAccountList();
          break;
          
        case 'message':
          showMessage(data.msgType, data.text);
          break;
      }
    });
    
    function renderCurrentAccount(account) {
      const el = document.getElementById('currentAccount');
      if (account) {
        const remarkHtml = account.remark
          ? '<div class="remark">备注：' + escapeHtml(account.remark) + '</div>'
          : '';

        el.innerHTML =
          '<div class="email">' + escapeHtml(account.email) + '</div>' +
          '<div class="name">' + escapeHtml(account.name) + '</div>' +
          remarkHtml +
          '<div class="badge">当前使用</div>';
      } else {
        el.innerHTML = '<div class="no-account">未登录</div>';
      }
    }
    
    function renderAccountList() {
      const el = document.getElementById('accountList');
      
      if (accounts.length === 0) {
        el.innerHTML =
          '<div class="empty-state">' +
          '<div class="icon">📭</div>' +
          '<div>暂无账号，点击上方添加</div>' +
          '</div>';
        return;
      }
      
      el.innerHTML = accounts.map(acc => {
        const safeEmail = escapeHtml(acc.email);
        const safeName = escapeHtml(acc.name);
        const safePlanName = escapeHtml(acc.planName);
        const safeRemark = escapeHtml(acc.remark || '');
        const remarkClass = acc.remark ? 'remark' : 'remark empty';
        const remarkText = acc.remark ? '备注：' + safeRemark : '备注：未设置';
        const currentClass = acc.email === currentEmail ? 'current' : '';
        const copyTitle = acc.hasPassword ? '复制账号密码' : '该账号未保存密码';
        const disabledAttr = acc.hasPassword ? '' : 'disabled';

        return '<div class="account-item ' + currentClass + '" onclick="switchAccount(\'' + acc.id + '\')">' +
          '<div class="info">' +
          '<div class="email">' + safeEmail + '</div>' +
          '<div class="name">' + safeName + ' · ' + safePlanName + '</div>' +
          '<div class="' + remarkClass + '">' + remarkText + '</div>' +
          '</div>' +
          '<div class="actions">' +
          '<button class="icon-btn" onclick="event.stopPropagation(); editRemark(\'' + acc.id + '\')" title="编辑备注">🏷️</button>' +
          '<button class="icon-btn" onclick="event.stopPropagation(); copyCredentials(\'' + acc.id + '\')" title="' + copyTitle + '" ' + disabledAttr + '>🔐</button>' +
          '<button class="icon-btn" onclick="event.stopPropagation(); copyApiKey(\'' + acc.id + '\')" title="复制 API Key">📋</button>' +
          '<button class="icon-btn" onclick="event.stopPropagation(); deleteAccount(\'' + acc.id + '\')" title="删除">🗑️</button>' +
          '</div>' +
          '</div>';
      }).join('');
    }
    
    function showAddForm() {
      document.getElementById('addForm').classList.add('show');
      document.getElementById('addBtn').style.display = 'none';
      document.getElementById('emailInput').focus();
    }
    
    function cancelAdd() {
      document.getElementById('addForm').classList.remove('show');
      document.getElementById('addBtn').style.display = 'flex';
      document.getElementById('emailInput').value = '';
      document.getElementById('passwordInput').value = '';
    }
    
    function submitAdd() {
      const email = document.getElementById('emailInput').value.trim();
      const password = document.getElementById('passwordInput').value;
      const passwordTrimmed = (password || '').trim();
      const looksBatch = email.includes(';') || email.includes('；') || ((email.includes(',') || email.includes('，')) && !passwordTrimmed);
      
      if (!email) {
        showMessage('error', '请输入邮箱');
        return;
      }

      if (!looksBatch && !passwordTrimmed) {
        showMessage('error', '请输入邮箱和密码');
        return;
      }
      
      vscode.postMessage({ type: 'addAccount', email, password });
      cancelAdd();
    }
    
    function switchAccount(accountId) {
      const acc = accounts.find(a => a.id === accountId);
      if (acc && acc.email === currentEmail) {
        showMessage('info', '已经是当前账号');
        return;
      }
      vscode.postMessage({ type: 'switchAccount', accountId });
    }
    
    function copyApiKey(accountId) {
      vscode.postMessage({ type: 'copyApiKey', accountId });
    }

    function copyCredentials(accountId) {
      vscode.postMessage({ type: 'copyCredentials', accountId });
    }

    function editRemark(accountId) {
      const acc = accounts.find(a => a.id === accountId);
      if (!acc) {
        showMessage('error', '账号不存在');
        return;
      }

      const remark = window.prompt('请输入备注名（留空则清空）', acc.remark || '');
      if (remark === null) {
        return;
      }

      vscode.postMessage({ type: 'updateRemark', accountId, remark });
    }
    
    function deleteAccount(accountId) {
      vscode.postMessage({ type: 'deleteAccount', accountId });
    }
    
    function showMessage(type, text) {
      const el = document.getElementById('message');
      el.className = 'message show ' + type;
      el.textContent = text;
      
      if (type !== 'info') {
        setTimeout(() => {
          el.classList.remove('show');
        }, 3000);
      }
    }
    
    // 回车提交
    document.getElementById('passwordInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitAdd();
    });
  </script>
</body>
</html>`;
  }
}
