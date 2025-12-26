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
        webviewView.webview.onDidReceiveMessage(async (data) => {
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
                planName: acc.planName
            }))
        });
    }

    /**
     * 发送当前账号到 WebView
     */
    private async _sendCurrentAccount() {
        if (!this._view) return;

        const current = await this._accountSwitcher.getCurrentAccount();
        this._view.webview.postMessage({
            type: 'currentAccount',
            account: current ? { email: current.email, name: current.name } : null
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

        this._sendMessage('info', '正在切换账号...');
        const result = await this._accountSwitcher.switchAccount(account);

        if (result.success) {
            this._sendMessage('success', '切换成功，窗口即将重载...');
        } else {
            this._sendMessage('error', `切换失败: ${result.error}`);
        }
    }

    /**
     * 添加账号
     */
    private async _addAccount(email: string, password: string) {
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
                planName: 'Pro'
            });

            this._sendMessage('success', `账号 ${result.email} 添加成功！`);
            await this._sendAccountList();
        } else {
            this._sendMessage('error', `登录失败: ${result.error}`);
        }
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
        el.innerHTML = \`
          <div class="email">\${account.email}</div>
          <div class="name">\${account.name}</div>
          <div class="badge">当前使用</div>
        \`;
      } else {
        el.innerHTML = '<div class="no-account">未登录</div>';
      }
    }
    
    function renderAccountList() {
      const el = document.getElementById('accountList');
      
      if (accounts.length === 0) {
        el.innerHTML = \`
          <div class="empty-state">
            <div class="icon">📭</div>
            <div>暂无账号，点击上方添加</div>
          </div>
        \`;
        return;
      }
      
      el.innerHTML = accounts.map(acc => \`
        <div class="account-item \${acc.email === currentEmail ? 'current' : ''}" 
             onclick="switchAccount('\${acc.id}')">
          <div class="info">
            <div class="email">\${acc.email}</div>
            <div class="name">\${acc.name} · \${acc.planName}</div>
          </div>
          <div class="actions">
            <button class="icon-btn" onclick="event.stopPropagation(); copyApiKey('\${acc.id}')" title="复制 API Key">📋</button>
            <button class="icon-btn" onclick="event.stopPropagation(); deleteAccount('\${acc.id}')" title="删除">🗑️</button>
          </div>
        </div>
      \`).join('');
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
      
      if (!email || !password) {
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
