/**
 * machineIdReset.ts - 机器 ID 重置模块
 * 生成并更新 Windsurf 机器标识符
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { PathDetector } from './pathDetector';

/**
 * 机器 ID 结构
 */
export interface MachineIds {
    machineId: string;
    macMachineId: string;
    sqmId: string;
    devDeviceId: string;
    serviceMachineId: string;
}

/**
 * 机器 ID 重置器
 */
export class MachineIdResetter {

    /**
     * 生成新的机器 ID
     */
    static generateMachineIds(): MachineIds {
        return {
            machineId: crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
            macMachineId: crypto.createHash('sha512').update(crypto.randomBytes(64)).digest('hex'),
            sqmId: `{${uuidv4().toUpperCase()}}`,
            devDeviceId: uuidv4(),
            serviceMachineId: uuidv4()
        };
    }

    /**
     * 重置机器 ID
     * 更新 storage.json 中的机器标识符
     */
    static async resetMachineId(): Promise<MachineIds> {
        const storagePath = PathDetector.getStorageJsonPath();
        const ids = this.generateMachineIds();

        try {
            // 读取 storage.json
            let storageData: Record<string, any> = {};
            try {
                const content = await fs.readFile(storagePath, 'utf-8');
                storageData = JSON.parse(content);
            } catch {
                console.log('[MachineIdResetter] storage.json 不存在或格式错误，创建新文件');
            }

            // 更新机器 ID 字段
            storageData['telemetry.machineId'] = ids.machineId;
            storageData['telemetry.sqmId'] = ids.sqmId;
            storageData['telemetry.devDeviceId'] = ids.devDeviceId;

            // macOS 特有字段
            if (process.platform === 'darwin') {
                storageData['telemetry.macMachineId'] = ids.macMachineId;
            }

            // 写回 storage.json（带重试）
            const maxRetries = 3;
            let lastError: Error | null = null;

            for (let i = 0; i < maxRetries; i++) {
                try {
                    if (i > 0) {
                        await new Promise(resolve => setTimeout(resolve, 500 * (i + 1)));
                    }
                    await fs.writeFile(storagePath, JSON.stringify(storageData, null, 2));
                    console.log('[MachineIdResetter] storage.json 已更新');
                    lastError = null;
                    break;
                } catch (error) {
                    lastError = error as Error;
                    console.warn(`[MachineIdResetter] 写入失败 (${i + 1}/${maxRetries}):`, lastError.message);
                }
            }

            if (lastError) {
                throw lastError;
            }

            return ids;
        } catch (error) {
            throw new Error(`重置机器 ID 失败: ${(error as Error).message}`);
        }
    }
}
