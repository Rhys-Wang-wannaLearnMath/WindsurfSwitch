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

### 原项目信息

- **原作者**: [crispvibe](https://github.com/crispvibe)
- **原仓库**: [https://github.com/crispvibe/WindsurfSwitch](https://github.com/crispvibe/WindsurfSwitch)

感谢原作者的开源贡献！

---

## 功能

- **添加账号** - 输入邮箱和密码，自动获取 API Key
- **切换账号** - 一键切换到其他已保存的账号
- **删除账号** - 从列表中删除账号
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
