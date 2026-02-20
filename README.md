# Obsidian Codex Bridge

在 Obsidian 桌面端调用本机 `codex` CLI，提供侧栏聊天、多会话、文档引用、图片输入与文本处理能力。

## 主要功能

- 侧栏聊天：`Codex: Open chat sidebar`
- 多会话切换（最多 3 个快捷切换，历史保留 10 条）
- 自动感知当前文档，并支持 `@` 引用文档/文件夹
- 支持图片附件（按钮上传与粘贴）
- Agent / Ask 模式切换
- 命令式处理：
  - `Codex: Process selected text`
  - `Codex: Process full note`

## 安装

1. 打开你的 Vault 插件目录：`<YourVault>/.obsidian/plugins/`
2. 新建目录 `codex-bridge`
3. 复制这三个文件到该目录：
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. 在 Obsidian 的第三方插件中启用 `Codex Bridge`
5. 执行 `Reload app without saving`

## 前置条件

- 仅支持 Obsidian 桌面版
- 系统中可执行 `codex`，且已登录可用
- 若出现 `env: node: No such file or directory`，请用包装脚本并在插件设置中将 `Codex 命令` 指向该脚本

## 说明

- `data.json` 为本地运行时状态，不应提交到仓库（已在 `.gitignore` 忽略）
