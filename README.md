# AIH · AI HOUSE

本地优先的 AI Agent 桌面工作台。无需命令行、无需预先安装 Ollama，下载后即可发现电脑里的模型、加载 GGUF，或在软件内一键下载并运行。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)
![license](https://img.shields.io/badge/license-MIT-green)
![electron](https://img.shields.io/badge/Electron-33-47848F)

## 下载

前往 [Releases](../../releases/latest) 获取最新版本：

| 文件 | 说明 |
| --- | --- |
| `AIH-*-setup.exe` | Windows 安装包，推荐 |
| `AIH-*-win-x64.zip` | 便携版，解压即用 |

> 安装包暂未进行代码签名。若 Windows SmartScreen 提示“已保护你的电脑”，请点击“更多信息 → 仍要运行”。

系统要求：Windows 10 / 11 x64。

## 功能

- **不依赖 Ollama 检测模型**：直接读取 Ollama 的 `manifests/blobs`，服务未启动也能列出；同时扫描全盘 GGUF 与 LM Studio 模型目录
- **自动定位非 C 盘 Ollama**：通过注册表、PATH、环境变量和多盘常见目录查找，模型目录被移动过也能识别
- **内置 llama.cpp 运行时**：运行时随安装包分发，首次使用本地解压，不依赖 GitHub 网络；没有 Ollama 也能运行 GGUF
- **软件内一键下载**：Qwen2.5 / Qwen3 / DeepSeek R1 / Llama 3.1 / Gemma 2 / Phi-4 / Qwen2.5 Coder 等模型直接下载并启动，ModelScope 失败自动切换 Hugging Face
- **对话与任务双模式**：任务模式下 Agent 可读写工作区文件、执行命令、联网检索、调用知识库与插件
- **安全可控**：高风险操作前请求确认、工作区限制、写文件前备份、本地审计日志
- **多智能体与扩展**：内置多种角色预设，支持插件目录与知识库
- **本地优先**：对话、模型与数据默认留在本机；也可以接入 DeepSeek、OpenAI、通义千问、智谱、Moonshot、硅基流动等 OpenAI 兼容 API

## 使用说明

1. 安装并启动 AIH
2. 首次启动会扫描电脑中的本地模型
3. 没有模型时，在“模型与 API”页选择推荐模型，点击“一键下载并运行”
4. 回到对话或任务模式开始使用

模型默认保存在剩余空间最大的磁盘的 `AIH Models` 目录，可在模型页点击“打开模型文件夹”。

> 内置运行时使用 CPU 推理，建议选择 7B / 8B 的 Q4_K_M 模型。如果电脑已安装 Ollama，AIH 会优先使用 Ollama（可 GPU 加速）。

## 从源码构建

环境要求：Node.js 20+、Windows 10/11 x64。

```bash
npm install
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm run build      # 构建渲染层与主进程
npm run dist       # 打包安装包与便携版到 release/
```

`npm run dist` 会自动下载内置 llama.cpp 运行时到 `build/runtime/`（已在本地存在时跳过），然后使用 electron-builder 生成：

- `release/AIH-<version>-setup.exe`
- `release/AIH-<version>-win-x64.zip`

## 发布新版本

推送到 GitHub 后，打标签即可触发 GitHub Actions 自动构建并发布：

```bash
git tag v0.1.1
git push origin v0.1.1
```

工作流：`.github/workflows/release.yml`，产物会自动附加到对应 Release。

## 项目结构

```
electron/          主进程：模型发现、内置运行时、Agent、工具、存储
src/renderer/      React 界面
src/shared/        共享类型与默认配置
scripts/           构建辅助脚本（运行时下载等）
build/             图标与打包资源
```

## 致谢

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — 内置本地推理运行时
- [Ollama](https://ollama.com) / [LM Studio](https://lmstudio.ai) — 本地模型服务
- [ModelScope](https://modelscope.cn) / [Hugging Face](https://huggingface.co) — 模型下载源

## License

[MIT](LICENSE)
