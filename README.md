# Obsidian Codex Bridge

在 Obsidian 桌面端直接接入本机 `codex` CLI 的社区插件。  
目标是把 Codex 的 Agent 能力和 Obsidian 的笔记上下文、选区、文档引用、图片输入整合到一个侧栏工作流里。

## 目录

1. 功能总览
2. 安装与升级
3. 快速开始
4. 核心交互说明
5. 配置项说明
6. 上下文管理与自动压缩
7. 技能（Skills）支持
8. 常见问题（FAQ）
9. 开发与发布
10. License

## 功能总览

- 侧栏聊天与多会话
  - 最多 3 个快捷会话切换（历史保留 10 个会话）
  - 会话可新建、清空、删除、历史回看
- Ask / Agent 双模式
  - `Ask`：仅对话，不执行文件修改
  - `Agent`：可让 Codex 在当前 Vault 内执行文件增删改
- 上下文输入能力
  - 自动关联当前打开文档
  - `@` 引用文档/文件夹
  - 选区上下文（显示选中行数）
  - 图片上传（文件选择 + 粘贴）
- 输出体验
  - Markdown 渲染
  - 可展开 thought 区块
  - 回复悬浮复制按钮
  - 生成中可中断
- 模型切换
  - 输入框内下拉切换模型
- 上下文占用可视化与压缩
  - 底部圆环显示上下文使用比例
  - 悬浮显示估算用量
  - 占用高时自动压缩历史上下文
- 命令式文本处理
  - `Codex: Process selected text`
  - `Codex: Process full note`

## 安装与升级

### 安装

1. 打开 Vault 目录下的插件路径：
   - `<Vault>/.obsidian/plugins/`
2. 新建目录：
   - `codex-bridge`
3. 将以下文件复制进去：
   - `manifest.json`
   - `main.js`
   - `styles.css`
4. 在 Obsidian 中启用第三方插件 `Codex Bridge`
5. 执行 `Reload app without saving`

### 升级

只需要覆盖这三个文件并重载：

- `manifest.json`
- `main.js`
- `styles.css`

## 快速开始

1. 打开命令面板，执行：
   - `Codex: Open chat sidebar`
2. 在侧栏输入问题直接聊天
3. 试试以下工作流：
   - `@` 引用一篇文档后总结
   - 切换到 `Agent` 模式让 Codex 修改文件
   - 粘贴图片让模型分析

## 核心交互说明

### 发送快捷键

- 默认：`Enter` 发送，`Shift + Enter` 换行
- 输入法上屏时不会误发送（已处理 IME 组合输入场景）

### 会话管理

- 顶部 `1/2/3` 是会话快捷入口（最近 3 个）
- 历史列表保留最近 10 个会话
- 每个会话有独立上下文、引用、技能、模型状态

### `@` 引用

- 支持引用：
  - 文档
  - 文件夹（会按预算截取多个 Markdown 文件内容）
- 引用会显示为输入框中的 chip，可随时移除

### 选区上下文

- 在编辑区选中内容后，输入区会显示 `N lines selected`
- 该选区会作为本轮上下文注入
- 可点击 `×` 取消选区上下文

### 图片输入

- 点击图片按钮上传
- 也支持直接粘贴截图到输入框
- 图片会显示缩略图，可单张删除

## 配置项说明

插件设置中常用项：

- `Codex 命令`
  - 默认：`codex`
  - 可改为绝对路径（例如包装脚本）
- `附加参数`
  - 示例：`--full-auto`
- `模型选项`
  - 逗号分隔，如：`gpt-5.2-codex,gpt-5.3-codex,gpt-5.2`
- `发送快捷键`
  - `Enter` 模式 或 `Cmd/Ctrl+Enter` 模式
- `1M 上下文模式（实验）`
  - 关闭约 200k，开启约 1M
- `原生会话上下文`
  - 开启后更偏向 Codex 原生多轮记忆
- `Ask/Agent 模式`
  - 运行时可直接切换

## 上下文管理与自动压缩

插件内置上下文占用管理：

- 圆环指示器显示当前估算占用百分比
- 悬浮会显示：
  - `used / max` 估算 token
  - 当前占用比例
- 自动压缩阈值：
  - `>= 80%`：触发自动压缩
  - `>= 90%`：强制压缩

压缩策略：

1. 将较早历史消息总结为“长期会话记忆”
2. 保留最近若干条消息继续对话
3. 后续 prompt 自动注入该长期记忆

你也可以点击圆环手动触发压缩。

## 技能（Skills）支持

- 支持在输入区通过 `/skill` 拉起技能面板
- 支持搜索、键盘上下选择、回车确认
- 选中技能后会以 chip 形式显示
- 本轮 prompt 会注入技能信息

默认扫描路径：

- `~/.codex/skills`
- `<Vault>/.codex/skills`
- `<Vault>/Skills`

## 常见问题（FAQ）

### 1) 报错 `spawn codex ENOENT`

原因：找不到 `codex` 可执行文件。  
处理：

- 在终端确认：`which codex`
- 在插件设置里将 `Codex 命令` 改为绝对路径或包装脚本

### 2) 报错 `env: node: No such file or directory`

原因：Obsidian 环境 PATH 不完整。  
处理：

- 创建包装脚本，显式补 PATH 后再 `exec codex`
- 插件设置中把 `Codex 命令` 指向该脚本

### 3) 模型提示不存在或无权限

原因：账号无该模型权限或模型名不正确。  
处理：

- 在设置中切换可用模型
- 终端单独执行 `codex exec` 验证模型权限

### 4) 重启后对话不完整

`data.json` 是会话状态来源。若你手动覆盖插件文件，建议重载后测试一轮并确认会话能正常落盘。

## 开发与发布

### 本地开发目录

- 代码仓库：`/Volumes/T7/Project/ai_coding/obsidian-codex-bridge`
- 运行插件目录：`<Vault>/.obsidian/plugins/codex-bridge`

### 常见发布流程

1. 修改仓库中的 `main.js` / `styles.css`
2. 同步到运行目录并在 Obsidian 重载
3. 回归测试
4. 提交并推送：
   - `git add .`
   - `git commit -m "your message"`
   - `git push origin main`

### 需要提交到 Git 的文件

- `manifest.json`
- `main.js`
- `styles.css`
- `README.md`

### 不建议提交

- `data.json`（本地运行状态）
- macOS 资源文件（如 `._*`）

## License

当前仓库尚未添加 `LICENSE` 文件。  
建议补充（例如 MIT）以便公开协作与复用。
