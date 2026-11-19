# 下载与国内加速说明

AIH 的安装包发布在 GitHub Releases。国内直连 GitHub 可能较慢，下面是几种可用的下载方式。

## 官方下载

- Release 页面（推荐）：https://github.com/CBXH-use/AIH/releases/latest
- 官网下载页：https://cbxh-use.github.io/AIH/

| 文件 | 说明 |
| --- | --- |
| `AIH-<version>-setup.exe` | Windows 安装包，推荐 |
| `AIH-<version>-win-x64.zip` | 便携版，解压即用 |

系统要求：Windows 10 / 11 x64。

## 校验下载文件

Release 说明里会给出每个文件的 SHA256。下载后在 PowerShell 里执行：

```powershell
Get-FileHash .\AIH-0.1.1-setup.exe -Algorithm SHA256
```

与 Release 中的值一致即可放心安装。

## 国内加速

以下为第三方公共代理（非本项目运营，稳定性不保证，失效时可换下一个）：

- `https://ghproxy.net/` + GitHub 文件地址
- `https://ghfast.top/` + GitHub 文件地址

示例：

```
https://ghproxy.net/https://github.com/CBXH-use/AIH/releases/download/v0.1.1/AIH-0.1.1-setup.exe
```

官网下载页也会自动读取最新版本并生成加速链接。

## 镜像与网盘（按需）

如果 GitHub 和代理都不稳定，可以自己用下面的方式分流（维护者操作，普通用户可以等官方 Release）：

- **Gitee 镜像**：导入 GitHub 仓库用于代码镜像；注意 Gitee Release 附件有单文件大小限制（通常 100MB），超过时改用网盘
- **网盘**：123 云盘 / 夸克 / 阿里云盘，按版本建目录，分享链接设为长期有效
- **对象存储 / CDN**：Cloudflare R2 或国内 OSS/COS，适合长期稳定分发

每次发版后记得更新网盘目录、镜像链接和官网上的说明。

## 安装时遇到提示

- **“已保护你的电脑”**：安装包暂未做代码签名，点「更多信息 → 仍要运行」
- **杀毒软件报毒**：未签名 Electron 应用可能被误报，请先核对上面的 SHA256；仍不放心可以从源码自行构建
- **首次启动较慢**：首次会扫描本机模型目录，几十秒属正常
