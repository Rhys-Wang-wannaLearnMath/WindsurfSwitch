<div align="center">

<img src="resources/windsurf-icon.png" alt="Windsurf" width="80">

# Windsurf 无感换号 (Fork)

**Windsurf 账号无感切换工具**

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)

</div>

---

## 🔱 Fork 说明

本项目 **Fork** 自 [crispvibe/WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch)。

### 修改内容

| 修改项 | 说明 |
|--------|------|
| **Windsurf 1.106.0 适配** | 更新 `handleAuthToken` 函数签名以兼容 Windsurf 1.106.0 版本 |
| **Linux 路径修复** | 修复 Linux 系统下的 Windsurf 扩展路径检测 |
| **账号备注名** | 支持为每个账号添加自定义备注名（如「工作号」「测试号」） |
| **当前账号显示修复** | 修复「当前账号」卡片一直显示「未登录」的问题 |
| **复制账号密码** | 新增一键复制账号密码功能（邮箱,密码格式） |

### 原项目信息

- **原作者**: [crispvibe](https://github.com/crispvibe)
- **原仓库**: [https://github.com/crispvibe/WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch)

感谢原作者的开源贡献！

---

## 功能

- **添加账号** - 输入邮箱和密码，自动获取 API Key
- **批量导入账号** - 支持一次性导入多个账号（邮箱/密码），自动逐个验证并写入列表
- **切换账号** - 一键切换到其他已保存的账号
- **删除账号** - 从列表中删除账号
- **账号备注** - 为每个账号添加自定义备注名（如「工作号」「测试号」），方便识别
- **复制密码** - 一键复制账号密码（邮箱,密码格式）
- **快捷键** - `Cmd+Alt+S` (Mac) / `Ctrl+Alt+S` (Win) 切换下一个账号

---

## 安装

### 方式一：直接安装 VSIX

1. 下载 `windsurf-SWITCH-1.0.0.vsix`(https://github.com/Rhys-Wang-wannaLearnMath/WindsurfSwitch/releases)
2. 在 Windsurf 中：扩展 -> 从 VSIX 安装

### 方式二：从源码构建

```bash
git clone https://github.com/Rhys-Wang-wannaLearnMath/WindsurfSwitch.git
cd WindsurfSwitch
npm install
npm run build
npm run package
```

---

## 使用

1. 点击左侧 Activity Bar 的 Windsurf 图标
2. 点击「添加账号」输入邮箱和密码
3. 点击账号列表中的账号进行切换

### 批量导入（一次输入多个账号）

在「添加账号」界面中：

- **邮箱输入框**：按 `邮箱,密码` 的格式填写多个条目，并用 `;` 分隔
- **密码输入框**：可留空

示例：

```text
user1@example.com,pass1;user2@example.com,pass2;user3@example.com,pass3
```

说明：

- 支持中文分号/逗号（`；` / `，`），会自动兼容
- 会逐个尝试登录验证；成功的账号会被保存，失败的会提示原因

---

## 补丁文件位置

| 系统 | 路径 |
|------|------|
| Windows | `%LOCALAPPDATA%\Programs\Windsurf\resources\app\extensions\windsurf\dist\extension.js` |
| macOS | `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js` |
| Linux | `/opt/Windsurf/resources/app/extensions/windsurf/dist/extension.js` |

---

## 注意事项

- 首次切换账号会自动应用补丁并重启 Windsurf
- Windsurf 更新后需要重新应用补丁

---

## 免责声明

本项目仅供学习和研究使用，不得用于商业用途。

- **风险自负**: 使用本工具所产生的一切后果由使用者自行承担
- **无担保**: 本项目按"原样"提供，不提供任何明示或暗示的担保
- **无关联**: 本项目与 Codeium / Windsurf 官方无任何关联
- **合规风险**: 使用本工具可能违反 Windsurf 的服务条款，请自行评估风险
- **维护声明**: 本项目可能随时停止维护，恕不另行通知

使用本工具即表示您已阅读并同意上述条款。

---

## 许可证

[MIT License](LICENSE)
