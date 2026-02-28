/**
 * accountSwitcher.ts - 账号切换核心模块
 * 使用补丁方式实现无感切换
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { Account } from './accountManager';
import { DatabaseHelper } from './databaseHelper';
import { MachineIdResetter } from './machineIdReset';
import { WindsurfPatchService } from './windsurfPatchService';

/**
 * 认证状态数据结构
 */
interface AuthStatus {
    name: string;
    apiKey: string;
    email: string;
    teamId: string;
    planName: string;
}

/**
 * 账号切换器
 * 
 * 实现原理：
 * 1. 检查并应用补丁（注入自定义命令到 Windsurf 的 extension.js）
 * 2. 调用自定义命令 windsurf.provideAuthTokenToAuthProviderWithShit 注入会话
 * 3. 会话直接写入 VSCode Secrets，无需服务器验证
 */
export class AccountSwitcher {
    private outputChannel: vscode.OutputChannel;
    private context?: vscode.ExtensionContext;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Windsurf 换号');
    }

    /**
     * 设置 ExtensionContext
     */
    setContext(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * 输出日志
     */
    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        const logMessage = `[${timestamp}] ${message}`;
        this.outputChannel.appendLine(logMessage);
        console.log(logMessage);
    }

    /**
     * 显示日志面板
     */
    showLog(): void {
        this.outputChannel.show();
    }

    /**
     * 切换账号 - 使用补丁方式
     */
    async switchAccount(account: Account): Promise<{ success: boolean; error?: string; needsRestart?: boolean; method?: string }> {
        this.outputChannel.clear();
        this.outputChannel.show(true); // 始终显示日志面板，方便排查

        try {
            this.log('========== 开始切换账号 ==========');
            this.log(`目标账号: ${account.email}`);

            // 步骤 1: 检查并应用补丁
            this.log('步骤 1: 检查 Windsurf 补丁...');
            let patchResult: { needsRestart: boolean; error?: string };
            try {
                patchResult = await WindsurfPatchService.checkAndApplyPatch();
            } catch (patchError) {
                const msg = (patchError as Error).message;
                this.log(`[步骤1异常] 补丁检查抛出异常: ${msg}`);
                this.log(`[步骤1异常] 堆栈: ${(patchError as Error).stack || '无'}`);
                patchResult = { needsRestart: false, error: `补丁检查异常: ${msg}` };
            }

            if (patchResult.needsRestart) {
                this.log('补丁已应用，需要重启 Windsurf...');
                vscode.window.showInformationMessage('补丁已应用，Windsurf 正在重启。重启后请再次切换账号。');

                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 1500);

                return { success: false, needsRestart: true, error: '补丁已应用，正在重启' };
            }

            if (patchResult.error) {
                this.log(`补丁检查失败（将继续尝试备用方案）: ${patchResult.error}`);
            }

            this.log('补丁检查通过');

            // 步骤 2: 尝试登出现有会话
            this.log('步骤 2: 登出现有会话...');
            try {
                await vscode.commands.executeCommand('windsurf.logout');
                this.log('登出成功');
            } catch (logoutError) {
                this.log(`[步骤2] 登出命令不可用: ${(logoutError as Error).message}`);
            }

            // 步骤 3: 重置机器 ID（可选）
            this.log('步骤 3: 重置机器 ID...');
            try {
                const ids = await MachineIdResetter.resetMachineId();
                this.log(`新机器 ID: ${ids.machineId.substring(0, 16)}...`);
            } catch (resetError) {
                this.log(`[步骤3] 机器 ID 重置跳过: ${(resetError as Error).message}`);
            }

            // 步骤 4: 注入新会话
            this.log('步骤 4: 注入新会话...');
            this.log(`用户: ${account.email}`);
            this.log(`API Key: ${account.apiKey ? account.apiKey.substring(0, 20) + '...' : '(空)'}`);

            // 4a: 检查补丁命令是否可用
            let patchCommandAvailable = false;
            try {
                const commands = await vscode.commands.getCommands();
                patchCommandAvailable = commands.includes('windsurf.provideAuthTokenToAuthProviderWithShit');
                this.log(`[步骤4a] 补丁命令可用: ${patchCommandAvailable}`);
                if (!patchCommandAvailable) {
                    this.log('[步骤4a] 补丁命令不存在，将直接使用备用方案（写数据库）');
                }
            } catch (cmdCheckError) {
                this.log(`[步骤4a] 检查命令列表失败: ${(cmdCheckError as Error).message}`);
            }

            // 4b: 尝试通过补丁命令注入
            let injectionSuccess = false;
            if (patchCommandAvailable) {
                try {
                    this.log('[步骤4b] 通过补丁命令注入会话...');
                    await vscode.commands.executeCommand('windsurf.provideAuthTokenToAuthProviderWithShit', {
                        apiKey: account.apiKey,
                        name: account.email,
                        apiServerUrl: account.apiServerUrl || 'https://server.self-serve.windsurf.com'
                    });
                    this.log('[步骤4b] 会话注入成功！');
                    injectionSuccess = true;
                } catch (injectError) {
                    this.log(`[步骤4b] 会话注入失败: ${(injectError as Error).message}`);
                    this.log(`[步骤4b] 堆栈: ${(injectError as Error).stack || '无'}`);
                }
            }

            // 4c: 尝试写数据库（备用或补充）
            try {
                this.log('[步骤4c] 写入认证数据到数据库...');
                await this.writeAuthData(account);
                this.log('[步骤4c] 数据库写入成功');
            } catch (dbError) {
                this.log(`[步骤4c] 数据库写入失败: ${(dbError as Error).message}`);
                this.log(`[步骤4c] 堆栈: ${(dbError as Error).stack || '无'}`);
                // 不再抛出，继续流程
            }

            if (injectionSuccess) {
                this.log('========== 切换完成（补丁注入） ==========');
                this.log(`账号: ${account.email}`);
                vscode.window.showInformationMessage(`账号已切换到: ${account.email}`);
                return { success: true, method: 'injection' };
            } else {
                this.log('========== 注入未成功，尝试重载窗口（备用方案） ==========');
                this.log('注意：备用方案仅写入数据库，效果可能有限');
                this.log('请查看上方日志，确认哪个步骤失败');
                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 2000);
                return { success: false, method: 'fallback', error: '补丁命令注入未成功，已尝试写数据库+重载窗口。请查看「Windsurf 换号」输出面板中的详细日志。' };
            }

        } catch (error) {
            const errorMessage = (error as Error).message;
            this.log(`切换失败: ${errorMessage}`);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * 写入认证数据到数据库（备用方案）
     */
    private async writeAuthData(account: Account): Promise<void> {
        const teamId = uuidv4();

        const authStatus: AuthStatus = {
            name: account.name,
            apiKey: account.apiKey,
            email: account.email,
            teamId: teamId,
            planName: account.planName || 'Pro'
        };
        await DatabaseHelper.writeToDB('windsurfAuthStatus', authStatus);
        this.log('已写入 windsurfAuthStatus');

        const installationId = uuidv4();
        const codeiumConfig = {
            'codeium.installationId': installationId,
            'codeium.apiKey': account.apiKey,
            'apiServerUrl': account.apiServerUrl || 'https://server.self-serve.windsurf.com',
            'codeium.hasOneTimeUpdatedUnspecifiedMode': true
        };
        await DatabaseHelper.writeToDB('codeium.windsurf', codeiumConfig);
        this.log('已写入 codeium.windsurf');

        await DatabaseHelper.writeToDB('codeium.windsurf-windsurf_auth', account.name);
        this.log('已写入用户名');
    }

    /**
     * 获取当前登录的账号
     */
    async getCurrentAccount(): Promise<AuthStatus | null> {
        try {
            const authStatus = await DatabaseHelper.readFromDB('windsurfAuthStatus');
            return authStatus as AuthStatus;
        } catch {
            return null;
        }
    }

    /**
     * 检查是否支持无感换号
     */
    async isAutoLoginSupported(): Promise<boolean> {
        try {
            const commands = await vscode.commands.getCommands();
            return commands.includes('windsurf.provideAuthTokenToAuthProviderWithShit');
        } catch {
            return false;
        }
    }
}
