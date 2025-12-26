# Windsurf 切号补丁指南 (PATCH_README)

## 背景
- 功能：在 Windsurf 中无感切换账号，需要向官方扩展 `extension.js` 注入自定义命令/函数。
- 触发：首次切号或 Windsurf 更新后，需要对 `extension.js` 写入补丁。
- 常见报错：
  ```
  Could not find handleAuthToken function. Windsurf version may be incompatible.
  The expected function signature was not found in extension.js.
  ```
  原因：补丁脚本做精确字符串匹配，当前安装版本的压缩代码与内置常量不一致。

## 当前适配版本
- 已适配 **Windsurf 1.106.0**（基于当前安装版提取）。
- 关键常量（位于 `src/services/windsurfPatchService.ts`）：
  - `ORIGINAL_HANDLE_AUTH_TOKEN`
    ```js
    'async handleAuthToken(A){const e=await(0,E.registerUser)(A),{apiKey:t,name:i}=e,g=(0,B.getApiServerUrl)(e.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty api_key");if(!i)throw new s.AuthMalformedLanguageServerResponseError("Auth login failure: empty name");const I={id:(0,n.v4)(),accessToken:t,account:{label:i,id:i},scopes:[]};return await this.context.secrets.store(u.sessionsSecretKey,JSON.stringify([I])),await this.context.globalState.update("apiServerUrl",g),(0,o.isString)(g)&&!(0,o.isEmpty)(g)&&g!==r.LanguageServerClient.getInstance().apiServerUrl&&await r.LanguageServerClient.getInstance().restart(g),this._sessionChangeEmitter.fire({added:[I],removed:[],changed:[]}),I}';
    ```
  - `ORIGINAL_COMMAND_REGISTRATION`
    ```js
    "A.subscriptions.push(s.commands.registerCommand(t.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,async A=>{try{return{session:await e.handleAuthToken(A),error:void 0}}catch(A){return A instanceof a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata.getInstance().errorCodes.GENERIC_ERROR}}}),s.commands.registerCommand(t.LOGIN_WITH_REDIRECT,async(A,e)=>{(N||S)&&await G(),N=void 0;const t=(0,m.getAuthSession)({promptLoginIfNone:!0,shouldRegisterNewUser:A,fromOnboarding:e}).catch(A=>{if(!k(A))throw(0,u.sentryCaptureException)(A),console.error(\"Error during login with redirect:\",A),A});N=t;try{return await t}finally{N===t&&(N=void 0)}}),s.commands.registerCommand(t.LOGIN_WITH_AUTH_TOKEN,(acc)=>{acc?e.handleAuthToken(acc):e.provideAuthToken()}),s.commands.registerCommand(t.CANCEL_LOGIN,()=>G()),s.commands.registerCommand(t.LOGOUT,async()=>{const A=w.WindsurfAuthProvider.getInstance(),e=await A.getSessions();e.length>0&&await A.removeSession(e[0].id)})),";
    ```

## 如何解决当前报错
1. **确认文件路径与权限**
   - 典型路径（macOS）：`/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`
   - 若不可写，按提示 `sudo chmod +w <path>`（或以管理员运行）。

2. **确保常量已更新**
   - 拉取/使用包含上述常量的最新代码（已在 `windsurfPatchService.ts` 中更新）。

3. **重新执行切号**
   - 切号流程会自动调用 `checkAndApplyPatch`。写入成功会提示重启，重启后再切号即可。

## 版本更新后的处理流程（通用）
1) **定位 extension.js**：参考 `windsurfPathService.getPossibleExtensionPaths`，或常见路径（见下方列表）。
2) **提取新版本的压缩片段**（只读，不改文件）：
   ```bash
   python - <<'PY'
   import re, os, sys
   paths = [
       '/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
       '/Applications/Windsurf - Next.app/Contents/Resources/app/extensions/windsurf/dist/extension.js',
       # Windows/Linux 路径按需添加
   ]
   path = next((p for p in paths if os.path.exists(p)), None)
   if not path:
       sys.exit('extension.js not found')
   data = open(path,'rb').read().decode('utf-8','ignore')

   # 1) handleAuthToken
   m = re.search(r'async handleAuthToken[^\\{]*\\{', data)
   if not m: sys.exit('handleAuthToken not found')
   start = m.start(); depth=0; end=None
   for i,ch in enumerate(data[start:], start):
       if ch=='{': depth+=1
       elif ch=='}':
           depth-=1
           if depth==0:
               end=i+1; break
   handle = data[start:end]
   print('HANDLE:\n', handle)

   # 2) PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER 注册片段
   m = re.search(r'A\\.subscriptions\\.push\\(s\\.commands\\.registerCommand\\(t\\.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER', data)
   if m:
       start = m.start()
       stop_kw = 'e.onDidChangeSessions'
       stop = data.find(stop_kw, start)
       if stop == -1: stop = start + 2000
       cmd = data[start:stop]
       print('\nCOMMAND REGISTRATION:\n', cmd)
   else:
       print('\ncommand registration not found')
   PY
   ```
3) **更新常量**：将输出的两个片段粘贴到 `windsurfPatchService.ts` 的对应常量。
4) **重新构建/重新切号**：重新运行扩展或直接切号，让补丁再次写入。

## 补丁文件位置参考
- Windows: `%LOCALAPPDATA%\Programs\Windsurf\resources\app\extensions\windsurf\dist\extension.js`
- macOS: `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`
- Linux: `/opt/Windsurf/resources/app/extensions/windsurf/dist/extension.js`（或发行版安装路径）

## 注意事项
- **备份**：写入前建议手动备份 `extension.js`（如 `cp extension.js extension.js.bak`）。
- **匹配脆弱**：当前仍为精确字符串匹配，版本差异会导致匹配失败；若需更稳健可改为正则/AST 定位 + 临时文件写入再原子替换。
- **更新后重补丁**：官方更新会覆盖 `extension.js`，更新后需重新执行一次补丁流程。
- **权限问题**：无写权限会导致失败，先按提示修正权限再重试。

## 故障排查速查表
- 找不到 `handleAuthToken`：提取新压缩代码，更新 `ORIGINAL_HANDLE_AUTH_TOKEN`。
- 找不到命令注册：提取含 `PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER` 的注册片段，更新 `ORIGINAL_COMMAND_REGISTRATION`。
- 写入失败/权限不足：检查文件可写权限（macOS/Linux 可用 `sudo chmod +w <path>`）。
- 验证失败：确认关键词 `windsurf.provideAuthTokenToAuthProviderWithShit` 和 `handleAuthTokenWithShit` 已写入；若语法破坏，恢复备份后重试。
