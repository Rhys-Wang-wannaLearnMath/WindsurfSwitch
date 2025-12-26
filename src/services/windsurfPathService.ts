import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class WindsurfPathService {
    /**
     * 获取 Windsurf 扩展文件路径
     * @returns Windsurf extension.js 文件路径，如果未找到返回 null
     */
    static getExtensionPath(): string | null {
        console.log('[WindsurfPathService] 开始检测 Windsurf 扩展路径...');
        
        try {
            const appRoot = vscode.env.appRoot;
            console.log(`[WindsurfPathService] VSCode appRoot: ${appRoot}`);
            console.log(`[WindsurfPathService] 操作系统: ${this.getOSType()}`);
            
            if (!appRoot) {
                console.warn('[WindsurfPathService] VSCode appRoot 未找到');
                return null;
            }

            // 尝试多种可能的路径
            const possiblePaths = this.getPossibleExtensionPaths(appRoot);
            
            for (let i = 0; i < possiblePaths.length; i++) {
                const extensionPath = possiblePaths[i];
                console.log(`[WindsurfPathService] 尝试路径 ${i + 1}/${possiblePaths.length}: ${extensionPath}`);
                
                const exists = fs.existsSync(extensionPath);
                console.log(`[WindsurfPathService] 路径 ${i + 1} ${exists ? '存在' : '不存在'}`);
                
                if (exists) {
                    // 获取文件信息
                    try {
                        const stats = fs.statSync(extensionPath);
                        console.log(`[WindsurfPathService] 文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                        console.log(`[WindsurfPathService] 修改时间: ${stats.mtime.toISOString()}`);
                        console.log(`[WindsurfPathService] 找到 Windsurf 扩展: ${extensionPath}`);
                    } catch (statError) {
                        console.warn('[WindsurfPathService] 无法获取文件统计信息:', statError);
                    }
                    
                    return extensionPath;
                }
            }
            
            console.error('[WindsurfPathService] 所有可能的路径都不存在');
            return null;
            
        } catch (error) {
            console.error('[WindsurfPathService] 获取 Windsurf 扩展路径失败:', error);
            return null;
        }
    }

    /**
     * 获取所有可能的扩展路径
     * @param appRoot VSCode 应用根目录
     * @returns 可能的扩展路径数组
     */
    private static getPossibleExtensionPaths(appRoot: string): string[] {
        const osType = this.getOSType();
        const paths: string[] = [];

        // 1. 标准路径 (所有平台通用)
        paths.push(path.join(appRoot, 'extensions', 'windsurf', 'dist', 'extension.js'));

        // 2. 根据操作系统添加特定路径
        switch (osType) {
            case 'windows':
                // Windows 可能的路径
                const localAppData = process.env.LOCALAPPDATA || '';
                const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
                paths.push(
                    // 用户安装路径 (最常见)
                    path.join(localAppData, 'Programs', 'Windsurf', 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // 基于 appRoot 的路径
                    path.join(appRoot, 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // 系统安装路径
                    path.join(programFiles, 'Windsurf', 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // Portable 版本路径
                    path.join(appRoot, '..', 'data', 'extensions', 'windsurf', 'dist', 'extension.js')
                );
                break;

            case 'macos':
                // macOS 可能的路径
                // appRoot 在 Mac 上通常是 /Applications/Windsurf.app/Contents/Resources/app
                paths.push(
                    // 如果 appRoot 是 .app 目录本身
                    path.join(appRoot, 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // Windsurf Next 版本
                    '/Applications/Windsurf - Next.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
                    // Windsurf 标准版本
                    '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
                    // 用户目录下的 Applications
                    path.join(process.env.HOME || '', 'Applications', 'Windsurf.app', 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    path.join(process.env.HOME || '', 'Applications', 'Windsurf - Next.app', 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js')
                );
                break;

            case 'linux':
                // Linux 可能的路径
                paths.push(
                    // 标准 Linux 路径
                    path.join(appRoot, 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // Snap 包路径
                    path.join(appRoot, '..', 'extensions', 'windsurf', 'dist', 'extension.js'),
                    // AppImage 路径
                    path.join(appRoot, 'usr', 'share', 'windsurf', 'extensions', 'windsurf', 'dist', 'extension.js')
                );
                break;
        }

        // 3. 添加一些通用的备用路径
        const parentDir = path.dirname(appRoot);
        paths.push(
            path.join(parentDir, 'extensions', 'windsurf', 'dist', 'extension.js'),
            path.join(parentDir, 'windsurf', 'extensions', 'windsurf', 'dist', 'extension.js'),
            path.join(appRoot, '..', 'extensions', 'windsurf', 'dist', 'extension.js')
        );

        // 去重并返回
        return [...new Set(paths)];
    }

    /**
     * 获取操作系统类型
     * @returns 操作系统类型
     */
    private static getOSType(): 'windows' | 'macos' | 'linux' {
        const platform = process.platform;
        
        switch (platform) {
            case 'win32':
                return 'windows';
            case 'darwin':
                return 'macos';
            case 'linux':
                return 'linux';
            default:
                // 默认按 Linux 处理
                return 'linux';
        }
    }

    /**
     * 检查文件是否可读
     * @param filePath 文件路径
     * @returns 是否可读
     */
    static isFileAccessible(filePath: string): boolean {
        console.log(`[WindsurfPathService] 检查文件读取权限: ${filePath}`);
        
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
            console.log('[WindsurfPathService] 文件可读');
            return true;
        } catch (error) {
            console.error('[WindsurfPathService] 文件不可读:', error);
            return false;
        }
    }

    /**
     * 检查文件是否可写
     * @param filePath 文件路径
     * @returns 是否可写
     */
    static isFileWritable(filePath: string): boolean {
        console.log(`[WindsurfPathService] 检查文件写入权限: ${filePath}`);
        
        try {
            fs.accessSync(filePath, fs.constants.W_OK);
            console.log('[WindsurfPathService] 文件可写');
            return true;
        } catch (error) {
            console.error('[WindsurfPathService] 文件不可写:', error);
            return false;
        }
    }

    /**
     * 获取权限修复建议
     * @param filePath 文件路径
     * @returns 权限修复建议
     */
    static getPermissionFixSuggestion(filePath: string): string {
        const osType = this.getOSType();
        
        switch (osType) {
            case 'windows':
                return `请以管理员身份运行 VSCode 或 Windsurf，或者手动修改文件权限：\n右键点击文件 → 属性 → 安全 → 编辑权限`;
            
            case 'macos':
            case 'linux':
                return `请在终端中运行以下命令修改权限：\nsudo chmod +w "${filePath}"`;
            
            default:
                return `请检查文件权限并确保有写入权限：${filePath}`;
        }
    }
}
