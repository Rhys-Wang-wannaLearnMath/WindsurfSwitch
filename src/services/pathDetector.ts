/**
 * pathDetector.ts - Windsurf 路径检测器
 * 跨平台检测 Windsurf 数据目录和数据库路径
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

/**
 * Windsurf 路径检测器
 */
export class PathDetector {
    private static cachedPaths: { [key: string]: string } = {};

    /**
     * 获取用户主目录
     */
    static getHomeDir(): string {
        return os.homedir();
    }

    /**
     * 获取 Windsurf 用户数据目录
     */
    static getUserDataPath(): string {
        if (this.cachedPaths['userData']) {
            return this.cachedPaths['userData'];
        }

        const platform = process.platform;
        let userDataPath: string;

        if (platform === 'win32') {
            // Windows: %APPDATA%\Windsurf
            const appData = process.env.APPDATA || path.join(this.getHomeDir(), 'AppData', 'Roaming');
            userDataPath = path.join(appData, 'Windsurf');
        } else if (platform === 'darwin') {
            // macOS: ~/Library/Application Support/Windsurf
            userDataPath = path.join(this.getHomeDir(), 'Library', 'Application Support', 'Windsurf');
        } else {
            // Linux: ~/.config/Windsurf
            userDataPath = path.join(this.getHomeDir(), '.config', 'Windsurf');
        }

        this.cachedPaths['userData'] = userDataPath;
        return userDataPath;
    }

    /**
     * 获取 Windsurf 数据库路径 (state.vscdb)
     */
    static getDBPath(): string {
        if (this.cachedPaths['db']) {
            return this.cachedPaths['db'];
        }

        const dbPath = path.join(this.getUserDataPath(), 'User', 'globalStorage', 'state.vscdb');
        this.cachedPaths['db'] = dbPath;
        return dbPath;
    }

    /**
     * 获取 storage.json 路径
     */
    static getStorageJsonPath(): string {
        if (this.cachedPaths['storage']) {
            return this.cachedPaths['storage'];
        }

        const storagePath = path.join(this.getUserDataPath(), 'storage.json');
        this.cachedPaths['storage'] = storagePath;
        return storagePath;
    }

    /**
     * 检查 Windsurf 是否已安装
     */
    static async isInstalled(): Promise<boolean> {
        try {
            const dbPath = this.getDBPath();
            await fs.access(dbPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取所有相关路径
     */
    static getAllPaths(): { [key: string]: string } {
        return {
            home: this.getHomeDir(),
            userData: this.getUserDataPath(),
            database: this.getDBPath(),
            storage: this.getStorageJsonPath()
        };
    }
}
