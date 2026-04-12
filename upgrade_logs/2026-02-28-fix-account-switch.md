# WindsurfSwitch 修复记录 — 2026-02-28

## 问题现象

切换账号时报错：

```
切换失败: Cannot set properties of undefined (setting 'exports')
```

修改错误捕获逻辑后，进一步定位到两个独立错误：

1. **步骤4b（补丁命令注入）**：`Cannot read properties of undefined (reading 'getInstance')`
2. **步骤4c（数据库备用方案）**：`sql.js 加载失败: e is not a function`

两个问题叠加导致切换完全失败，仅执行了登出操作。

---

## 根因分析

### 问题一：补丁函数变量名过时

插件通过向 Windsurf 的 `extension.js` 注入一个 `handleAuthTokenWithShit` 函数来实现免验证会话注入。该函数是从 Windsurf 1.106.0 版本的 `handleAuthToken` **硬编码复制并修改**的。

Windsurf 更新后，`extension.js` 中的代码结构发生变化：

| 旧版本（硬编码补丁使用的） | 当前版本 |
|---|---|
| `u.sessionsSecretKey`（属性） | `u.getSessionsSecretKey()`（方法） |
| `r.LanguageServerClient.getInstance().restart(g)` | `this.restartLanguageServerIfNeeded(g)` |
| 直接 `this.context.globalState.update("apiServerUrl", g)` | 使用 `B.isStaging()` 判断 staging/production 再决定 key |
| 无 `_cachedSessions` | 新增 `this._cachedSessions=[r]` |
| 无 API Server URL secret 存储 | 新增 `u.getApiServerUrlSecretKey()` |

导致注入的函数在运行时找不到 `r.LanguageServerClient`（变量 `r` 在新版本中已被用于其他用途），抛出 `Cannot read properties of undefined (reading 'getInstance')`。

### 问题二：sql.js 模块加载不兼容

`webpack.config.js` 中未将 `sql.js` 外部化，webpack 打包时破坏了 sql.js 内部的模块导出机制。将 `sql.js` 加入 `externals` 后，`require('sql.js')` 的返回值格式可能因模块 interop 方式不同而变化（直接函数 vs `{ default: fn }`），原代码未做兼容处理。

---

## 修复方案

### 修复一：动态补丁生成（核心修复）

**文件**：`src/services/windsurfPatchService.ts`

将硬编码补丁策略改为**动态生成**：

1. 从当前 Windsurf `extension.js` 中**提取** `handleAuthToken` 函数完整源码
2. 通过正则匹配 `registerUser` 调用模式：
   ```
   const e=await(0,E.registerUser)(A),{apiKey:t,name:i}=e
   ```
3. 替换为直接从参数解构：
   ```
   const {apiKey:t,name:i}=A
   ```
4. 将 `e.apiServerUrl` 替换为 `A.apiServerUrl`
5. 函数名改为 `handleAuthTokenWithShit`
6. 嵌入版本标记 `/*WSPATCH_V3*/`

**优势**：所有内部变量引用（`u.getSessionsSecretKey()`、`this.restartLanguageServerIfNeeded()` 等）原封不动保留，自动适配任何 Windsurf 版本。

新增版本标记机制：
- `isPatchApplied()` 检查版本标记，旧补丁自动识别为"需要更新"
- 更新时先移除旧 `handleAuthTokenWithShit`，再插入新生成的版本

### 修复二：sql.js 外部化 + 加载兼容

**文件**：`webpack/extension.config.js`

```js
externals: {
    vscode: 'commonjs vscode',
    'sql.js': 'commonjs sql.js'  // 新增
}
```

**文件**：`src/services/databaseHelper.ts`

兼容两种模块导出格式：
```typescript
const sqlJsModule = require('sql.js');
const initFn = typeof sqlJsModule === 'function'
    ? sqlJsModule
    : (sqlJsModule.default || sqlJsModule);
```

### 修复三：增强错误日志

**文件**：`src/services/accountSwitcher.ts`

- 每个步骤（1/2/3/4a/4b/4c）独立 try-catch，打印具体错误和堆栈
- 步骤 4a 先检查补丁命令是否存在于命令列表
- 数据库写入失败不再向上抛出（避免掩盖真正错误）
- 切换时自动弹出「Windsurf 换号」输出面板
- UI 区分"补丁注入成功"和"备用方案"两种路径

---

## 修改文件清单

| 文件 | 修改内容 |
|---|---|
| `src/services/windsurfPatchService.ts` | 移除硬编码补丁字符串，新增动态补丁生成 + 版本标记机制 |
| `src/services/accountSwitcher.ts` | 分步错误捕获、日志面板自动弹出、区分注入/备用路径 |
| `src/services/databaseHelper.ts` | sql.js 加载兼容 + 诊断日志 |
| `src/webview/accountPanelProvider.ts` | UI 消息区分切换路径 |
| `webpack/extension.config.js` | sql.js 加入 externals |

---

## 经验总结

1. **不要硬编码 minified 代码中的变量名** — 每次版本更新都会变。应采用动态提取 + 正则变换的方式生成补丁。
2. **webpack 打包第三方库需谨慎** — 含 WASM 或特殊模块加载逻辑的库（如 sql.js）应通过 externals 排除。
3. **错误处理要分层** — 多步操作中每一步都应独立捕获异常，避免后续步骤的错误掩盖前面步骤的真正问题。
