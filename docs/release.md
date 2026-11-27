# 发布流程（GitHub Releases）

> 目标：一次打 tag，产出所有可分发产物；发布 release 即部署生产，做到「发布的版本 = 线上跑的版本」。
> 相关文件：`.github/workflows/release.yml`（打包）、`.github/workflows/deploy.yml`（部署）、`scripts/check-version.mjs`（版本门禁）。

## 1. 触发方式

| 触发 | 行为 |
|---|---|
| push tag `v*`（如 `v0.1.0`） | 跑全部门禁 → 构建所有产物 → 创建 **draft release** |
| 手动 `workflow_dispatch`（version + dry_run） | 构建产物；`dry_run=true`（默认）只上传 workflow artifact，不创建 release |
| 手动发布 draft release / `release: published` | 触发 `deploy`，把该 release 的 server tarball 部署到生产 |
| 手动 `deploy` workflow（输入 tag） | 重新部署某个已发布 release |

## 2. 产物

| 文件 | 用途 |
|---|---|
| `crossfile-signaling-<version>-linux-x64.tar.gz` | 解压部署包：`server.cjs` + `public/` + `ecosystem.config.cjs` + `VERSION`（需要服务器有 Node 22） |
| `crossfile-signaling-<version>-linux-x64` | 单文件二进制（Node SEA，Web 资源已嵌入，服务器无需 Node），约 123 MB；下载后 `chmod +x` 直接运行 |
| `CrossFile-<version>-x86_64.AppImage` | Linux 桌面（Electron/Chromium，ADR 0009） |
| `CrossFile_<version>_x64_en-US.msi` / `CrossFile_<version>_x64-setup.exe` | Windows 桌面（Tauri，**未签名**，SmartScreen 会提示） |
| `CrossFile_<version>_universal.dmg` | macOS 桌面（Tauri universal，**未签名/未公证**） |
| `CrossFile-<version>-android-arm64.apk` | Android（Tauri，`org.hancel.file`，release keystore 签名，arm64，versionName = tauri.conf version） |
| `SHA256SUMS` | 全部产物的 SHA-256 |

iOS 暂不打包（需要 Apple 开发者账号与签名/TestFlight 流程）。

## 3. 发一个版本

1. **改版本号（PR）**：同步修改以下 6 个文件的 `version`（`node scripts/check-version.mjs <version>` 会检查）：
   `package.json`、`apps/desktop/package.json`、`apps/desktop-electron/package.json`、`apps/mobile/package.json`、
   `apps/desktop/src-tauri/tauri.conf.json`、`apps/mobile/src-tauri/tauri.conf.json`。
2. 合并到 `master`，确认 `ci` 全绿。
3. 打 tag 并推送：
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. `release` workflow 构建完成后，在 GitHub → Releases 里检查 draft（产物 + 自动生成的 release notes + SHA256SUMS）。
5. 点 **Publish release** → `deploy` 自动把 server tarball 部署到生产（`environment: production`，如配置了 required reviewers 需先批准）。
6. 验收：`https://file.time-pack.com/` 200、`pm2 ls` online、`current` 软链指向 `releases/v0.1.0`。

> 版本号以 tag 为唯一来源；tag 与 6 个 manifest 不一致时 `verify` job 直接失败。

## 4. GitHub Secrets

| Secret | 用于 | 必填 |
|---|---|---|
| `DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY` / `DEPLOY_PATH` | `deploy` 工作流 | ✅ |
| `DEPLOY_PORT` | SSH 端口（默认 22） | 可选 |
| `PUBLIC_BASE_URL` | 部署后公网 smoke（如 `https://file.time-pack.com`） | 可选 |
| `ANDROID_KEYSTORE_BASE64` | base64 的 release keystore | ✅（Android job） |
| `ANDROID_KEY_ALIAS` | keystore alias（`crossfile`） | ✅ |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 | ✅ |
| `ANDROID_KEY_PASSWORD` | key 密码 | ✅ |

keystore 只存在本地工作区 `.secrets/android-release.keystore`（gitignored）与 GitHub Secrets，不进仓库。
本地生成/更新与 Android 签名细节见 `docs/mobile.md` §发布签名。

## 5. 签名与分发说明

- **Windows / macOS**：当前无证书，产物可下载可运行，但 Windows 会弹 SmartScreen、macOS 会提示"无法验证开发者"（右键打开或 `xattr -dr com.apple.quarantine`）。要正式分发需要代码签名证书（Windows）与 Apple Developer ID + 公证（macOS）。
- **Android**：release APK 用 `org.hancel.file` 包名与 release keystore 签名，可直接侧载安装；上架 Google Play 需要 AAB（后续可加 `--aab`）。
- **server 二进制**：Node SEA 在 Node 22 仍标记 experimental；默认部署仍用 tarball，二进制作为"下载即跑"的备选（123 MB，无需目标机装 Node，但只能在与构建相同的 OS/架构上运行，当前 linux-x64）。

## 6. dry run 与本地验证

```bash
# 不创建 release，只验证全矩阵构建（Actions → release → Run workflow，dry_run=true）
# 本地验证版本门禁
node scripts/check-version.mjs 0.1.0
```

## 7. 回滚

- 生产：在服务器上 `pm2 start /var/www/rust/cross-file/releases/<旧 tag>/ecosystem.config.cjs --update-env && pm2 save`，
  或手动跑 `deploy` workflow 并输入旧 tag。
- Release：GitHub 上把旧 release 标记为 Latest / 重新下载旧产物即可；tag 不要删除（已发布产物保持可追溯）。
