/**
 * apiHelper.ts - API 请求模块
 * 使用 Cloudflare Workers 中转访问 Firebase API
 * 通过邮箱密码登录获取完整的 Token 信息
 */

import * as https from 'https';

function encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value >>> 0;
    while (v >= 0x80) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    bytes.push(v);
    return Buffer.from(bytes);
}

function decodeVarint(buf: Buffer, offset: number): { value: number; nextOffset: number } {
    let result = 0;
    let shift = 0;
    let i = offset;
    while (i < buf.length) {
        const b = buf[i];
        result |= (b & 0x7f) << shift;
        i++;
        if ((b & 0x80) === 0) {
            return { value: result >>> 0, nextOffset: i };
        }
        shift += 7;
        if (shift > 35) {
            throw new Error('Invalid varint');
        }
    }
    throw new Error('Truncated varint');
}

function encodeProtoStringField(fieldNo: number, value: string): Buffer {
    const tag = (fieldNo << 3) | 2;
    const tagBuf = encodeVarint(tag);
    const valueBuf = Buffer.from(value, 'utf8');
    const lenBuf = encodeVarint(valueBuf.length);
    return Buffer.concat([tagBuf, lenBuf, valueBuf]);
}

function parseProtoStringFields(buf: Buffer): Record<number, string> {
    const out: Record<number, string> = {};
    let off = 0;

    while (off < buf.length) {
        const tagInfo = decodeVarint(buf, off);
        const tag = tagInfo.value;
        off = tagInfo.nextOffset;

        const fieldNo = tag >>> 3;
        const wireType = tag & 0x7;

        if (wireType === 2) {
            const lenInfo = decodeVarint(buf, off);
            const len = lenInfo.value;
            off = lenInfo.nextOffset;
            const end = off + len;
            if (end > buf.length) {
                throw new Error('Truncated length-delimited field');
            }

            const slice = buf.subarray(off, end);
            out[fieldNo] = slice.toString('utf8');
            off = end;
            continue;
        }

        if (wireType === 0) {
            const v = decodeVarint(buf, off);
            off = v.nextOffset;
            continue;
        }

        if (wireType === 5) {
            off += 4;
            continue;
        }

        if (wireType === 1) {
            off += 8;
            continue;
        }

        throw new Error(`Unsupported wire type: ${wireType}`);
    }

    return out;
}

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
                let json: any = undefined;
                try {
                    json = JSON.parse(body);
                } catch {
                    json = undefined;
                }

                const statusCode = res.statusCode || 0;
                const isOk = statusCode >= 200 && statusCode < 300;

                if (isOk) {
                    if (json !== undefined) {
                        resolve(json);
                        return;
                    }
                    reject(new Error(`Invalid JSON response: ${body.substring(0, 200)}`));
                    return;
                }

                const messageFromJson = json?.error?.message || json?.message || json?.error || undefined;
                const messageFromBody = body ? body.substring(0, 200) : '';
                const message = messageFromJson || messageFromBody || `HTTP ${statusCode}`;
                reject(new Error(`${message} (HTTP ${statusCode})`));
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

async function httpPostProto(url: string, data: Buffer, headers: Record<string, string> = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);

        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/proto',
                'Content-Length': data.length,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...headers
            },
            timeout: CONSTANTS.REQUEST_TIMEOUT
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];

            res.on('data', (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });

            res.on('end', () => {
                const body = Buffer.concat(chunks);
                const statusCode = res.statusCode || 0;
                const isOk = statusCode >= 200 && statusCode < 300;

                if (isOk) {
                    resolve(body);
                    return;
                }

                const preview = body.length ? body.subarray(0, 200).toString('utf8') : '';
                reject(new Error(`${preview || 'HTTP ' + statusCode} (HTTP ${statusCode})`));
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.write(data);
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
                    api_key: CONSTANTS.FIREBASE_API_KEY,
                    apiKey: CONSTANTS.FIREBASE_API_KEY
                }
            );

            const idToken = response.idToken ?? response.id_token;
            const refreshToken = response.refreshToken ?? response.refresh_token;
            const expiresInRaw = response.expiresIn ?? response.expires_in;

            if (!idToken || typeof idToken !== 'string' || idToken.length < 20) {
                throw new Error('登录服务返回异常：缺少有效的 idToken');
            }

            return {
                idToken,
                refreshToken: refreshToken || '',
                expiresIn: parseInt(expiresInRaw || '3600')
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
            if (!idToken) {
                throw new Error('无法获取 API Key：idToken 为空');
            }

            const requestBody = encodeProtoStringField(1, idToken);
            const responseBody = await httpPostProto(
                CONSTANTS.WINDSURF_REGISTER_API,
                requestBody,
                {
                    'connect-protocol-version': '1',
                    'connect-timeout-ms': String(CONSTANTS.REQUEST_TIMEOUT),
                    'accept': 'application/proto'
                }
            );

            const fields = parseProtoStringFields(responseBody);
            const apiKey = fields[1];
            const name = fields[2];
            const apiServerUrl = fields[3];

            if (!apiKey || !name) {
                throw new Error('Auth login failure: empty apiKey or name');
            }

            return {
                apiKey,
                name,
                apiServerUrl: apiServerUrl || 'https://server.self-serve.windsurf.com'
            };
        } catch (error) {
            const err = error as Error;

            if (err.message.includes('ENOTFOUND') || err.message.includes('ETIMEDOUT')) {
                throw new Error('无法连接到 Windsurf 服务器');
            }

            if (err.message.includes('HTTP 401') || err.message.toLowerCase().includes('unauthenticated') || err.message.toLowerCase().includes('invalid auth token')) {
                throw new Error(`获取 API Key 失败（401 未授权）。服务端返回：${err.message}`);
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
