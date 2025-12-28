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
    // 检测关键字 - 用于验证补丁是否已应用
    private static readonly PATCH_KEYWORD_1 = "windsurf.provideAuthTokenToAuthProviderWithShit";
    private static readonly PATCH_KEYWORD_2 = "handleAuthTokenWithShit";

    // 原始的 handleAuthToken 函数 (Windsurf 1.106.0)
    private static readonly ORIGINAL_HANDLE_AUTH_TOKEN = 'async handleAuthToken(A){const e=await(0,E.registerUser)(A),{apiKey:t,name:i}=e,g=(0,B.getApiServerUrl)(e.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty api_key");if(!i)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty name");const I={id:(0,n.v4)(),accessToken:t,account:{label:i,id:i},scopes:[]};return await this.context.secrets.store(u.sessionsSecretKey,JSON.stringify([I])),await this.context.globalState.update("apiServerUrl",g),(0,o.isString)(g)&&!(0,o.isEmpty)(g)&&g!==r.LanguageServerClient.getInstance().apiServerUrl&&await r.LanguageServerClient.getInstance().restart(g),this._sessionChangeEmitter.fire({added:[I],removed:[],changed:[]}),I}';

    // 新的 handleAuthTokenWithShit 函数 (Windsurf 1.106.0)
    private static readonly NEW_HANDLE_AUTH_TOKEN_WITH_SHIT = 'async handleAuthTokenWithShit(A){const{apiKey:t,name:g}=A,i=(0,B.getApiServerUrl)(A.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty api_key");if(!g)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty name");const I={id:(0,n.v4)(),accessToken:t,account:{label:g,id:g},scopes:[]};return await this.context.secrets.store(u.sessionsSecretKey,JSON.stringify([I])),await this.context.globalState.update("apiServerUrl",i),(0,o.isString)(i)&&!(0,o.isEmpty)(i)&&i!==r.LanguageServerClient.getInstance().apiServerUrl&&await r.LanguageServerClient.getInstance().restart(i),this._sessionChangeEmitter.fire({added:[I],removed:[],changed:[]}),I}';

    // 原始的命令注册
    private static readonly ORIGINAL_COMMAND_REGISTRATION = "A.subscriptions.push(s.commands.registerCommand(t.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,async A=>{try{return{session:await e.handleAuthToken(A),error:void 0}}catch(A){return A instanceof a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata.getInstance().errorCodes.GENERIC_ERROR}}}),s.commands.registerCommand(t.LOGIN_WITH_REDIRECT,async(A,e)=>{(N||S)&&await G(),N=void 0;const t=(0,m.getAuthSession)({promptLoginIfNone:!0,shouldRegisterNewUser:A,fromOnboarding:e}).catch(A=>{if(!k(A))throw(0,u.sentryCaptureException)(A),console.error(\"Error during login with redirect:\",A),A});N=t;try{return await t}finally{N===t&&(N=void 0)}}),s.commands.registerCommand(t.LOGIN_WITH_AUTH_TOKEN,(acc)=>{acc?e.handleAuthToken(acc):e.provideAuthToken()}),s.commands.registerCommand(t.CANCEL_LOGIN,()=>G()),s.commands.registerCommand(t.LOGOUT,async()=>{const A=w.WindsurfAuthProvider.getInstance(),e=await A.getSessions();e.length>0&&await A.removeSession(e[0].id)})),";

    // 新的命令注册
    private static readonly NEW_COMMAND_REGISTRATION = 'A.subscriptions.push(s.commands.registerCommand("windsurf.provideAuthTokenToAuthProviderWithShit",async A=>{try{return{session:await e.handleAuthTokenWithShit(A),error:void 0}}catch(A){return A instanceof a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata.getInstance().errorCodes.GENERIC_ERROR}}})),';

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

    private static tryInsertHandleAuthTokenFallback(fileContent: string): { updated: boolean; content: string } {
        const matchIndex = fileContent.indexOf('async handleAuthToken(');
        if (matchIndex === -1) {
            return { updated: false, content: fileContent };
        }

        const openBraceIndex = fileContent.indexOf('{', matchIndex);
        if (openBraceIndex === -1) {
            return { updated: false, content: fileContent };
        }

        const closeBraceIndex = this.findMatchingBrace(fileContent, openBraceIndex);
        if (closeBraceIndex === -1) {
            return { updated: false, content: fileContent };
        }

        const insertPosition = closeBraceIndex + 1;
        const updatedContent =
            fileContent.substring(0, insertPosition) +
            this.NEW_HANDLE_AUTH_TOKEN_WITH_SHIT +
            fileContent.substring(insertPosition);

        return { updated: true, content: updatedContent };
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
     * 检查补丁是否已应用
     * @returns 是否已应用补丁
     */
    static async isPatchApplied(): Promise<boolean> {
        console.log('[WindsurfPatchService] 开始检查补丁是否已应用...');

        try {
            const extensionPath = WindsurfPathService.getExtensionPath();
            if (!extensionPath) {
                console.warn('[WindsurfPatchService] 无法获取 Windsurf 扩展路径，补丁检查失败');
                return false;
            }

            console.log('[WindsurfPatchService] 读取扩展文件内容...');
            const fileContent = fs.readFileSync(extensionPath, 'utf-8');
            console.log(`[WindsurfPatchService] 文件内容长度: ${fileContent.length} 字符`);

            console.log(`[WindsurfPatchService] 检查关键字1: "${this.PATCH_KEYWORD_1}"`);
            const hasKeyword1 = fileContent.includes(this.PATCH_KEYWORD_1);
            console.log(`[WindsurfPatchService] 关键字1 ${hasKeyword1 ? '已找到' : '未找到'}`);

            console.log(`[WindsurfPatchService] 检查关键字2: "${this.PATCH_KEYWORD_2}"`);
            const hasKeyword2 = fileContent.includes(this.PATCH_KEYWORD_2);
            console.log(`[WindsurfPatchService] 关键字2 ${hasKeyword2 ? '已找到' : '未找到'}`);

            const isApplied = hasKeyword1 && hasKeyword2;
            console.log(`[WindsurfPatchService] 补丁${isApplied ? '已应用' : '未应用'}`);

            return isApplied;
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
     * 应用补丁
     * @returns 补丁应用结果
     */
    static async applyPatch(): Promise<PatchResult> {
        console.log('[WindsurfPatchService] 开始应用补丁...');

        try {
            const extensionPath = WindsurfPathService.getExtensionPath();
            if (!extensionPath) {
                console.error('[WindsurfPatchService] Windsurf 安装未找到');
                return {
                    success: false,
                    error: "Windsurf installation not found"
                };
            }

            // 检查权限
            console.log('[WindsurfPatchService] 检查权限...');
            const permissionCheck = this.checkWritePermission();
            if (!permissionCheck.hasPermission) {
                console.error('[WindsurfPatchService] 权限不足');
                return {
                    success: false,
                    error: permissionCheck.error
                };
            }

            // 读取原始文件
            console.log('[WindsurfPatchService] 读取原始文件...');
            let fileContent = fs.readFileSync(extensionPath, 'utf-8');
            console.log(`[WindsurfPatchService] 原始文件大小: ${fileContent.length} 字符`);

            // 1. 添加新的 handleAuthTokenWithShit 函数
            if (!fileContent.includes(this.PATCH_KEYWORD_2)) {
                console.log('[WindsurfPatchService] 查找 handleAuthToken 函数...');
                const handleAuthTokenIndex = fileContent.indexOf(this.ORIGINAL_HANDLE_AUTH_TOKEN);
                if (handleAuthTokenIndex !== -1) {
                    console.log(`[WindsurfPatchService] 找到 handleAuthToken 函数（精确匹配），位置: ${handleAuthTokenIndex}`);

                    const insertPosition1 = handleAuthTokenIndex + this.ORIGINAL_HANDLE_AUTH_TOKEN.length;
                    console.log('[WindsurfPatchService] 插入新的 handleAuthTokenWithShit 函数...');
                    fileContent = fileContent.substring(0, insertPosition1) +
                        this.NEW_HANDLE_AUTH_TOKEN_WITH_SHIT +
                        fileContent.substring(insertPosition1);
                    console.log(`[WindsurfPatchService] 插入函数后文件大小: ${fileContent.length} 字符`);
                } else {
                    console.log('[WindsurfPatchService] 精确匹配失败，尝试兼容模式插入 handleAuthTokenWithShit...');
                    const fallback = this.tryInsertHandleAuthTokenFallback(fileContent);
                    if (!fallback.updated) {
                        console.error('[WindsurfPatchService] 未找到 handleAuthToken 函数');
                        return {
                            success: false,
                            error: "Could not find handleAuthToken function. Windsurf version may be incompatible.\n\nThe expected function signature was not found in extension.js."
                        };
                    }
                    fileContent = fallback.content;
                    console.log(`[WindsurfPatchService] 兼容模式插入函数后文件大小: ${fileContent.length} 字符`);
                }
            } else {
                console.log('[WindsurfPatchService] handleAuthTokenWithShit 已存在，跳过插入函数');
            }

            // 2. 添加新的命令注册
            if (!fileContent.includes(this.PATCH_KEYWORD_1)) {
                console.log('[WindsurfPatchService] 查找命令注册...');
                const commandRegistrationIndex = fileContent.indexOf(this.ORIGINAL_COMMAND_REGISTRATION);
                if (commandRegistrationIndex !== -1) {
                    console.log(`[WindsurfPatchService] 找到命令注册（精确匹配），位置: ${commandRegistrationIndex}`);

                    const insertPosition2 = commandRegistrationIndex + this.ORIGINAL_COMMAND_REGISTRATION.length;
                    console.log('[WindsurfPatchService] 插入新的命令注册...');
                    fileContent = fileContent.substring(0, insertPosition2) +
                        this.NEW_COMMAND_REGISTRATION +
                        fileContent.substring(insertPosition2);
                    console.log(`[WindsurfPatchService] 插入命令后文件大小: ${fileContent.length} 字符`);
                } else {
                    console.log('[WindsurfPatchService] 精确匹配失败，尝试兼容模式插入命令注册...');
                    const fallback = this.tryInsertCommandRegistrationFallback(fileContent);
                    if (!fallback.updated) {
                        console.error('[WindsurfPatchService] 未找到可插入命令注册的位置');
                        return {
                            success: false,
                            error: "Could not find PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER command registration. Windsurf version may be incompatible.\n\nThe expected command registration was not found in extension.js."
                        };
                    }
                    fileContent = fallback.content;
                    console.log(`[WindsurfPatchService] 兼容模式插入命令后文件大小: ${fileContent.length} 字符`);
                }
            } else {
                console.log('[WindsurfPatchService] windsurf.provideAuthTokenToAuthProviderWithShit 已存在，跳过插入命令');
            }

            // 写入修改后的文件
            console.log('[WindsurfPatchService] 写入修改后的文件...');
            fs.writeFileSync(extensionPath, fileContent, 'utf-8');
            console.log('[WindsurfPatchService] 文件写入完成');

            // 验证补丁是否成功应用
            console.log('[WindsurfPatchService] 验证补丁是否成功应用...');
            const verificationContent = fs.readFileSync(extensionPath, 'utf-8');
            const hasKeyword1 = verificationContent.includes(this.PATCH_KEYWORD_1);
            const hasKeyword2 = verificationContent.includes(this.PATCH_KEYWORD_2);

            console.log(`[WindsurfPatchService] 验证关键字1: ${hasKeyword1 ? '存在' : '不存在'}`);
            console.log(`[WindsurfPatchService] 验证关键字2: ${hasKeyword2 ? '存在' : '不存在'}`);

            if (hasKeyword1 && hasKeyword2) {
                console.log('[WindsurfPatchService] 补丁应用成功');
                return {
                    success: true
                };
            } else {
                console.error('[WindsurfPatchService] 补丁验证失败');
                return {
                    success: false,
                    error: "补丁验证失败。补丁应用后未找到关键字。"
                };
            }

        } catch (error) {
            console.error('[WindsurfPatchService] 补丁应用失败:', error);
            return {
                success: false,
                error: `补丁失败: ${error instanceof Error ? error.message : '未知错误'}`
            };
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
