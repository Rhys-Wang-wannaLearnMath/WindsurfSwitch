import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const FIREBASE_PROJECT_NUMBER = '957777847521';
const FIREBASE_APP_ID = '1:957777847521:web:390f31e87633dc5cc803a0';
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6Ld8Da4sAAAAAJ7VyZm7E66-Vgv6JBPCvt6-Jtsh';
const REQUEST_TIMEOUT = 30000;
const APP_CHECK_RECAPTCHA_ACTION = 'fire_app_check';
const AUTH_RECAPTCHA_ACTION = 'signInWithPassword';

export interface FirebaseTokens {
    idToken: string;
    refreshToken: string;
    expiresIn: number;
}

interface RecaptchaTokens {
    appCheckToken: string;
    authCaptchaToken: string;
}

function exchangeRecaptchaEnterpriseToken(recaptchaEnterpriseToken: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ recaptchaEnterpriseToken });
        const req = https.request({
            hostname: 'firebaseappcheck.googleapis.com',
            port: 443,
            path: `/v1/projects/${FIREBASE_PROJECT_NUMBER}/apps/${FIREBASE_APP_ID}:exchangeRecaptchaEnterpriseToken?key=${FIREBASE_API_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Referer': 'https://windsurf.com/',
                'Origin': 'https://windsurf.com'
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.token) {
                        resolve(json.token);
                        return;
                    }
                    reject(new Error(`App Check 交换失败: ${json.error?.message || body.substring(0, 200)}`));
                } catch {
                    reject(new Error('App Check 响应解析失败'));
                }
            });
        });

        req.setTimeout(REQUEST_TIMEOUT, () => {
            req.destroy();
            reject(new Error('App Check 请求超时'));
        });

        req.on('error', (error) => {
            reject(new Error(`App Check 请求失败: ${error.message}`));
        });

        req.write(postData);
        req.end();
    });
}

function signInWithAppCheck(email: string, password: string, appCheckToken: string, authCaptchaToken: string): Promise<FirebaseTokens> {
    return new Promise((resolve, reject) => {
        const payload: Record<string, string | boolean> = {
            email,
            password,
            returnSecureToken: true
        };

        if (authCaptchaToken) {
            payload.captchaResponse = authCaptchaToken;
            payload.clientType = 'CLIENT_TYPE_WEB';
            payload.recaptchaVersion = 'RECAPTCHA_ENTERPRISE';
        }

        const postData = JSON.stringify(payload);
        const req = https.request({
            hostname: 'identitytoolkit.googleapis.com',
            port: 443,
            path: `/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'X-Firebase-AppCheck': appCheckToken,
                'X-Firebase-GMPID': FIREBASE_APP_ID,
                'X-Client-Version': 'Chrome/JsCore/10.12.4/FirebaseCore-web',
                'Referer': 'https://windsurf.com/',
                'Origin': 'https://windsurf.com'
            }
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.idToken) {
                        resolve({
                            idToken: json.idToken,
                            refreshToken: json.refreshToken || '',
                            expiresIn: parseInt(json.expiresIn || '3600')
                        });
                        return;
                    }
                    reject(new Error(`Firebase 登录失败: ${json.error?.message || body.substring(0, 200)}`));
                } catch {
                    reject(new Error('Firebase 响应解析失败'));
                }
            });
        });

        req.setTimeout(REQUEST_TIMEOUT, () => {
            req.destroy();
            reject(new Error('Firebase 请求超时'));
        });

        req.on('error', (error) => {
            reject(new Error(`Firebase 请求失败: ${error.message}`));
        });

        req.write(postData);
        req.end();
    });
}

async function openVerificationUrl(url: string, log: (message: string) => void): Promise<void> {
    log(`验证链接: ${url}`);

    try {
        await vscode.env.clipboard.writeText(url);
        log('验证链接已复制到剪贴板；如果浏览器没有自动打开，请手动粘贴访问。');
    } catch {
        log('如果浏览器没有自动打开，请复制上面的验证链接手动访问。');
    }

    try {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        log(opened ? '已请求系统打开浏览器，请在浏览器中完成验证。' : '系统没有确认打开浏览器，请手动打开验证链接。');
    } catch (error) {
        log(`自动打开浏览器失败: ${(error as Error).message}`);
    }

    void vscode.window.showInformationMessage(
        '需要在浏览器完成 Windsurf App Check 验证。如果浏览器没有自动打开，请点击按钮或使用已复制的链接。',
        '打开验证页面',
        '复制链接'
    ).then(async (action) => {
        if (action === '打开验证页面') {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (action === '复制链接') {
            await vscode.env.clipboard.writeText(url);
        }
    });
}

function getRecaptchaTokens(log: (message: string) => void): Promise<RecaptchaTokens> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout: NodeJS.Timeout;
        let server: http.Server;

        const settle = (fn: () => void) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                try {
                    server.close();
                } catch {
                }
                fn();
            }
        };

        server = http.createServer((req, res) => {
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                res.end();
                return;
            }

            if (req.method === 'POST' && req.url === '/callback') {
                let body = '';
                req.on('data', (chunk) => {
                    body += chunk.toString();
                });
                req.on('end', () => {
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end('<html><body style="font-family:system-ui;text-align:center;padding:40px"><h2>验证完成，可关闭此页面</h2><script>setTimeout(function(){window.close()},1000)</script></body></html>');

                    try {
                        const data = JSON.parse(body);
                        if (data.error) {
                            settle(() => reject(new Error(data.error)));
                        } else if (data.token1 && data.token2) {
                            settle(() => resolve({ appCheckToken: data.token1, authCaptchaToken: data.token2 }));
                        } else {
                            settle(() => reject(new Error('未获取到 reCAPTCHA token')));
                        }
                    } catch {
                        settle(() => reject(new Error('回调数据解析失败')));
                    }
                });
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Windsurf 验证</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.1);text-align:center;max-width:400px}
#s{color:#666;margin-top:16px}
.sp{display:inline-block;width:20px;height:20px;border:3px solid #ddd;border-top-color:#09B6A2;border-radius:50%;animation:r 1s linear infinite;margin-right:8px;vertical-align:middle}
@keyframes r{to{transform:rotate(360deg)}}
.err{color:#e53e3e}.ok{color:#38a169}
</style>
<script src="https://www.google.com/recaptcha/enterprise.js?render=${RECAPTCHA_ENTERPRISE_SITE_KEY}"></script>
</head><body>
<div class="card">
<h2>Windsurf 账号验证</h2>
<p id="s"><span class="sp"></span>正在加载验证组件...</p>
</div>
<script>
(async function(){
    var st=document.getElementById('s');
    function S(m,c){st.innerHTML=(c==='err'?'':'<span class="sp"></span>')+m;st.className=c||'';}
    function CB(d){return fetch('/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).catch(function(){});}
    try{
        S('正在执行人机验证...','');
        await new Promise(function(r){grecaptcha.enterprise.ready(r)});
        var token1=await grecaptcha.enterprise.execute('${RECAPTCHA_ENTERPRISE_SITE_KEY}',{action:'${APP_CHECK_RECAPTCHA_ACTION}'});
        var token2=await grecaptcha.enterprise.execute('${RECAPTCHA_ENTERPRISE_SITE_KEY}',{action:'${AUTH_RECAPTCHA_ACTION}'});
        if(!token1||!token2)throw new Error('reCAPTCHA 返回空 token');
        await CB({token1:token1,token2:token2});
        S('验证通过！请回到编辑器...','ok');
        setTimeout(function(){window.close()},1500);
    }catch(e){
        S('验证失败: '+(e.message||e),'err');
        await CB({error:'reCAPTCHA 失败: '+(e.message||e)});
    }
})();
</script>
</body></html>`);
        });

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : undefined;
            if (!port) {
                settle(() => reject(new Error('无法获取本地验证端口')));
                return;
            }
            const url = `http://localhost:${port}`;
            void openVerificationUrl(url, log);
        });

        server.on('error', (error) => {
            settle(() => reject(new Error(`服务器启动失败: ${error.message}`)));
        });

        timeout = setTimeout(() => {
            settle(() => reject(new Error('reCAPTCHA 验证超时（30s）：如果浏览器没有自动打开，请重新添加账号并手动打开面板中显示的验证链接')));
        }, REQUEST_TIMEOUT);
    });
}

export async function authenticateViaWebview(email: string, password: string, logCallback?: (message: string) => void): Promise<FirebaseTokens> {
    const log = (message: string) => {
        if (logCallback) {
            logCallback(message);
        }
    };

    log('步骤1: 正在获取 reCAPTCHA 令牌（需要浏览器验证或手动打开验证链接）...');
    const recaptchaTokens = await getRecaptchaTokens(log);
    log(`步骤1完成: 获取到 ${recaptchaTokens.appCheckToken ? 2 : 1} 个 token`);

    log('步骤2: 正在交换 App Check 令牌...');
    const appCheckToken = await exchangeRecaptchaEnterpriseToken(recaptchaTokens.appCheckToken);
    log(`步骤2完成: App Check token 长度=${appCheckToken.length}`);

    log('步骤3: 正在验证账号密码...');
    const firebaseTokens = await signInWithAppCheck(email, password, appCheckToken, recaptchaTokens.authCaptchaToken);
    log('步骤3完成: 登录成功');

    return firebaseTokens;
}
