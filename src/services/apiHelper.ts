/**
 * apiHelper.ts - API 请求模块
 * 使用 Cloudflare Workers 中转访问 Firebase API
 * 通过邮箱密码登录获取完整的 Token 信息
 */

import * as https from 'https';

/**
 * API 常量配置
 */
const CONSTANTS = {
    // Cloudflare Worker 中转地址
    WORKER_URL: 'https://windsurf.hfhddfj.cn',

    // Firebase API Key
    FIREBASE_API_KEY: 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY',

    // Windsurf 注册 API
    WINDSURF_REGISTER_API: 'https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser',

    // 请求超时时间 (ms)
    REQUEST_TIMEOUT: 30000
};

/**
 * 登录结果
 */
export interface LoginResult {
    success: boolean;
    error?: string;
    email?: string;
    name?: string;
    apiKey?: string;
    apiServerUrl?: string;
    refreshToken?: string;
    idToken?: string;
    idTokenExpiresAt?: number;
}

/**
 * HTTP 请求辅助函数
 */
async function httpPost(url: string, data: any, headers: Record<string, string> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const postData = JSON.stringify(data);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...headers
            },
            timeout: CONSTANTS.REQUEST_TIMEOUT
        };

        const req = https.request(options, (res) => {
            let body = '';

            res.on('data', (chunk) => {
                body += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
                    }
                } catch {
                    reject(new Error(`Invalid JSON response: ${body.substring(0, 100)}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(postData);
        req.end();
    });
}

/**
 * API 辅助类
 */
export class ApiHelper {
    private logCallback?: (message: string) => void;

    constructor(logCallback?: (message: string) => void) {
        this.logCallback = logCallback;
    }

    /**
     * 输出日志
     */
    private log(message: string): void {
        console.log(message);
        if (this.logCallback) {
            this.logCallback(message);
        }
    }

    /**
     * 使用邮箱密码登录获取 Firebase Token
     */
    async loginWithEmailPassword(email: string, password: string): Promise<{
        idToken: string;
        refreshToken: string;
        expiresIn: number;
    }> {
        try {
            const response = await httpPost(
                `${CONSTANTS.WORKER_URL}/login`,
                {
                    email: email,
                    password: password,
                    api_key: CONSTANTS.FIREBASE_API_KEY
                }
            );

            return {
                idToken: response.idToken,
                refreshToken: response.refreshToken,
                expiresIn: parseInt(response.expiresIn || '3600')
            };
        } catch (error) {
            const err = error as Error;

            if (err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED')) {
                throw new Error('无法连接到中转服务器，请检查网络连接');
            }

            if (err.message.includes('EMAIL_NOT_FOUND')) {
                throw new Error('邮箱不存在');
            } else if (err.message.includes('INVALID_PASSWORD') || err.message.includes('INVALID_LOGIN_CREDENTIALS')) {
                throw new Error('邮箱或密码错误');
            } else if (err.message.includes('USER_DISABLED')) {
                throw new Error('账号已被禁用');
            } else if (err.message.includes('TOO_MANY_ATTEMPTS')) {
                throw new Error('尝试次数过多，请稍后再试');
            }

            throw err;
        }
    }

    /**
     * 使用 idToken 获取 API Key
     */
    async getApiKey(idToken: string): Promise<{
        apiKey: string;
        name: string;
        apiServerUrl: string;
    }> {
        try {
            const response = await httpPost(
                CONSTANTS.WINDSURF_REGISTER_API,
                {
                    firebase_id_token: idToken
                }
            );

            return {
                apiKey: response.api_key,
                name: response.name,
                apiServerUrl: response.api_server_url
            };
        } catch (error) {
            const err = error as Error;

            if (err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT')) {
                throw new Error('无法连接到 Windsurf 服务器');
            }

            throw err;
        }
    }

    /**
     * 完整登录流程：邮箱密码 -> Token -> API Key
     */
    async login(email: string, password: string): Promise<LoginResult> {
        try {
            this.log('开始登录...');
            this.log(`账号: ${email}`);

            // 步骤 1: Firebase 登录
            this.log('正在验证账号...');
            const firebaseResult = await this.loginWithEmailPassword(email, password);
            this.log('账号验证成功');

            // 步骤 2: 获取 API Key
            this.log('正在获取 API Key...');
            const apiKeyResult = await this.getApiKey(firebaseResult.idToken);
            this.log(`API Key 获取成功: ${apiKeyResult.name}`);

            return {
                success: true,
                email: email,
                name: apiKeyResult.name,
                apiKey: apiKeyResult.apiKey,
                apiServerUrl: apiKeyResult.apiServerUrl,
                refreshToken: firebaseResult.refreshToken,
                idToken: firebaseResult.idToken,
                idTokenExpiresAt: Date.now() + (firebaseResult.expiresIn * 1000)
            };

        } catch (error) {
            const err = error as Error;
            this.log(`登录失败: ${err.message}`);

            return {
                success: false,
                error: err.message
            };
        }
    }

    /**
     * 使用 refreshToken 刷新 token
     */
    async refreshTokens(refreshToken: string): Promise<{
        idToken: string;
        refreshToken: string;
        expiresIn: number;
    }> {
        try {
            const response = await httpPost(
                CONSTANTS.WORKER_URL,
                {
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    api_key: CONSTANTS.FIREBASE_API_KEY
                }
            );

            return {
                idToken: response.id_token,
                refreshToken: response.refresh_token || refreshToken,
                expiresIn: parseInt(response.expires_in || '3600')
            };
        } catch (error) {
            throw new Error(`刷新 Token 失败: ${(error as Error).message}`);
        }
    }
}
