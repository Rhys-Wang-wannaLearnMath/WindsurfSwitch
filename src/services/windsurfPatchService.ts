import * as fs from 'fs';
import { WindsurfPathService } from './windsurfPathService';

export interface PatchResult {
    success: boolean;
    error?: string;
}

export interface PatchCheckResult {
    needsRestart: boolean;
    error?: string;
}

export interface PermissionCheckResult {
    hasPermission: boolean;
    error?: string;
}

export class WindsurfPatchService {
    // 检测关键字
    private static readonly PATCH_KEYWORD_1 = "windsurf.provideAuthTokenToAuthProviderWithShit";
    private static readonly PATCH_KEYWORD_2 = "handleAuthTokenWithShit";
    // 版本标记 - 用于检测补丁是否需要更新
    private static readonly PATCH_VERSION_MARKER = "/*WSPATCH_V3*/";

    private static findMatchingParen(source: string, openParenIndex: number): number {
        let depth = 0;
        let inSingle = false;
        let inDouble = false;
        let inTemplate = false;
        let escaped = false;

        for (let i = openParenIndex; i < source.length; i++) {
            const ch = source[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '\\') {
                escaped = true;
                continue;
            }

            if (inSingle) {
                if (ch === "'") inSingle = false;
                continue;
            }
            if (inDouble) {
                if (ch === '"') inDouble = false;
                continue;
            }
            if (inTemplate) {
                if (ch === '`') inTemplate = false;
                continue;
            }

            if (ch === "'") {
                inSingle = true;
                continue;
            }
            if (ch === '"') {
                inDouble = true;
                continue;
            }
            if (ch === '`') {
                inTemplate = true;
                continue;
            }

            if (ch === '(') depth++;
            else if (ch === ')') {
                depth--;
                if (depth === 0) return i;
            }
        }

        return -1;
    }

    private static findMatchingBrace(source: string, openBraceIndex: number): number {
        let depth = 0;
        let inSingle = false;
        let inDouble = false;
        let inTemplate = false;
        let escaped = false;

        for (let i = openBraceIndex; i < source.length; i++) {
            const ch = source[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '\\') {
                escaped = true;
                continue;
            }

            if (inSingle) {
                if (ch === "'") inSingle = false;
                continue;
            }
            if (inDouble) {
                if (ch === '"') inDouble = false;
                continue;
            }
            if (inTemplate) {
                if (ch === '`') inTemplate = false;
                continue;
            }

            if (ch === "'") {
                inSingle = true;
                continue;
            }
            if (ch === '"') {
                inDouble = true;
                continue;
            }
            if (ch === '`') {
                inTemplate = true;
                continue;
            }

            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }

        return -1;
    }

    /**
     * 提取 handleAuthToken 函数的完整源码和位置
     */
    private static extractFunction(fileContent: string, funcName: string): { source: string; start: number; end: number } | null {
        const matchIndex = fileContent.indexOf(`async ${funcName}(`);
        if (matchIndex === -1) { return null; }

        const openBraceIndex = fileContent.indexOf('{', matchIndex);
        if (openBraceIndex === -1) { return null; }

        const closeBraceIndex = this.findMatchingBrace(fileContent, openBraceIndex);
        if (closeBraceIndex === -1) { return null; }

        return {
            source: fileContent.substring(matchIndex, closeBraceIndex + 1),
            start: matchIndex,
            end: closeBraceIndex + 1
        };
    }

    /**
     * 动态生成 handleAuthTokenWithShit：
     * 从当前 handleAuthToken 复制，去掉 registerUser 调用，直接从参数中提取 apiKey/name
     */
    private static generateDynamicPatch(fileContent: string): string | null {
        const extracted = this.extractFunction(fileContent, 'handleAuthToken');
        if (!extracted) {
            console.error('[WindsurfPatchService] 未找到 handleAuthToken 函数');
            return null;
        }

        let func = extracted.source;
        console.log(`[WindsurfPatchService] 提取到 handleAuthToken, 长度: ${func.length}`);

        // 改函数名
        func = func.replace('async handleAuthToken(', 'async handleAuthTokenWithShit(');

        // 匹配 registerUser 调用模式:
        // const <resultVar>=await(0,<module>.registerUser)(<param>),{apiKey:<v1>,name:<v2>}=<resultVar>
        const registerUserRegex = /const (\w+)=await\(0,\w+\.registerUser\)\((\w+)\),\{apiKey:(\w+),name:(\w+)\}=\1/;
        const match = func.match(registerUserRegex);

        if (!match) {
            console.error('[WindsurfPatchService] 未匹配到 registerUser 模式');
            return null;
        }

        const resultVar = match[1]; // e.g. 'e'
        const paramName = match[2]; // e.g. 'A'
        console.log(`[WindsurfPatchService] registerUser 变量: result=${resultVar}, param=${paramName}, apiKey=${match[3]}, name=${match[4]}`);

        // 替换: 去掉 registerUser, 直接从参数解构
        func = func.replace(
            registerUserRegex,
            `const {apiKey:${match[3]},name:${match[4]}}=${paramName}`
        );

        // 替换 resultVar.apiServerUrl → paramName.apiServerUrl
        const apiServerUrlRegex = new RegExp(`\\b${resultVar}\\.apiServerUrl\\b`, 'g');
        func = func.replace(apiServerUrlRegex, `${paramName}.apiServerUrl`);

        // 在函数体开头插入版本标记
        func = func.replace('{', `{${this.PATCH_VERSION_MARKER}`);

        console.log(`[WindsurfPatchService] 生成的补丁函数长度: ${func.length}`);
        return func;
    }

    private static findCommandRegistrationPushCall(fileContent: string): { openParenIndex: number; closeParenIndex: number; args: string } | null {
        let searchIndex = 0;
        while (true) {
            const pushStart = fileContent.indexOf('.subscriptions.push(', searchIndex);
            if (pushStart === -1) return null;

            const openParenIndex = fileContent.indexOf('(', pushStart);
            if (openParenIndex === -1) return null;

            const closeParenIndex = this.findMatchingParen(fileContent, openParenIndex);
            if (closeParenIndex === -1) return null;

            const args = fileContent.substring(openParenIndex + 1, closeParenIndex);
            if (args.includes('.commands.registerCommand') && args.includes('handleAuthToken')) {
                return { openParenIndex, closeParenIndex, args };
            }

            searchIndex = closeParenIndex + 1;
        }
    }

    private static tryInsertCommandRegistrationFallback(fileContent: string): { updated: boolean; content: string } {
        const pushCall = this.findCommandRegistrationPushCall(fileContent);
        if (!pushCall) {
            return { updated: false, content: fileContent };
        }

        const vscodeVarMatch = pushCall.args.match(/\b([A-Za-z_$][\w$]*)\.commands\.registerCommand\b/);
        const authVarMatch = pushCall.args.match(/\b([A-Za-z_$][\w$]*)\.handleAuthToken\(/);
        if (!vscodeVarMatch || !authVarMatch) {
            return { updated: false, content: fileContent };
        }

        const vscodeVar = vscodeVarMatch[1];
        const authVar = authVarMatch[1];

        const injected = `${vscodeVar}.commands.registerCommand("${this.PATCH_KEYWORD_1}",async A=>await ${authVar}.handleAuthTokenWithShit(A))`;

        const updatedContent =
            fileContent.substring(0, pushCall.closeParenIndex) +
            ',' +
            injected +
            fileContent.substring(pushCall.closeParenIndex);

        return { updated: true, content: updatedContent };
    }

    /**
     * 检查补丁是否已应用且为最新版本
     */
    static async isPatchApplied(): Promise<boolean> {
        console.log('[WindsurfPatchService] 检查补丁状态...');

        try {
            const extensionPath = WindsurfPathService.getExtensionPath();
            if (!extensionPath) { return false; }

            const fileContent = fs.readFileSync(extensionPath, 'utf-8');

            const hasCommand = fileContent.includes(this.PATCH_KEYWORD_1);
            const hasFunction = fileContent.includes(this.PATCH_KEYWORD_2);
            const hasVersion = fileContent.includes(this.PATCH_VERSION_MARKER);

            console.log(`[WindsurfPatchService] 命令注册: ${hasCommand}, 函数: ${hasFunction}, 版本标记: ${hasVersion}`);

            // 必须三者都存在才算补丁已正确应用
            return hasCommand && hasFunction && hasVersion;
        } catch (error) {
            console.error('[WindsurfPatchService] 检查补丁状态失败:', error);
            return false;
        }
    }

    /**
     * 检查写入权限
     * @returns 权限检查结果
     */
    static checkWritePermission(): PermissionCheckResult {
        console.log('[WindsurfPatchService] 开始检查写入权限...');

        try {
            const extensionPath = WindsurfPathService.getExtensionPath();

            if (!extensionPath) {
                console.error('[WindsurfPatchService] Windsurf 安装未找到');
                return {
                    hasPermission: false,
                    error: "Windsurf installation not found. Please ensure Windsurf is installed."
                };
            }

            console.log('[WindsurfPatchService] 检查文件读取权限...');
            if (!WindsurfPathService.isFileAccessible(extensionPath)) {
                console.error('[WindsurfPatchService] 文件不可读');
                return {
                    hasPermission: false,
                    error: `Cannot read Windsurf extension file at: ${extensionPath}`
                };
            }

            console.log('[WindsurfPatchService] 检查文件写入权限...');
            if (!WindsurfPathService.isFileWritable(extensionPath)) {
                console.error('[WindsurfPatchService] 文件不可写');
                const suggestion = WindsurfPathService.getPermissionFixSuggestion(extensionPath);
                return {
                    hasPermission: false,
                    error: `Insufficient permissions to modify Windsurf extension at: ${extensionPath}\n\n${suggestion}`
                };
            }

            console.log('[WindsurfPatchService] 权限检查通过');
            return {
                hasPermission: true
            };
        } catch (error) {
            console.error('[WindsurfPatchService] 权限检查失败:', error);
            return {
                hasPermission: false,
                error: `权限检查失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }

    /**
     * 应用补丁 - 动态生成，自动适配 Windsurf 版本
     */
    static async applyPatch(): Promise<PatchResult> {
        console.log('[WindsurfPatchService] 开始应用补丁...');

        try {
            const extensionPath = WindsurfPathService.getExtensionPath();
            if (!extensionPath) {
                return { success: false, error: "Windsurf installation not found" };
            }

            const permissionCheck = this.checkWritePermission();
            if (!permissionCheck.hasPermission) {
                return { success: false, error: permissionCheck.error };
            }

            let fileContent = fs.readFileSync(extensionPath, 'utf-8');
            console.log(`[WindsurfPatchService] 文件大小: ${fileContent.length}`);
            let modified = false;

            // === 步骤 1: 处理 handleAuthTokenWithShit 函数 ===
            const hasUpToDatePatch = fileContent.includes(this.PATCH_VERSION_MARKER);

            if (!hasUpToDatePatch) {
                // 移除旧版本的补丁函数（如果存在）
                const existingPatch = this.extractFunction(fileContent, 'handleAuthTokenWithShit');
                if (existingPatch) {
                    console.log(`[WindsurfPatchService] 移除旧补丁函数 (位置: ${existingPatch.start}-${existingPatch.end})`);
                    fileContent = fileContent.substring(0, existingPatch.start) + fileContent.substring(existingPatch.end);
                }

                // 动态生成新补丁函数
                console.log('[WindsurfPatchService] 动态生成补丁函数...');
                const patchedFunc = this.generateDynamicPatch(fileContent);
                if (!patchedFunc) {
                    return {
                        success: false,
                        error: "无法从当前 handleAuthToken 生成补丁。Windsurf 版本可能不兼容。"
                    };
                }

                // 找到 handleAuthToken 并在其后插入
                const authTokenFunc = this.extractFunction(fileContent, 'handleAuthToken');
                if (!authTokenFunc) {
                    return { success: false, error: "未找到 handleAuthToken 函数" };
                }

                console.log(`[WindsurfPatchService] 在位置 ${authTokenFunc.end} 插入补丁函数`);
                fileContent = fileContent.substring(0, authTokenFunc.end) + patchedFunc + fileContent.substring(authTokenFunc.end);
                modified = true;
            } else {
                console.log('[WindsurfPatchService] 补丁函数已是最新版本');
            }

            // === 步骤 2: 处理命令注册 ===
            if (!fileContent.includes(this.PATCH_KEYWORD_1)) {
                console.log('[WindsurfPatchService] 插入命令注册...');
                const cmdResult = this.tryInsertCommandRegistrationFallback(fileContent);
                if (!cmdResult.updated) {
                    return { success: false, error: "未找到可插入命令注册的位置。Windsurf 版本可能不兼容。" };
                }
                fileContent = cmdResult.content;
                modified = true;
            } else {
                console.log('[WindsurfPatchService] 命令注册已存在');
            }

            // === 写入并验证 ===
            if (modified) {
                fs.writeFileSync(extensionPath, fileContent, 'utf-8');
                console.log('[WindsurfPatchService] 文件已写入');

                const verify = fs.readFileSync(extensionPath, 'utf-8');
                const ok = verify.includes(this.PATCH_KEYWORD_1) &&
                    verify.includes(this.PATCH_KEYWORD_2) &&
                    verify.includes(this.PATCH_VERSION_MARKER);

                if (!ok) {
                    return { success: false, error: "补丁验证失败" };
                }
            }

            console.log('[WindsurfPatchService] 补丁应用成功');
            return { success: true };

        } catch (error) {
            console.error('[WindsurfPatchService] 补丁应用失败:', error);
            return { success: false, error: `补丁失败: ${error instanceof Error ? error.message : '未知错误'}` };
        }
    }

    /**
     * 检查并应用补丁（如果需要）
     * @returns 检查结果
     */
    static async checkAndApplyPatch(): Promise<PatchCheckResult> {
        console.log('[WindsurfPatchService] 开始检查并应用补丁流程...');

        try {
            // 1. 检查补丁是否已应用
            console.log('[WindsurfPatchService] 步骤1: 检查补丁是否已应用');
            if (await this.isPatchApplied()) {
                console.log('[WindsurfPatchService] 补丁已应用，无需重新应用');
                return {
                    needsRestart: false
                };
            }

            console.log('[WindsurfPatchService] 补丁未应用，需要应用补丁');

            // 2. 检查权限
            console.log('[WindsurfPatchService] 步骤2: 检查权限');
            const permissionCheck = this.checkWritePermission();
            if (!permissionCheck.hasPermission) {
                console.error('[WindsurfPatchService] 权限检查失败');
                return {
                    needsRestart: false,
                    error: permissionCheck.error || "Insufficient permissions to apply patch. Please check file permissions."
                };
            }

            console.log('[WindsurfPatchService] 权限检查通过');

            // 3. 应用补丁
            console.log('[WindsurfPatchService] 步骤3: 应用补丁');
            const patchResult = await this.applyPatch();
            if (patchResult.success) {
                console.log('[WindsurfPatchService] 补丁应用成功，需要重启 Windsurf');
                return {
                    needsRestart: true
                };
            } else {
                console.error('[WindsurfPatchService] 补丁应用失败');
                return {
                    needsRestart: false,
                    error: patchResult.error || "应用 Windsurf 补丁失败"
                };
            }

        } catch (error) {
            console.error('[WindsurfPatchService] 补丁检查/应用流程失败:', error);
            return {
                needsRestart: false,
                error: `补丁检查/应用失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
        }
    }
}
