/**
 * databaseHelper.ts - SQLite 数据库操作模块
 * 使用 sql.js 操作 Windsurf 的 state.vscdb 数据库
 */

import * as fs from 'fs/promises';
import { PathDetector } from './pathDetector';

// sql.js 类型定义
interface SqlJsDatabase {
    exec(sql: string, params?: any[]): { columns: string[]; values: any[][] }[];
    run(sql: string, params?: any[]): void;
    export(): Uint8Array;
    close(): void;
}

interface SqlJs {
    Database: new (data?: ArrayLike<number>) => SqlJsDatabase;
}

let sqlJsInstance: SqlJs | null = null;

/**
 * 初始化 sql.js
 */
async function initSqlJs(): Promise<SqlJs> {
    if (sqlJsInstance) {
        return sqlJsInstance;
    }

    // 动态导入 sql.js
    try {
        console.log('[DatabaseHelper] 正在加载 sql.js 模块...');
        const sqlJsModule = require('sql.js');
        console.log('[DatabaseHelper] sql.js 模块类型:', typeof sqlJsModule, '键:', Object.keys(sqlJsModule || {}).join(','));
        // 兼容 CommonJS default export 和 ESM interop
        const initFn = typeof sqlJsModule === 'function' ? sqlJsModule : (sqlJsModule.default || sqlJsModule);
        if (typeof initFn !== 'function') {
            throw new Error(`sql.js 导出不是函数, 类型: ${typeof initFn}`);
        }
        sqlJsInstance = await initFn();
        console.log('[DatabaseHelper] sql.js 初始化完成');
        return sqlJsInstance!;
    } catch (error) {
        const err = error as Error;
        console.error('[DatabaseHelper] sql.js 加载/初始化失败:', err.message);
        console.error('[DatabaseHelper] sql.js 堆栈:', err.stack || '无');
        throw new Error(`sql.js 加载失败: ${err.message}`);
    }
}

/**
 * 数据库操作类
 */
export class DatabaseHelper {

    /**
     * 从数据库读取指定 key 的值
     */
    static async readFromDB(key: string): Promise<any | null> {
        const SQL = await initSqlJs();
        const dbPath = PathDetector.getDBPath();

        try {
            const dbBuffer = await fs.readFile(dbPath);
            const db = new SQL.Database(dbBuffer);

            try {
                const result = db.exec('SELECT value FROM ItemTable WHERE key = ?', [key]);

                if (result.length > 0 && result[0].values.length > 0) {
                    const value = result[0].values[0][0];

                    // 尝试解析 JSON
                    if (typeof value === 'string') {
                        try {
                            return JSON.parse(value);
                        } catch {
                            return value;
                        }
                    }
                    return value;
                }

                return null;
            } finally {
                db.close();
            }
        } catch (error) {
            console.error('[DatabaseHelper] 读取失败:', error);
            return null;
        }
    }

    /**
     * 写入数据到数据库
     */
    static async writeToDB(key: string, value: any): Promise<boolean> {
        const SQL = await initSqlJs();
        const dbPath = PathDetector.getDBPath();

        try {
            if (value === null || value === undefined) {
                throw new Error(`Cannot write null/undefined value to key: ${key}`);
            }

            const dbBuffer = await fs.readFile(dbPath);
            const db = new SQL.Database(dbBuffer);

            try {
                let finalValue: string;

                // 处理不同类型的值
                if (Buffer.isBuffer(value)) {
                    // Buffer 转为 JSON 格式
                    finalValue = JSON.stringify({
                        type: 'Buffer',
                        data: Array.from(value)
                    });
                } else if (value instanceof Uint8Array) {
                    // Uint8Array 转为 JSON 格式
                    finalValue = JSON.stringify({
                        type: 'Buffer',
                        data: Array.from(value)
                    });
                } else if (typeof value === 'object') {
                    finalValue = JSON.stringify(value);
                } else {
                    finalValue = String(value);
                }

                // 执行插入或更新
                db.run('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)', [key, finalValue]);

                // 导出并写回文件
                const data = db.export();
                await fs.writeFile(dbPath, Buffer.from(data));

                console.log(`[DatabaseHelper] 已写入: ${key}`);
                return true;
            } finally {
                db.close();
            }
        } catch (error) {
            console.error('[DatabaseHelper] 写入失败:', error);
            throw error;
        }
    }

    /**
     * 删除数据库中的指定 key
     */
    static async deleteFromDB(key: string): Promise<boolean> {
        const SQL = await initSqlJs();
        const dbPath = PathDetector.getDBPath();

        try {
            const dbBuffer = await fs.readFile(dbPath);
            const db = new SQL.Database(dbBuffer);

            try {
                db.run('DELETE FROM ItemTable WHERE key = ?', [key]);

                const data = db.export();
                await fs.writeFile(dbPath, Buffer.from(data));

                console.log(`[DatabaseHelper] 已删除: ${key}`);
                return true;
            } finally {
                db.close();
            }
        } catch (error) {
            console.error('[DatabaseHelper] 删除失败:', error);
            return false;
        }
    }

    /**
     * 批量删除匹配模式的 keys
     */
    static async deleteByPattern(pattern: string): Promise<number> {
        const SQL = await initSqlJs();
        const dbPath = PathDetector.getDBPath();

        try {
            const dbBuffer = await fs.readFile(dbPath);
            const db = new SQL.Database(dbBuffer);

            try {
                // 先查询匹配的 keys
                const result = db.exec(`SELECT key FROM ItemTable WHERE key LIKE ?`, [pattern]);
                let deletedCount = 0;

                if (result.length > 0 && result[0].values.length > 0) {
                    for (const row of result[0].values) {
                        db.run('DELETE FROM ItemTable WHERE key = ?', [row[0]]);
                        deletedCount++;
                    }
                }

                const data = db.export();
                await fs.writeFile(dbPath, Buffer.from(data));

                console.log(`[DatabaseHelper] 删除了 ${deletedCount} 条记录 (pattern: ${pattern})`);
                return deletedCount;
            } finally {
                db.close();
            }
        } catch (error) {
            console.error('[DatabaseHelper] 批量删除失败:', error);
            return 0;
        }
    }

    /**
     * 备份数据库
     */
    static async backupDB(): Promise<string | null> {
        const dbPath = PathDetector.getDBPath();
        const backupPath = `${dbPath}.backup.${Date.now()}`;

        try {
            await fs.copyFile(dbPath, backupPath);
            console.log(`[DatabaseHelper] 数据库已备份: ${backupPath}`);
            return backupPath;
        } catch (error) {
            console.error('[DatabaseHelper] 备份失败:', error);
            return null;
        }
    }
}
