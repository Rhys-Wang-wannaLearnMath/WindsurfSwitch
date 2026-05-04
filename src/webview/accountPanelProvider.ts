/**
 * accountPanelProvider.ts - 账号管理面板 WebView 提供者
 * 提供可视化的账号管理界面
 */

import * as vscode from 'vscode';
import { AccountManager, Account } from '../services/accountManager';
import { AccountSwitcher, DetectedOnlineAccount } from '../services/accountSwitcher';
import { ApiHelper } from '../services/apiHelper';
import { authenticateViaWebview } from '../services/firebaseWebviewAuth';
import { BrowserAutomationMode, OfficialBrowserAutomation } from '../services/officialBrowserAutomation';

type OfficialImportOptions = {
  mode?: BrowserAutomationMode;
  restorePreviousSelection?: boolean;
  batchIndex?: number;
  batchTotal?: number;
};

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

        case 'autoOfficialImport':
          await this._autoOfficialImport(data.email, data.password, { mode: this._normalizeOfficialImportMode(data.mode) });
          break;

        case 'batchAutoOfficialImport':
          await this._batchAutoOfficialImport(data.accountsText, { mode: this._normalizeOfficialImportMode(data.mode) });
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

        case 'editCodex':
          await this._editCodex(data.accountId, data.currentCodex);
          break;

        case 'importCurrentOnlineAccount':
          await this._importCurrentOnlineAccount();
          break;

        case 'clearCurrentAuthData':
          await this._clearCurrentAuthData();
          break;

        case 'openOfficialWindsurfLoginPage':
          await this._openOfficialWindsurfLoginPage();
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
        codex: acc.codex || '',
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

    const currentId = this._accountManager.getCurrentAccountId();
    let account: Account | undefined;
    if (currentId) {
      account = await this._accountManager.getAccount(currentId);
    }
    this._view.webview.postMessage({
      type: 'currentAccount',
      account: account ? { email: account.email, name: account.name, codex: account.codex || '' } : null
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

    try {
      const result = await this._accountSwitcher.switchAccount(account);

      if (result.needsRestart) {
        this._sendMessage('info', '补丁已应用，正在重启 Windsurf...');
      } else if (result.success && result.method === 'injection') {
        await this._accountManager.setCurrentAccountId(accountId);
        await this._sendCurrentAccount();
        this._sendMessage('success', '切换成功（补丁注入），窗口即将重载...');
      } else if (result.method === 'fallback') {
        await this._accountManager.setCurrentAccountId(accountId);
        await this._sendCurrentAccount();
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

        const result = await this._loginWithAppCheck(apiHelper, pair.email, pair.password);
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
    const pair = parsed.pairs[0];

    const apiHelper = new ApiHelper((msg) => {
      this._sendMessage('info', msg);
    });

    const result = await this._loginWithAppCheck(apiHelper, pair.email, pair.password);

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

      this._sendMessage('success', `账号 ${result.email} 添加成功！`);
      await this._sendAccountList();
    } else {
      this._sendMessage('error', `登录失败: ${result.error}`);
    }
  }

  private async _loginWithAppCheck(apiHelper: ApiHelper, email: string, password: string) {
    try {
      this._sendMessage('info', '正在通过 App Check 验证...');
      const firebaseTokens = await authenticateViaWebview(email, password, (message) => {
        this._sendMessage('info', message);
      });
      return await apiHelper.loginWithFirebaseTokens(email, firebaseTokens);
    } catch (error) {
      const message = (error as Error).message || String(error);
      return { success: false, error: `${message}。如果不想走浏览器验证，请先在 Windsurf 手动登录该账号，再使用「识别并导入当前在线账号」。` };
    }
  }

  private _parseAccountCredentials(email: string, password: string): {
    isBatch: boolean;
    pairs: Array<{ email: string; password: string }>;
    invalidSegments: string[];
  } {
    const rawEmail = (email ?? '').trim().replace(/\r?\n/g, ';').replace(/；/g, ';').replace(/，/g, ',');
    const rawPassword = password ?? '';

    const isBatch = rawEmail.includes(';') || (rawEmail.includes(',') && rawPassword.trim() === '');
    if (!isBatch) {
      return {
        isBatch: false,
        pairs: [{ email: rawEmail, password: rawPassword.trim() }],
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
   * 编辑备注名
   */
  private async _editCodex(accountId: string, currentCodex: string) {
    const codex = await vscode.window.showInputBox({
      prompt: '输入备注名（留空清除）',
      value: currentCodex || '',
      placeHolder: '例如：工作号、测试号'
    });
    if (codex === undefined) return;
    const updated = await this._accountManager.updateAccount(accountId, { codex: codex.trim() });
    if (updated) {
      await this._sendAccountList();
      await this._sendCurrentAccount();
      this._sendMessage('success', '备注已更新');
    } else {
      this._sendMessage('error', '账号不存在');
    }
  }

  /**
   * 识别当前在线账号并导入
   */
  private async _importCurrentOnlineAccount() {
    this._sendMessage('info', '正在识别当前在线账号...');

    const detected = await this._accountSwitcher.detectCurrentOnlineAccount();
    if (!detected) {
      this._sendMessage('error', '未检测到可导入的在线账号（请先在 Windsurf 中手动登录一次）');
      return;
    }

    await this._upsertDetectedOnlineAccount(detected);
    await this._sendAccountList();
  }

  private async _upsertDetectedOnlineAccount(detected: DetectedOnlineAccount, password?: string, options: { setAsCurrent?: boolean } = {}) {
    const setAsCurrent = options.setAsCurrent !== false;
    const accounts = await this._accountManager.getAccounts();
    const existing = accounts.find(acc => acc.email.toLowerCase() === detected.email.toLowerCase());

    if (existing) {
      const updates: Partial<Account> = {
        name: detected.name,
        apiKey: detected.apiKey,
        apiServerUrl: detected.apiServerUrl,
        planName: detected.planName
      };
      if (password !== undefined) {
        updates.password = password;
      }
      const updated = await this._accountManager.updateAccount(existing.id, updates);
      if (setAsCurrent) {
        await this._accountManager.setCurrentAccountId(updated?.id || existing.id);
        await this._sendCurrentAccount();
      }
      this._sendMessage('success', `已更新已存在账号：${detected.email}`);
    } else {
      const added = await this._accountManager.addAccount({
        email: detected.email,
        name: detected.name,
        apiKey: detected.apiKey,
        apiServerUrl: detected.apiServerUrl,
        refreshToken: '',
        password: password || '',
        planName: detected.planName
      });
      if (setAsCurrent) {
        await this._accountManager.setCurrentAccountId(added.id);
        await this._sendCurrentAccount();
      }
      this._sendMessage('success', `已导入当前在线账号：${detected.email}`);
    }
  }

  private _normalizeOfficialImportMode(value: unknown): BrowserAutomationMode {
    return value === 'slow' ? 'slow' : 'fast';
  }

  private async _batchAutoOfficialImport(accountsText: string, options: OfficialImportOptions = {}) {
    const parsed = this._parseAccountCredentials(accountsText || '', '');

    if (parsed.invalidSegments.length > 0) {
      const preview = parsed.invalidSegments.slice(0, 3).join(' ; ');
      this._sendMessage('error', `以下官方导入条目格式无效（应为 邮箱,密码，每行或分号分隔）：${preview}${parsed.invalidSegments.length > 3 ? ' ...' : ''}`);
      if (parsed.pairs.length === 0) {
        return;
      }
    }

    if (parsed.pairs.length === 0) {
      this._sendMessage('error', '请输入至少一个账号，格式为：邮箱,密码');
      return;
    }

    const selectedAccountIdBeforeBatch = this._accountManager.getCurrentAccountId();
    let successCount = 0;
    let failCount = 0;

    this._sendMessage('info', `开始批量官方导入，共 ${parsed.pairs.length} 个账号，模式：${options.mode === 'slow' ? '慢速' : '快速'}。`);

    for (let i = 0; i < parsed.pairs.length; i++) {
      const pair = parsed.pairs[i];
      this._sendMessage('info', `(${i + 1}/${parsed.pairs.length}) 正在官方导入 ${pair.email}...`);
      const ok = await this._autoOfficialImport(pair.email, pair.password, {
        mode: options.mode,
        restorePreviousSelection: false,
        batchIndex: i + 1,
        batchTotal: parsed.pairs.length
      });
      if (ok) {
        successCount++;
      } else {
        failCount++;
      }
      await this._delay(options.mode === 'slow' ? 3000 : 1000);
    }

    await this._sendAccountList();
    if (selectedAccountIdBeforeBatch) {
      const selected = await this._accountManager.getAccount(selectedAccountIdBeforeBatch);
      if (selected) {
        await this._accountManager.setCurrentAccountId(selectedAccountIdBeforeBatch);
        await this._sendCurrentAccount();
      }
    }
    this._sendMessage(failCount === 0 ? 'success' : 'info', `批量官方导入完成：成功 ${successCount}，失败 ${failCount}`);
  }

  private async _autoOfficialImport(email: string, password: string, options: OfficialImportOptions = {}): Promise<boolean> {
    const targetEmail = (email || '').trim();
    const targetPassword = password || '';
    const mode = options.mode === 'slow' ? 'slow' : 'fast';
    const prefix = options.batchIndex && options.batchTotal ? `(${options.batchIndex}/${options.batchTotal}) ` : '';

    if (!targetEmail || !targetPassword.trim()) {
      this._sendMessage('error', '请输入账号和密码');
      return false;
    }

    const selectedAccountIdBeforeImport = this._accountManager.getCurrentAccountId();

    try {
      await vscode.env.clipboard.writeText(`${targetEmail}\n${targetPassword}`);
      this._sendMessage('info', '账号密码已复制到剪贴板（第一行为邮箱，第二行为密码）。');
    } catch {
      this._sendMessage('info', '账号密码未能复制到剪贴板，请手动输入。');
    }

    this._sendMessage('info', `${prefix}正在先退出并清理 IDE 当前旧账号认证...`);
    const clearResult = await this._accountSwitcher.clearCurrentAuthData();
    if (!clearResult.success) {
      this._sendMessage('error', `清理旧账号认证失败: ${clearResult.error || '未知错误'}`);
      return false;
    }
    this._sendMessage('success', `旧账号 IDE 认证已清理，共处理 ${clearResult.deletedKeyCount} 项。`);

    this._sendMessage('info', `${prefix}开始一键官方导入（${mode === 'slow' ? '慢速' : '快速'}模式）：正在以来宾 Edge 登录目标账号，并自动确认 IDE 官方授权跳转...`);
    const browserResult = await OfficialBrowserAutomation.login(targetEmail, targetPassword, (message) => {
      this._sendMessage('info', message);
    }, { mode });
    this._sendMessage(browserResult.success ? 'success' : 'info', browserResult.message);
    if (browserResult.error) {
      this._sendMessage('info', `浏览器自动化详情: ${browserResult.error}`);
    }
    void OfficialBrowserAutomation.autoConfirmIdeAccountSwitch((message) => {
      this._sendMessage('info', message);
    }, 60000).catch((error) => {
      this._sendMessage('info', `IDE 切换账号确认自动处理失败: ${(error as Error).message}`);
    });

    if (selectedAccountIdBeforeImport) {
      const selected = await this._accountManager.getAccount(selectedAccountIdBeforeImport);
      if (selected && options.restorePreviousSelection !== false) {
        await this._accountManager.setCurrentAccountId(selectedAccountIdBeforeImport);
        await this._sendCurrentAccount();
      }
    }

    let imported = false;
    this._sendMessage('info', '正在等待 IDE 官方授权回调完成，并只导入目标账号...');
    imported = await this._waitForOnlineAccountAndImport(targetEmail, targetPassword, mode === 'slow' ? 240000 : 90000, false, true, mode);

    if (!imported) {
      if (selectedAccountIdBeforeImport && options.restorePreviousSelection !== false) {
        await this._restoreSelectedAccountSession(selectedAccountIdBeforeImport);
      }
      this._sendMessage('error', '自动导入未成功，已尽量保持/恢复原 IDE 会话。');
      return false;
    }

    await this._sendAccountList();
    if (selectedAccountIdBeforeImport) {
      const selected = await this._accountManager.getAccount(selectedAccountIdBeforeImport);
      if (selected && options.restorePreviousSelection !== false) {
        await this._accountManager.setCurrentAccountId(selectedAccountIdBeforeImport);
        await this._sendCurrentAccount();
      }
    }
    return true;
  }

  private _isFallbackImportedEmail(email: string): boolean {
    return email.toLowerCase().endsWith('.imported@windsurf.local');
  }

  private _withTargetEmail(detected: DetectedOnlineAccount, targetEmail: string): DetectedOnlineAccount {
    return {
      ...detected,
      email: targetEmail,
      name: this._isFallbackImportedEmail(detected.email) ? targetEmail : detected.name
    };
  }

  private async _importAndInjectViaAppCheck(targetEmail: string, password: string, setAsCurrent: boolean): Promise<{ imported: boolean; injected: boolean }> {
    this._sendMessage('info', '浏览器授权 Token 不可用，正在尝试 App Check 兜底登录...');
    const apiHelper = new ApiHelper((message) => {
      this._sendMessage('info', message);
    });
    const result = await this._loginWithAppCheck(apiHelper, targetEmail, password);
    if (!result.success || !result.apiKey) {
      this._sendMessage('info', `App Check 兜底登录失败: ${result.error || '未知错误'}`);
      return { imported: false, injected: false };
    }

    const detected: DetectedOnlineAccount = {
      email: result.email || targetEmail,
      name: result.name || targetEmail,
      apiKey: result.apiKey,
      apiServerUrl: result.apiServerUrl || 'https://server.self-serve.windsurf.com',
      planName: 'Pro'
    };
    await this._upsertDetectedOnlineAccount(detected, password, { setAsCurrent });
    const injected = await this._provideViaPatchedApiKeyCommand(detected);
    return { imported: true, injected };
  }

  private async _restoreSelectedAccountSession(accountId: string): Promise<void> {
    const selected = await this._accountManager.getAccount(accountId);
    if (!selected || !selected.apiKey) {
      return;
    }

    this._sendMessage('info', '目标账号自动注入未确认成功，正在恢复导入前选中账号的 IDE 会话...');
    const result = await this._accountSwitcher.switchAccount(selected);
    if (result.success) {
      await this._accountManager.setCurrentAccountId(accountId);
      await this._sendCurrentAccount();
      this._sendMessage('success', '已恢复导入前选中账号的 IDE 会话。');
    } else {
      this._sendMessage('info', `恢复导入前账号失败: ${result.error || '未知错误'}`);
    }
  }

  private async _importAndInjectOfficialAuthToken(authToken: string, targetEmail: string, password: string, setAsCurrent: boolean): Promise<{ imported: boolean; injected: boolean }> {
    let detected: DetectedOnlineAccount | undefined;

    try {
      const apiHelper = new ApiHelper((message) => {
        this._sendMessage('info', message);
      });
      const apiKeyResult = await apiHelper.getApiKey(authToken);
      detected = {
        email: targetEmail,
        name: apiKeyResult.name || targetEmail,
        apiKey: apiKeyResult.apiKey,
        apiServerUrl: apiKeyResult.apiServerUrl,
        planName: 'Pro'
      };
      await this._upsertDetectedOnlineAccount(detected, password, { setAsCurrent });
    } catch (error) {
      this._sendMessage('info', `授权 Token 换取 API Key 失败，将改用在线账号检测：${(error as Error).message}`);
    }

    const injected = await this._provideOfficialAuthToken(authToken, detected);
    return {
      imported: Boolean(detected),
      injected
    };
  }

  private async _provideOfficialAuthToken(authToken: string, detected?: DetectedOnlineAccount): Promise<boolean> {
    const candidates = [
      'windsurf.provideAuthTokenToAuthProvider',
      'codeium.provideAuthTokenToAuthProvider'
    ];

    try {
      const commands = await vscode.commands.getCommands(true);
      const command = candidates.find(candidate => commands.includes(candidate))
        || commands.find(candidate => candidate.toLowerCase().endsWith('provideauthtokentoauthprovider') && !candidate.toLowerCase().includes('withshit'));

      if (!command) {
        this._sendMessage('info', '未找到可直接注入官方授权 Token 的 Windsurf 命令。');
        return await this._provideViaPatchedApiKeyCommand(detected);
      }

      this._sendMessage('info', `正在注入官方授权 Token: ${command}`);
      const result = await vscode.commands.executeCommand(command, authToken) as any;
      if (result?.error) {
        this._sendMessage('info', `官方授权 Token 注入返回错误: ${JSON.stringify(result.error)}`);
        return await this._provideViaPatchedApiKeyCommand(detected);
      }

      this._sendMessage('success', '官方授权 Token 已自动注入 IDE。');
      await this._delay(3000);
      return true;
    } catch (error) {
      this._sendMessage('info', `官方授权 Token 自动注入失败: ${(error as Error).message}`);
      return await this._provideViaPatchedApiKeyCommand(detected);
    }
  }

  private async _provideViaPatchedApiKeyCommand(detected?: DetectedOnlineAccount): Promise<boolean> {
    if (!detected) {
      return false;
    }

    try {
      const commands = await vscode.commands.getCommands(true);
      const command = commands.includes('windsurf.provideAuthTokenToAuthProviderWithShit')
        ? 'windsurf.provideAuthTokenToAuthProviderWithShit'
        : undefined;
      if (!command) {
        return false;
      }

      this._sendMessage('info', '正在通过补丁命令注入 API Key 会话...');
      await vscode.commands.executeCommand(command, {
        apiKey: detected.apiKey,
        name: detected.email,
        apiServerUrl: detected.apiServerUrl || 'https://server.self-serve.windsurf.com'
      });
      this._sendMessage('success', 'API Key 会话已通过补丁命令注入 IDE。');
      await this._delay(3000);
      return true;
    } catch (error) {
      this._sendMessage('info', `补丁命令注入 API Key 失败: ${(error as Error).message}`);
      return false;
    }
  }

  private async _tryTriggerOfficialWindsurfLogin() {
    const candidates = [
      'windsurf.login',
      'windsurf.signIn',
      'windsurf.signin',
      'windsurf.authenticate',
      'windsurf.openLogin',
      'windsurf.loginWithBrowser',
      'codeium.login',
      'codeium.signIn',
      'codeium.signin',
      'codeium.authenticate',
      'codeium.loginWithBrowser'
    ];

    try {
      const commands = await vscode.commands.getCommands(true);
      const command = candidates.find(candidate => commands.includes(candidate));
      if (!command) {
        this._sendMessage('info', '未找到可自动触发的官方登录命令；请使用 IDE 里的 Windsurf 官方登录入口。');
        return;
      }

      this._sendMessage('info', `正在触发官方登录入口: ${command}`);
      await vscode.commands.executeCommand(command);
    } catch (error) {
      this._sendMessage('info', `自动触发官方登录入口失败，请手动点击 IDE 的 Windsurf 官方登录入口：${(error as Error).message}`);
    }
  }

  private async _waitForOnlineAccountAndImport(targetEmail: string, password: string, timeoutMs: number, setAsCurrent = true, requireTargetEmail = false, mode: BrowserAutomationMode = 'fast'): Promise<boolean> {
    const startedAt = Date.now();
    let attempt = 0;
    const fastPollMs = mode === 'slow' ? 3000 : 800;
    const slowPollMs = mode === 'slow' ? 3000 : 2000;

    while (Date.now() - startedAt < timeoutMs) {
      attempt++;
      const elapsed = Date.now() - startedAt;
      const pollMs = elapsed < 30000 ? fastPollMs : slowPollMs;
      const detected = await this._accountSwitcher.detectCurrentOnlineAccount();
      if (detected) {
        if (detected.email.toLowerCase() !== targetEmail.toLowerCase()) {
          if (requireTargetEmail && this._isFallbackImportedEmail(detected.email)) {
            this._sendMessage('info', `检测到占位在线账号 ${detected.email}，将使用输入邮箱 ${targetEmail} 导入。`);
            await this._upsertDetectedOnlineAccount(this._withTargetEmail(detected, targetEmail), password, { setAsCurrent });
            return true;
          }
          if (requireTargetEmail) {
            if (attempt % 5 === 1) {
              this._sendMessage('info', `检测到旧/非目标在线账号 ${detected.email}，继续等待目标账号 ${targetEmail} 授权回调...`);
            }
            await this._delay(pollMs);
            continue;
          }
          this._sendMessage('info', `检测到在线账号 ${detected.email}，与输入账号 ${targetEmail} 不完全一致，仍将按当前 IDE 在线账号导入。`);
        }
        await this._upsertDetectedOnlineAccount(detected, password, { setAsCurrent });
        return true;
      }

      if (attempt % 5 === 0) {
        this._sendMessage('info', '仍在等待 IDE 官方登录完成...');
      }
      await this._delay(pollMs);
    }

    this._sendMessage('error', '等待官方登录超时。请确认 IDE 已通过 Windsurf 官方入口登录成功，然后点击“识别并导入当前在线账号”。');
    return false;
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 退出并清理当前认证数据
   */
  private async _clearCurrentAuthData() {
    const confirmed = await vscode.window.showWarningMessage(
      '将退出 Windsurf 当前账号并清理本地认证缓存，是否继续？',
      { modal: true },
      '确认清理'
    );

    if (confirmed !== '确认清理') {
      this._sendMessage('info', '已取消清理操作');
      return;
    }

    this._sendMessage('info', '正在退出并清理认证...');
    const result = await this._accountSwitcher.clearCurrentAuthData();

    if (!result.success) {
      this._sendMessage('error', `清理失败: ${result.error || '未知错误'}`);
      return;
    }

    await this._accountManager.setCurrentAccountId(undefined);
    await this._sendCurrentAccount();
    this._sendMessage('success', `已退出并清理认证，共清理 ${result.deletedKeyCount} 项`);
  }

  private async _openOfficialWindsurfLoginPage(copyUrl = true) {
    const url = 'https://windsurf.com/account/login';
    await vscode.env.openExternal(vscode.Uri.parse(url));
    if (copyUrl) {
      try {
        await vscode.env.clipboard.writeText(url);
      } catch {
      }
    }
    this._sendMessage('info', '已打开 Windsurf 官网登录页。请在浏览器退出当前账号并登录目标账号，然后回到 IDE 使用官方入口登录。');
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

    .collapsible-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }

    .collapse-icon {
      transition: transform 0.15s;
    }

    .collapsible-title.collapsed .collapse-icon {
      transform: rotate(-90deg);
    }

    .collapsible-body.collapsed {
      display: none;
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

    .textarea {
      min-height: 90px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family);
      line-height: 1.4;
    }

    .mode-row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin: 2px 0 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .mode-row label {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    
    .form-actions {
      display: flex;
      gap: 8px;
    }
    
    .form-actions .btn {
      flex: 1;
    }

    .flow-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
    }

    .flow-title {
      font-weight: 600;
      margin-bottom: 8px;
    }

    .flow-step {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.45;
      margin-bottom: 6px;
    }

    .flow-step .num {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      font-weight: 600;
    }

    .flow-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.45;
      margin-top: 8px;
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
    <div id="importMethodsTitle" class="section-title collapsible-title collapsed" onclick="toggleImportMethods()">
      <span>推荐添加方式</span>
      <span class="collapse-icon">⌄</span>
    </div>
    <div id="importMethodsBody" class="collapsible-body collapsed">
    <div class="flow-card">
      <div class="flow-title">一键官方导入</div>
      <input type="email" id="officialEmailInput" class="input" placeholder="邮箱地址" style="margin-bottom:8px;">
      <input type="password" id="officialPasswordInput" class="input" placeholder="密码" style="margin-bottom:8px;">
      <div class="mode-row">
        <label><input type="radio" name="officialImportMode" value="fast" checked>快速</label>
        <label><input type="radio" name="officialImportMode" value="slow">慢速</label>
      </div>
      <button class="btn btn-primary" onclick="submitAutoOfficialImport()">开始一键官方导入</button>
      <div class="flow-hint">快速模式会尽量提前进入下一步；慢速模式适合网络差或机器卡顿。插件会先退出并清理 IDE 当前旧账号认证，再以来宾 Edge 登录目标账号，打开官方 IDE 授权跳转，并自动点击/绕过 Edge 的“打开 Windsurf”确认弹窗；失败时会尽量恢复原会话。</div>
    </div>
    <div class="flow-card">
      <div class="flow-title">批量官方导入</div>
      <textarea id="batchOfficialInput" class="input textarea" placeholder="每行一个：邮箱,密码&#10;也支持用分号分隔：a@example.com,pwd;b@example.com,pwd"></textarea>
      <div class="mode-row">
        <label><input type="radio" name="batchOfficialImportMode" value="fast" checked>快速</label>
        <label><input type="radio" name="batchOfficialImportMode" value="slow">慢速</label>
      </div>
      <button class="btn btn-primary" onclick="submitBatchAutoOfficialImport()">开始批量官方导入</button>
      <div class="flow-hint">批量模式会串行导入，避免多个 Edge 窗口或 IDE 授权回调互相干扰。</div>
    </div>
    <div class="flow-card">
      <div class="flow-title">手动官方导入备用流程</div>
      <div class="flow-step"><span class="num">1</span><span>在浏览器打开官网，退出当前账号并用目标账号密码登录。</span></div>
      <div class="flow-step"><span class="num">2</span><span>在本插件中清理当前 IDE 认证缓存。</span></div>
      <div class="flow-step"><span class="num">3</span><span>使用 IDE 的 Windsurf 官方登录入口完成登录。</span></div>
      <div class="flow-step"><span class="num">4</span><span>点击“识别并导入当前在线账号”。</span></div>
      <div class="flow-hint">如果一键流程没有找到 IDE 官方登录命令，请使用这个备用流程。</div>
    </div>
    <div class="form-actions" style="margin-bottom:8px;">
      <button class="btn btn-secondary" onclick="openOfficialWindsurfLoginPage()">打开官网登录页</button>
    </div>
    <div class="form-actions" style="margin-bottom:8px;">
      <button class="btn btn-secondary" onclick="clearCurrentAuthData()">退出并清理当前认证</button>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" onclick="importCurrentOnlineAccount()">识别并导入当前在线账号</button>
    </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">实验添加方式</div>
    <div id="addForm" class="add-form">
      <input type="email" id="emailInput" class="input" placeholder="邮箱地址">
      <input type="password" id="passwordInput" class="input" placeholder="密码">
      <div class="form-actions">
        <button class="btn btn-primary" onclick="submitAdd()">邮箱密码添加</button>
        <button class="btn btn-secondary" onclick="cancelAdd()">取消</button>
      </div>
    </div>
    <button id="addBtn" class="btn btn-secondary" onclick="showAddForm()">
      <span>+</span> 邮箱密码添加（实验）
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
        const codexHtml = account.codex ? \`<div class="name" style="font-weight:600;color:var(--vscode-foreground);">\${account.codex}</div>\` : '';
        el.innerHTML = \`
          \${codexHtml}
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
            <div class="email">\${acc.codex ? acc.codex + ' · ' : ''}\${acc.email}</div>
            <div class="name">\${acc.name} · \${acc.planName}</div>
          </div>
          <div class="actions">
            <button class="icon-btn" onclick="event.stopPropagation(); editCodex('\${acc.id}', '\${(acc.codex||'').replace(/'/g,"\\\\'")}')" title="编辑备注">✏️</button>
            <button class="icon-btn" onclick="event.stopPropagation(); copyCredentials('\${acc.id}')" title="\${acc.hasPassword ? '复制账号密码' : '该账号未保存密码'}" \${acc.hasPassword ? '' : 'disabled'}>🔐</button>
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

    function toggleImportMethods() {
      document.getElementById('importMethodsTitle').classList.toggle('collapsed');
      document.getElementById('importMethodsBody').classList.toggle('collapsed');
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

    function submitAutoOfficialImport() {
      const email = document.getElementById('officialEmailInput').value.trim();
      const password = document.getElementById('officialPasswordInput').value;
      const mode = document.querySelector('input[name="officialImportMode"]:checked')?.value || 'fast';

      if (!email || !(password || '').trim()) {
        showMessage('error', '请输入邮箱和密码');
        return;
      }

      vscode.postMessage({ type: 'autoOfficialImport', email, password, mode });
    }

    function submitBatchAutoOfficialImport() {
      const accountsText = document.getElementById('batchOfficialInput').value.trim();
      const mode = document.querySelector('input[name="batchOfficialImportMode"]:checked')?.value || 'fast';

      if (!accountsText) {
        showMessage('error', '请输入批量账号，格式为：邮箱,密码');
        return;
      }

      vscode.postMessage({ type: 'batchAutoOfficialImport', accountsText, mode });
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
    
    function deleteAccount(accountId) {
      vscode.postMessage({ type: 'deleteAccount', accountId });
    }

    function editCodex(accountId, current) {
      vscode.postMessage({ type: 'editCodex', accountId, currentCodex: current || '' });
    }

    function importCurrentOnlineAccount() {
      vscode.postMessage({ type: 'importCurrentOnlineAccount' });
    }

    function clearCurrentAuthData() {
      vscode.postMessage({ type: 'clearCurrentAuthData' });
    }

    function openOfficialWindsurfLoginPage() {
      vscode.postMessage({ type: 'openOfficialWindsurfLoginPage' });
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
    document.getElementById('officialPasswordInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitAutoOfficialImport();
    });
  </script>
</body>
</html>`;
  }
}
