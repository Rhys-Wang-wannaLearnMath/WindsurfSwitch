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
    async switchAccount(account: Account): Promise<{ success: boolean; error?: string; needsRestart?: boolean }> {
        this.outputChannel.clear();
        // 不自动显示日志面板，只在需要时手动查看

        try {
            this.log('========== 开始切换账号 ==========');
            this.log(`目标账号: ${account.email}`);

            // 步骤 1: 检查并应用补丁
            this.log('步骤 1: 检查 Windsurf 补丁...');
            const patchResult = await WindsurfPatchService.checkAndApplyPatch();

            if (patchResult.needsRestart) {
                this.log('补丁已应用，需要重启 Windsurf...');
                vscode.window.showInformationMessage('补丁已应用，Windsurf 正在重启。重启后请再次切换账号。');

                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 1500);

                return { success: false, needsRestart: true, error: '补丁已应用，正在重启' };
            }

            if (patchResult.error) {
                this.log(`补丁检查失败: ${patchResult.error}`);
                return { success: false, error: patchResult.error };
            }

            this.log('补丁检查通过');

            // 步骤 2: 尝试登出现有会话
            this.log('步骤 2: 登出现有会话...');
            try {
                await vscode.commands.executeCommand('windsurf.logout');
                this.log('登出成功');
            } catch {
                this.log('登出命令不可用（用户可能未登录）');
            }

            // 步骤 3: 重置机器 ID（可选）
            this.log('步骤 3: 重置机器 ID...');
            try {
                const ids = await MachineIdResetter.resetMachineId();
                this.log(`新机器 ID: ${ids.machineId.substring(0, 16)}...`);
            } catch {
                this.log('机器 ID 重置跳过');
            }

            // 步骤 4: 注入新会话
            this.log('步骤 4: 注入新会话...');
            this.log(`用户: ${account.email}`);
            this.log(`API Key: ${account.apiKey.substring(0, 20)}...`);

            try {
                await vscode.commands.executeCommand('windsurf.provideAuthTokenToAuthProviderWithShit', {
                    apiKey: account.apiKey,
                    name: account.email,
                    apiServerUrl: account.apiServerUrl || 'https://server.self-serve.windsurf.com'
                });

                this.log('会话注入成功！');

                // 同时更新数据库（备用）
                await this.writeAuthData(account);

                this.log('========== 切换完成 ==========');
                this.log(`账号: ${account.email}`);

                vscode.window.showInformationMessage(`账号已切换到: ${account.email}`);

                return { success: true };

            } catch (error) {
                this.log(`会话注入失败: ${(error as Error).message}`);

                // 尝试备用方案：直接写数据库并重载
                this.log('尝试备用方案：写入数据库并重载窗口...');
                await this.writeAuthData(account);

                setTimeout(() => {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }, 1500);

                return { success: true };
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
