/**
 * accountManager.ts - 账号管理模块
 * 管理账号列表的 CRUD 操作
 */

import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

/**
 * 账号数据结构
 */
export interface Account {
    id: string;
    email: string;
    name: string;
    apiKey: string;
    apiServerUrl: string;
    refreshToken: string;
    planName: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * 账号管理器
 */
export class AccountManager {
    private static readonly ACCOUNTS_KEY = 'windsurfSwitch.accounts';
    private static readonly SECRETS_PREFIX = 'windsurfSwitch.secret.';
    private static readonly CURRENT_INDEX_KEY = 'windsurfSwitch.currentAccountIndex';

    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * 获取当前账号索引
     */
    getCurrentAccountIndex(): number {
        return this.context.globalState.get<number>(AccountManager.CURRENT_INDEX_KEY, 0);
    }

    /**
     * 设置当前账号索引
     */
    async setCurrentAccountIndex(index: number): Promise<void> {
        await this.context.globalState.update(AccountManager.CURRENT_INDEX_KEY, index);
    }

    /**
     * 获取下一个账号（循环）
     */
    async getNextAccount(): Promise<{ account: Account | null; index: number }> {
        const accounts = await this.getAccounts();
        if (accounts.length === 0) {
            return { account: null, index: -1 };
        }

        let currentIndex = this.getCurrentAccountIndex();
        let nextIndex = (currentIndex + 1) % accounts.length;

        return { account: accounts[nextIndex], index: nextIndex };
    }

    /**
     * 获取所有账号
     */
    async getAccounts(): Promise<Account[]> {
        const accounts = this.context.globalState.get<Account[]>(AccountManager.ACCOUNTS_KEY, []);

        // 从 SecretStorage 恢复敏感信息
        for (const account of accounts) {
            const refreshToken = await this.context.secrets.get(`${AccountManager.SECRETS_PREFIX}${account.id}.refreshToken`);
            if (refreshToken) {
                account.refreshToken = refreshToken;
            }

            const apiKey = await this.context.secrets.get(`${AccountManager.SECRETS_PREFIX}${account.id}.apiKey`);
            if (apiKey) {
                account.apiKey = apiKey;
            }
        }

        return accounts;
    }

    /**
     * 获取单个账号
     */
    async getAccount(id: string): Promise<Account | undefined> {
        const accounts = await this.getAccounts();
        return accounts.find(acc => acc.id === id);
    }

    /**
     * 添加账号
     */
    async addAccount(accountData: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>): Promise<Account> {
        const now = new Date().toISOString();
        const account: Account = {
            ...accountData,
            id: uuidv4(),
            createdAt: now,
            updatedAt: now
        };

        // 存储敏感信息到 SecretStorage
        if (account.refreshToken) {
            await this.context.secrets.store(
                `${AccountManager.SECRETS_PREFIX}${account.id}.refreshToken`,
                account.refreshToken
            );
        }
        if (account.apiKey) {
            await this.context.secrets.store(
                `${AccountManager.SECRETS_PREFIX}${account.id}.apiKey`,
                account.apiKey
            );
        }

        // 存储账号列表（不含敏感信息）
        const accounts = this.context.globalState.get<Account[]>(AccountManager.ACCOUNTS_KEY, []);
        const accountToStore = { ...account };
        accountToStore.refreshToken = '';  // 不存储在 globalState
        accountToStore.apiKey = '';

        accounts.push(accountToStore);
        await this.context.globalState.update(AccountManager.ACCOUNTS_KEY, accounts);

        return account;
    }

    /**
     * 更新账号
     */
    async updateAccount(id: string, updates: Partial<Account>): Promise<Account | undefined> {
        const accounts = this.context.globalState.get<Account[]>(AccountManager.ACCOUNTS_KEY, []);
        const index = accounts.findIndex(acc => acc.id === id);

        if (index === -1) {
            return undefined;
        }

        // 更新敏感信息
        if (updates.refreshToken) {
            await this.context.secrets.store(
                `${AccountManager.SECRETS_PREFIX}${id}.refreshToken`,
                updates.refreshToken
            );
        }
        if (updates.apiKey) {
            await this.context.secrets.store(
                `${AccountManager.SECRETS_PREFIX}${id}.apiKey`,
                updates.apiKey
            );
        }

        // 更新账号信息
        const updatedAccount = {
            ...accounts[index],
            ...updates,
            updatedAt: new Date().toISOString()
        };

        // 清除敏感信息后存储
        updatedAccount.refreshToken = '';
        updatedAccount.apiKey = '';
        accounts[index] = updatedAccount;

        await this.context.globalState.update(AccountManager.ACCOUNTS_KEY, accounts);

        // 返回完整账号（含敏感信息）
        return this.getAccount(id);
    }

    /**
     * 删除账号
     */
    async removeAccount(id: string): Promise<boolean> {
        const accounts = this.context.globalState.get<Account[]>(AccountManager.ACCOUNTS_KEY, []);
        const index = accounts.findIndex(acc => acc.id === id);

        if (index === -1) {
            return false;
        }

        // 删除敏感信息
        await this.context.secrets.delete(`${AccountManager.SECRETS_PREFIX}${id}.refreshToken`);
        await this.context.secrets.delete(`${AccountManager.SECRETS_PREFIX}${id}.apiKey`);

        // 从列表中移除
        accounts.splice(index, 1);
        await this.context.globalState.update(AccountManager.ACCOUNTS_KEY, accounts);

        return true;
    }

    /**
     * 导入账号（从 JSON）
     */
    async importAccounts(jsonData: string): Promise<number> {
        let importedAccounts: any[];

        try {
            importedAccounts = JSON.parse(jsonData);
            if (!Array.isArray(importedAccounts)) {
                importedAccounts = [importedAccounts];
            }
        } catch {
            throw new Error('无效的 JSON 格式');
        }

        let count = 0;
        for (const acc of importedAccounts) {
            if (acc.email && (acc.apiKey || acc.refreshToken)) {
                await this.addAccount({
                    email: acc.email,
                    name: acc.name || acc.email.split('@')[0],
                    apiKey: acc.apiKey || '',
                    apiServerUrl: acc.apiServerUrl || 'https://server.self-serve.windsurf.com',
                    refreshToken: acc.refreshToken || '',
                    planName: acc.planName || 'Pro'
                });
                count++;
            }
        }

        return count;
    }

    /**
     * 导出账号（为 JSON）
     */
    async exportAccounts(): Promise<string> {
        const accounts = await this.getAccounts();
        return JSON.stringify(accounts, null, 2);
    }
}
