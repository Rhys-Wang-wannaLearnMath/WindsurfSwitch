import * as vscode from 'vscode';
import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface BrowserAutomationResult {
  success: boolean;
  message: string;
  browser?: string;
  error?: string;
  authToken?: string;
}

export type BrowserAutomationMode = 'fast' | 'slow';

export interface BrowserAutomationOptions {
  mode?: BrowserAutomationMode;
}

interface BrowserAutomationTimings {
  initialPageWaitMs: number;
  loginStatusTimeoutMs: number;
  loginStatusPollMs: number;
  protocolDialogTimeoutMs: number;
  externalCaptureTimeoutMs: number;
  postProtocolWaitMs: number;
  postExternalOpenWaitMs: number;
  ideConfirmForegroundMs: number;
}

interface DebugTarget {
  id?: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

class CdpConnection {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private eventHandlers = new Map<string, Set<(params: any) => void>>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (error) => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(new Error('CDP connection closed')));
  }

  static connect(webSocketUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const url = new URL(webSocketUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection(Number(url.port), url.hostname);
      let handshakeBuffer = Buffer.alloc(0);
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(error);
        }
      };

      const timer = setTimeout(() => fail(new Error('CDP handshake timeout')), 10000);

      socket.on('connect', () => {
        socket.write([
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          ''
        ].join('\r\n'));
      });

      socket.on('data', function onHandshakeData(chunk) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const marker = handshakeBuffer.indexOf('\r\n\r\n');
        if (marker === -1) {
          return;
        }

        const header = handshakeBuffer.subarray(0, marker).toString('utf8');
        if (!header.includes(' 101 ')) {
          clearTimeout(timer);
          fail(new Error(`CDP handshake failed: ${header.split('\r\n')[0]}`));
          return;
        }

        socket.off('data', onHandshakeData);
        clearTimeout(timer);
        settled = true;
        const connection = new CdpConnection(socket);
        const rest = handshakeBuffer.subarray(marker + 4);
        if (rest.length > 0) {
          connection.handleData(rest);
        }
        resolve(connection);
      });

      socket.on('error', fail);
    });
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    this.sendFrame(Buffer.from(payload, 'utf8'), 0x1);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
    }
  }

  on(method: string, handler: (params: any) => void): () => void {
    let handlers = this.eventHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }

      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x1) {
        this.handleMessage(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.rejectAll(new Error('CDP websocket closed'));
      } else if (opcode === 0x9) {
        this.sendFrame(payload, 0xA);
      }
    }
  }

  private handleMessage(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      if (typeof message.method === 'string') {
        const handlers = this.eventHandlers.get(message.method);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(message.params || {});
            } catch {
            }
          }
        }
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  private sendFrame(payload: Buffer, opcode: number): void {
    const mask = crypto.randomBytes(4);
    let header: Buffer;

    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | payload.length;
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }

    const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, maskedPayload]));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class OfficialBrowserAutomation {
  private static readonly LOGIN_URL = 'https://windsurf.com/account/login';
  private static readonly IDE_AUTH_URL = 'https://windsurf.com/windsurf/signin';
  private static readonly EDGE_BROWSER = 'Microsoft Edge';
  private static readonly TIMINGS: Record<BrowserAutomationMode, BrowserAutomationTimings> = {
    fast: {
      initialPageWaitMs: 1200,
      loginStatusTimeoutMs: 25000,
      loginStatusPollMs: 1000,
      protocolDialogTimeoutMs: 4500,
      externalCaptureTimeoutMs: 4500,
      postProtocolWaitMs: 1200,
      postExternalOpenWaitMs: 1000,
      ideConfirmForegroundMs: 1800
    },
    slow: {
      initialPageWaitMs: 4000,
      loginStatusTimeoutMs: 45000,
      loginStatusPollMs: 1800,
      protocolDialogTimeoutMs: 15000,
      externalCaptureTimeoutMs: 12000,
      postProtocolWaitMs: 3500,
      postExternalOpenWaitMs: 5000,
      ideConfirmForegroundMs: 8000
    }
  };

  static async login(email: string, password: string, log?: (message: string) => void, options: BrowserAutomationOptions = {}): Promise<BrowserAutomationResult> {
    if (process.platform !== 'darwin') {
      await vscode.env.openExternal(vscode.Uri.parse(this.LOGIN_URL));
      return {
        success: false,
        message: '当前系统暂不支持 Edge 自动化，已打开官网登录页，请手动登录。'
      };
    }

    const mode = options.mode === 'slow' ? 'slow' : 'fast';
    const timings = this.TIMINGS[mode];
    let cdp: CdpConnection | undefined;
    let userDataDir: string | undefined;
    try {
      log?.(`正在以${mode === 'slow' ? '慢速' : '快速'}模式打开独立 Edge 来宾窗口，不会影响你正常使用的 Edge...`);
      const port = await this.getFreePort();
      userDataDir = path.join(os.tmpdir(), `windsurf-switch-edge-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await this.launchEdge(port, userDataDir);
      await this.waitForDebugger(port);
      const target = await this.getPageTarget(port);
      if (!target.webSocketDebuggerUrl) {
        throw new Error('未获取到 Edge 调试页面');
      }

      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');

      log?.('正在清理临时 Edge 窗口中的 windsurf.com 登录状态...');
      await this.clearWindsurfData(cdp);

      const logoutResult = 'guest-session-no-logout-needed';

      log?.('正在打开登录页并提交目标账号...');
      await this.clearWindsurfData(cdp);
      await this.navigate(cdp, `${this.LOGIN_URL}?windsurfSwitch=${Date.now()}`);
      await this.delay(timings.initialPageWaitMs);
      const loginResult = await this.evaluate(cdp, this.buildLoginScript(email, password), 70000);

      log?.('正在确认 Edge 登录页面状态...');
      const statusResult = await this.waitForLoginStatus(cdp, email, timings);
      let redirectResult = 'not-started';
      const loginNeedsManual = this.needsManualCompletion(`login=${loginResult}; status=${statusResult}`);
      if (!loginNeedsManual) {
        log?.('正在同一个来宾 Edge 窗口中打开 Windsurf IDE 官方授权跳转...');
        const externalUrls: string[] = [];
        const stopCapture = this.captureExternalProtocolUrls(cdp, externalUrls);
        await this.navigate(cdp, this.buildIdeAuthUrl());
        try {
          const clickPromise = this.autoClickWindsurfProtocolDialog(log, timings.protocolDialogTimeoutMs);
          const capturedUrl = await this.waitForCapturedExternalUrl(externalUrls, timings.externalCaptureTimeoutMs);
          let openedExternal = false;
          if (capturedUrl) {
            openedExternal = await this.openCapturedExternalUrl([capturedUrl], log);
            redirectResult = 'captured-external-url';
          } else {
            redirectResult = await clickPromise;
            await this.delay(timings.postProtocolWaitMs);
            openedExternal = await this.openCapturedExternalUrl(externalUrls, log);
          }
          void this.autoConfirmIdeAccountSwitch(log, timings.ideConfirmForegroundMs).catch(() => undefined);
          await this.delay(openedExternal ? timings.postExternalOpenWaitMs : timings.postProtocolWaitMs);
          const status = openedExternal ? 'external-callback-opened' : await this.evaluate(cdp, this.buildRedirectStatusScript(), 10000);
          redirectResult = `${redirectResult}; external=${openedExternal ? 'opened-captured-url' : 'not-captured'}; ${status}`;
        } finally {
          stopCapture();
        }
      }

      const summary = `logout=${logoutResult}; login=${loginResult}; status=${statusResult}; redirect=${redirectResult}`;
      log?.(`Edge 自动化结果: ${summary}`);

      const needsManual = this.needsManualCompletion(summary);
      return {
        success: !needsManual,
        browser: this.EDGE_BROWSER,
        message: needsManual
          ? `来宾 ${this.EDGE_BROWSER} 窗口未能自动完成 IDE 授权跳转。`
          : `已使用来宾 ${this.EDGE_BROWSER} 窗口登录并触发 IDE 官方授权。`,
        error: needsManual ? summary : undefined
      };
    } catch (error) {
      await vscode.env.openExternal(vscode.Uri.parse(this.LOGIN_URL));
      return {
        success: false,
        browser: this.EDGE_BROWSER,
        message: `未能自动控制 ${this.EDGE_BROWSER}，已打开官网登录页，请手动完成登录。`,
        error: (error as Error).message
      };
    } finally {
      if (cdp) {
        await cdp.send('Browser.close', {}, 5000).catch(() => undefined);
        cdp.close();
      }
      if (userDataDir) {
        await fs.promises.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private static async launchEdge(port: number, userDataDir: string): Promise<void> {
    const child = spawn('open', [
      '-na',
      this.EDGE_BROWSER,
      '--args',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--guest',
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      `${this.LOGIN_URL}?windsurfSwitch=${Date.now()}`
    ], { stdio: 'ignore', detached: true });
    child.unref();
  }

  private static async waitForDebugger(port: number): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      try {
        await this.requestJson(`http://127.0.0.1:${port}/json/version`);
        return;
      } catch {
        await this.delay(500);
      }
    }
    throw new Error('Edge 调试端口启动超时');
  }

  private static async getPageTarget(port: number): Promise<DebugTarget> {
    const targets = await this.requestJson<DebugTarget[]>(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) {
      return page;
    }

    return await this.requestJson<DebugTarget>(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${this.LOGIN_URL}?windsurfSwitch=${Date.now()}`)}`,
      'PUT'
    );
  }

  private static async clearWindsurfData(cdp: CdpConnection): Promise<void> {
    const origins = [
      'https://windsurf.com',
      'https://www.windsurf.com',
      'https://auth.windsurf.com'
    ];

    await cdp.send('Network.clearBrowserCache', {}, 20000).catch(() => undefined);
    await this.deleteWindsurfCookies(cdp);

    for (const origin of origins) {
      await cdp.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'all'
      }, 20000).catch(() => undefined);
    }
  }

  private static async deleteWindsurfCookies(cdp: CdpConnection): Promise<void> {
    const result = await cdp.send('Network.getAllCookies', {}, 20000).catch(() => undefined);
    const cookies = Array.isArray(result?.cookies) ? result.cookies : [];

    for (const cookie of cookies) {
      const domain = String(cookie.domain || '').toLowerCase();
      const name = String(cookie.name || '');
      if (!name || !domain.includes('windsurf.com')) {
        continue;
      }

      await cdp.send('Network.deleteCookies', {
        name,
        domain: cookie.domain,
        path: cookie.path || '/'
      }, 10000).catch(() => undefined);
    }
  }

  private static async navigate(cdp: CdpConnection, url: string): Promise<void> {
    await cdp.send('Page.navigate', { url }, 20000);
  }

  private static async evaluate(cdp: CdpConnection, expression: string, timeoutMs: number): Promise<string> {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, timeoutMs);

    if (result.exceptionDetails) {
      return `exception:${result.exceptionDetails.text || 'unknown'}`;
    }

    const value = result.result?.value ?? result.result?.description ?? '';
    return String(value);
  }

  private static async waitForLoginStatus(cdp: CdpConnection, email: string, timings: BrowserAutomationTimings): Promise<string> {
    const startedAt = Date.now();
    let lastStatus = 'not-checked';
    while (Date.now() - startedAt < timings.loginStatusTimeoutMs) {
      lastStatus = await this.evaluate(cdp, this.buildLoginStatusScript(email), 10000);
      if (!this.needsManualCompletion(`status=${lastStatus}`)) {
        return lastStatus;
      }
      await this.delay(timings.loginStatusPollMs);
    }
    return lastStatus;
  }

  private static buildLogoutScript(): string {
    return `
(async function(){
  const delay = function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };
  const visible = function(el){
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const textOf = function(el){
    return ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '').trim().toLowerCase();
  };
  const controls = function(){
    return Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], [aria-label], [data-testid], input[type="button"], input[type="submit"]')).filter(visible);
  };
  const findMatching = function(words){
    return controls().find(function(el){
      const text = textOf(el);
      return words.some(function(word){ return text.includes(word); });
    }) || null;
  };
  const waitFor = async function(fn, timeoutMs){
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = fn();
      if (value) return value;
      await delay(500);
    }
    return null;
  };
  const logoutButton = await waitFor(function(){ return findMatching(['log out']); }, 30000);
  if (logoutButton) {
    logoutButton.scrollIntoView({ block: 'center', inline: 'center' });
    logoutButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    logoutButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    logoutButton.click();
    await delay(4000);
    return 'clicked-log-out';
  }
  const fallbackButton = findMatching(['sign out', 'logout', '退出', '登出']);
  if (fallbackButton) {
    fallbackButton.click();
    await delay(4000);
    return 'clicked-fallback-logout';
  }
  return 'logout-button-not-found';
})();`;
  }

  private static buildLoginScript(email: string, password: string): string {
    const emailJson = JSON.stringify(email);
    const passwordJson = JSON.stringify(password);
    return `
(async function(){
  const targetEmail = ${emailJson};
  const targetPassword = ${passwordJson};
  const delay = function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };
  const visible = function(el){
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const setNativeValue = function(el, value){
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const deepQueryAll = function(selector){
    const results = [];
    const visit = function(root){
      try {
        results.push.apply(results, Array.prototype.slice.call(root.querySelectorAll(selector)));
        Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function(el){
          if (el.shadowRoot) visit(el.shadowRoot);
        });
      } catch (e) {}
    };
    visit(document);
    return results;
  };
  const allInputs = function(){ return deepQueryAll('input, textarea').filter(visible); };
  const allControls = function(){ return deepQueryAll('button, a, input[type="submit"], [role="button"]').filter(visible); };
  const findEmailInput = function(){
    return allInputs().find(function(input){
      const text = ((input.type || '') + ' ' + (input.name || '') + ' ' + (input.id || '') + ' ' + (input.autocomplete || '') + ' ' + (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '')).toLowerCase();
      return input.type === 'email' || text.includes('email') || text.includes('邮箱') || text.includes('mail');
    }) || allInputs().find(function(input){ return input.type !== 'password' && input.type !== 'hidden'; });
  };
  const findPasswordInput = function(){ return allInputs().find(function(input){ return input.type === 'password'; }); };
  const pressEnter = function(el){
    if (!el) return;
    ['keydown', 'keypress', 'keyup'].forEach(function(type){
      el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    });
  };
  const clickControl = function(words){
    const preferred = allControls().find(function(el){
      const text = ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '') + '').toLowerCase();
      return words.some(function(word){ return text.includes(word); });
    }) || null;
    if (preferred) {
      preferred.click();
      return true;
    }
    return false;
  };
  const clickSubmitLike = function(){
    if (clickControl(['continue with email', 'email', 'log in', 'login', 'sign in', 'continue', 'next', 'submit', '登录', '继续', '下一步'])) return true;
    const form = findPasswordInput()?.form || findEmailInput()?.form;
    if (form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return true;
    }
    return false;
  };
  const waitFor = async function(fn, timeoutMs){
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = fn();
      if (value) return value;
      await delay(500);
    }
    return null;
  };
  clickControl(['continue with email', 'email', '邮箱', 'password', '密码']);
  let emailInput = await waitFor(findEmailInput, 30000);
  if (!emailInput) {
    clickControl(['log in with email', 'continue with email', 'sign in with email', 'email']);
    emailInput = await waitFor(findEmailInput, 15000);
  }
  if (!emailInput) return 'login-form-not-found';
  emailInput.focus();
  setNativeValue(emailInput, targetEmail);
  await delay(700);
  clickSubmitLike();
  let passwordInput = await waitFor(findPasswordInput, 25000);
  if (!passwordInput) {
    pressEnter(emailInput);
    passwordInput = await waitFor(findPasswordInput, 15000);
  }
  if (!passwordInput) return 'password-form-not-found-after-email';
  passwordInput.focus();
  setNativeValue(passwordInput, targetPassword);
  await delay(700);
  if (!clickSubmitLike()) pressEnter(passwordInput);
  else await delay(1000);
  pressEnter(passwordInput);
  await delay(3000);
  return 'submitted';
})();`;
  }

  private static buildLoginStatusScript(email: string): string {
    const emailJson = JSON.stringify(email);
    return `
(function(){
  const targetEmail = ${emailJson}.toLowerCase();
  const visible = function(el){
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea')).filter(visible);
  const hasPassword = inputs.some(function(input){ return input.type === 'password'; });
  const hasEmail = inputs.some(function(input){
    const text = ((input.type || '') + ' ' + (input.name || '') + ' ' + (input.id || '') + ' ' + (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '')).toLowerCase();
    return input.type === 'email' || text.includes('email') || text.includes('邮箱') || text.includes('mail');
  });
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  if (bodyText.includes(targetEmail) && !hasPassword) return 'target-visible';
  if (hasPassword) return 'password-form-visible';
  if (hasEmail) return 'email-form-visible';
  if (location.href.includes('/account/login')) return 'login-page-no-form';
  if (location.hostname.endsWith('windsurf.com')) return 'logged-in-or-next-step-' + location.href;
  return 'unknown-page-' + location.href;
})();`;
  }

  private static buildAuthTokenExtractionScript(): string {
    return `
(async function(){
  const delay = function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };
  const textOf = function(el){
    return ((el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '') + '').trim();
  };
  const visible = function(el){
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const deepQueryAll = function(selector){
    const results = [];
    const visit = function(root){
      try {
        results.push.apply(results, Array.prototype.slice.call(root.querySelectorAll(selector)));
        Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function(el){
          if (el.shadowRoot) visit(el.shadowRoot);
        });
      } catch (e) {}
    };
    visit(document);
    return results;
  };
  const pushObjectValues = function(value, output, depth){
    if (!value || depth > 4) return;
    if (typeof value === 'string') {
      output.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    try {
      if (Array.isArray(value)) {
        value.slice(0, 100).forEach(function(item){ pushObjectValues(item, output, depth + 1); });
      } else {
        Object.keys(value).slice(0, 100).forEach(function(key){
          output.push(key);
          pushObjectValues(value[key], output, depth + 1);
        });
      }
    } catch (e) {}
  };
  const clickLikelyControls = function(){
    const words = ['show', 'copy', 'token', 'continue', 'authorize', 'generate', 'manual', '显示', '复制', '令牌', '授权', '继续', '生成'];
    let clicked = 0;
    deepQueryAll('button, a, [role="button"], input[type="button"], input[type="submit"]').filter(visible).forEach(function(el){
      const text = textOf(el).toLowerCase();
      if (words.some(function(word){ return text.includes(word); })) {
        try {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
          clicked++;
        } catch (e) {}
      }
    });
    return clicked;
  };
  const normalizeToken = function(value){
    if (!value) return '';
    let candidate = String(value).trim();
    candidate = candidate.replace(/^["']+|["'.,;:]+$/g, '').trim();
    try { candidate = decodeURIComponent(candidate); } catch (e) {}
    candidate = candidate.replace(/^["']+|["'.,;:]+$/g, '').trim();
    if (candidate.startsWith('Bearer ')) candidate = candidate.slice(7).trim();
    return candidate;
  };
  const isToken = function (value) {
    const candidate = normalizeToken(value);
    return candidate.length > 40
      && candidate.length < 8000
      && /^[A-Za-z0-9._~+/=-]+$/.test(candidate)
      && !candidate.includes('windsurf.com')
      && !candidate.includes('http');
  };
  const findToken = function () {
    const tokenKeys = ['access_token', 'auth_token', 'token'];
    const urls = [location.href];
    try {
      const current = new URL(location.href);
      if (current.hash && current.hash.length > 1) urls.push('https://local.invalid/?' + current.hash.slice(1));
    } catch (e) { }
    for (const value of urls) {
      try {
        const url = new URL(value);
        for (const key of tokenKeys) {
          const token = url.searchParams.get(key);
          if (isToken(token)) return normalizeToken(token);
        }
      } catch (e) { }
    }
    const candidates = [];
    deepQueryAll('input, textarea').forEach(function (el) {
      if (el.value) candidates.push(String(el.value).trim());
    });
    deepQueryAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes || []).forEach(function (attr) {
        if (/token|auth|access/i.test(attr.name) || isToken(attr.value)) candidates.push(attr.value);
      });
      const text = textOf(el);
      if (text) candidates.push(text);
    });
    Array.prototype.slice.call(document.scripts || []).forEach(function (script) {
      if (script.textContent) candidates.push(script.textContent);
    });
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          candidates.push(key);
          candidates.push(localStorage.getItem(key) || '');
        }
      }
    } catch (e) { }
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key) {
          candidates.push(key);
          candidates.push(sessionStorage.getItem(key) || '');
        }
      }
    } catch (e) { }
    try { pushObjectValues(window.__NEXT_DATA__, candidates, 0); } catch (e) { }
    const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    const regexes = [
      /access_token=([^&#\\s"'<>]{40,})/i,
      /auth[_\\s-]*token[^A-Za-z0-9._~+/=-]{0,80}([A-Za-z0-9._~+/=-]{40,})/i,
      /authentication[_\\s-]*token[^A-Za-z0-9._~+/=-]{0,80}([A-Za-z0-9._~+/=-]{40,})/i,
      /token[^A-Za-z0-9._~+/=-]{0,80}([A-Za-z0-9._~+/=-]{40,})/i,
      /\\b(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)\\b/,
      /\\b([A-Za-z0-9._~+/=-]{80,})\\b/
    ];
    for (const source of candidates.concat([bodyText, document.documentElement ? document.documentElement.outerHTML : ''])) {
      const value = String(source || '');
      for (const regex of regexes) {
        const match = value.match(regex);
        if (match && match[1]) candidates.push(match[1].trim());
      }
    }
    const lines = bodyText.split(/\\s+/).map(function (item) { return item.trim(); });
    candidates.push.apply(candidates, lines);
    const found = candidates.find(isToken);
    return found ? normalizeToken(found) : '';
  };
  const diagnose = function () {
    const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    const buttons = deepQueryAll('button, a, [role="button"]').filter(visible).slice(0, 8).map(function (el) { return textOf(el).slice(0, 80); }).filter(Boolean);
    return 'auth-token-not-found:url=' + location.href
      + ';title=' + document.title
      + ';body=' + bodyText.replace(/\\s+/g, ' ').slice(0, 220)
      + ';buttons=' + buttons.join('|');
  };
  const startedAt = Date.now();
  let clicked = false;
while (Date.now() - startedAt < 20000) {
  const token = findToken();
  if (token) return 'auth-token:' + token;
  if (!clicked || Date.now() - startedAt > 6000) {
    clickLikelyControls();
    clicked = true;
  }
  await delay(750);
}
return diagnose();
}) (); `;
  }

  private static buildRedirectStatusScript(): string {
    return `
(function(){
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
  if (bodyText.includes('open windsurf') || bodyText.includes('打开 windsurf') || bodyText.includes('external application')) return 'external-protocol-page-visible';
  if (bodyText.includes('authentication') || bodyText.includes('authorized') || bodyText.includes('success')) return 'authorization-page-visible';
  return 'redirect-page-' + location.href;
})();`;
  }

  private static captureExternalProtocolUrls(cdp: CdpConnection, output: string[]): () => void {
    const collect = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }
      if (/^(windsurf|vscode|cursor):\/\//i.test(value) && !output.includes(value)) {
        output.push(value);
      }
    };
    const inspect = (value: any) => {
      if (!value) {
        return;
      }
      if (typeof value === 'string') {
        collect(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      if (typeof value === 'object') {
        Object.values(value).forEach(inspect);
      }
    };

    const offFrame = cdp.on('Page.frameRequestedNavigation', inspect);
    const offNetwork = cdp.on('Network.requestWillBeSent', inspect);
    const offConsole = cdp.on('Runtime.consoleAPICalled', inspect);
    return () => {
      offFrame();
      offNetwork();
      offConsole();
    };
  }

  private static async openCapturedExternalUrl(urls: string[], log?: (message: string) => void): Promise<boolean> {
    const url = urls.find(value => /^(windsurf|vscode|cursor):\/\//i.test(value));
    if (!url) {
      return false;
    }
    log?.(`已捕获 IDE 授权回调，直接交给 IDE 打开: ${url.slice(0, 80)}...`);
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return true;
  }

  private static async waitForCapturedExternalUrl(urls: string[], timeoutMs: number): Promise<string | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const url = urls.find(value => /^(windsurf|vscode|cursor):\/\//i.test(value));
      if (url) {
        return url;
      }
      await this.delay(200);
    }
    return urls.find(value => /^(windsurf|vscode|cursor):\/\//i.test(value));
  }

  static async autoConfirmIdeAccountSwitch(log?: (message: string) => void, timeoutMs = 60000): Promise<string> {
    if (process.platform !== 'darwin') {
      return 'ide-confirm-not-supported';
    }

    const iterations = Math.max(1, Math.ceil(timeoutMs / 300));
    const script = `
tell application "System Events"
  repeat with i from 1 to ${iterations}
    set candidateProcesses to {}
    repeat with p in processes
      try
        set processName to name of p as text
        if processName is "Windsurf" or processName contains "Windsurf" then
          set end of candidateProcesses to processName
        end if
      end try
    end repeat
    repeat with processName in candidateProcesses
      try
        tell process processName
          set frontmost to true
          set allElements to entire contents
          repeat with uiElement in allElements
            try
              set elementName to name of uiElement as text
              set elementRole to role description of uiElement as text
              if elementRole contains "button" or elementRole contains "按钮" then
                if elementName is "切换账号" or elementName is "切换" or elementName is "确认" or elementName is "确定" or elementName is "继续" or elementName is "允许" or elementName is "登录" or elementName is "OK" or elementName is "Yes" or elementName is "Continue" or elementName is "Allow" or elementName is "Switch" or elementName is "Switch Account" or elementName starts with "Switch " then
                  try
                    perform action "AXPress" of uiElement
                  on error
                    click uiElement
                  end try
                  return "clicked-ide-confirm:" & elementName
                end if
              end if
            end try
          end repeat
          if i mod 10 is 0 then
            key code 36
          end if
        end tell
      end try
    end repeat
    delay 0.3
  end repeat
end tell
return "ide-confirm-not-found"`;

    try {
      const result = await this.runProcess('osascript', ['-e', script], timeoutMs + 5000);
      log?.(`IDE 切换账号确认处理: ${result}`);
      return result || 'ide-confirm-processed';
    } catch (error) {
      const message = (error as Error).message;
      log?.(`IDE 切换账号确认自动处理失败: ${message}`);
      return `ide-confirm-automation-failed:${message}`;
    }
  }

  private static buildIdeAuthUrl(): string {
    const params = new URLSearchParams([
      ['response_type', 'token'],
      ['client_id', '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u'],
      ['redirect_uri', `${vscode.env.uriScheme}://codeium.windsurf`],
      ['state', crypto.randomBytes(16).toString('hex')],
      ['prompt', 'login'],
      ['redirect_parameters_type', 'fragment'],
      ['workflow', '']
    ]);
    return `${this.IDE_AUTH_URL}?${params.toString()}`;
  }

  private static async autoClickWindsurfProtocolDialog(log?: (message: string) => void, timeoutMs = 15000): Promise<string> {
    const iterations = Math.max(1, Math.ceil(timeoutMs / 250));
    const script = `
tell application "Microsoft Edge" to activate
delay 0.5
tell application "System Events"
  tell process "Microsoft Edge"
    set frontmost to true
    repeat with i from 1 to ${iterations}
      try
        set allElements to entire contents
        repeat with uiElement in allElements
          try
            set elementName to name of uiElement as text
            set elementRole to role description of uiElement as text
            if elementRole contains "button" or elementRole contains "按钮" then
              if elementName is "打开" or elementName is "打开 Windsurf" or elementName is "Open" or elementName is "Open Windsurf" or elementName starts with "Open " or elementName contains "Windsurf" then
                try
                  perform action "AXPress" of uiElement
                on error
                  click uiElement
                end try
                return "clicked-open-dialog:" & elementName
              end if
            end if
          end try
        end repeat
      end try
      if i mod 8 is 0 then
        key code 49
      end if
      if i mod 12 is 0 then
        key code 36
      end if
      delay 0.25
    end repeat
    key code 36
    delay 0.2
    key code 49
    delay 0.2
    key code 36
    return "pressed-return-fallback"
  end tell
end tell`;

    try {
      const result = await this.runProcess('osascript', ['-e', script], timeoutMs + 2500);
      log?.(`Edge 外部协议确认处理: ${result}`);
      return result || 'protocol-dialog-clicked';
    } catch (error) {
      const message = (error as Error).message;
      log?.(`Edge 外部协议确认自动点击失败: ${message}`);
      return `protocol-dialog-automation-failed:${message}`;
    }
  }

  private static buildAuthTokenUrl(): string {
    const params = new URLSearchParams([
      ['response_type', 'token'],
      ['client_id', '3GUryQ7ldAeKEuD2obYnppsnmj58eP5u'],
      ['redirect_uri', 'show-auth-token'],
      ['state', crypto.randomBytes(16).toString('hex')],
      ['prompt', 'login'],
      ['redirect_parameters_type', 'query'],
      ['workflow', '']
    ]);
    return `${this.IDE_AUTH_URL}?${params.toString()} `;
  }

  private static needsManualCompletion(result: string): boolean {
    const normalized = result.toLowerCase();
    return normalized.includes('login-form-not-found')
      || normalized.includes('password-form-not-found')
      || normalized.includes('password-form-visible')
      || normalized.includes('email-form-visible')
      || normalized.includes('login-page-no-form')
      || normalized.includes('unknown-page-')
      || normalized.includes('auth-token-not-found')
      || normalized.includes('protocol-dialog-automation-failed')
      || normalized.includes('external-protocol-page-visible')
      || normalized.includes('exception:');
  }

  private static getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
      });
    });
  }

  private static requestJson<T>(url: string, method = 'GET'): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body} `));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error as Error);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });
      req.end();
    });
  }

  private static runProcess(command: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${command} timeout`));
      }, timeoutMs);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });
      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `${command} exited with code ${code} `));
        }
      });
    });
  }

  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
