# 发布流程（GitHub Releases）

> 目标：一次打 tag，产出所有可分发产物；发布 release 即部署生产，做到「发布的版本 = 线上跑的版本」。
> 相关文件：`.github/workflows/release.yml`（打包）、`.github/workflows/deploy.yml`（部署）、`scripts/check-version.mjs`（版本门禁）。

## 1. 触发方式

| 触发 | 行为 |
|---|---|
| push tag `v*`（如 `v0.1.0`） | 跑全部门禁 → 构建所有产物 → **自动发布 release** → release job 末尾用 `gh workflow run` **显式 dispatch `deploy`** |
| 手动 `workflow_dispatch`（version + dry_run） | 构建产物；`dry_run=true`（默认）只上传 workflow artifact，不创建 release、不部署；`dry_run=false` 与 tag 流程相同 |
| `release: published`（人工发布/重新发布） | 触发 `deploy`，把该 release 的 server tarball 部署到生产 |
| 手动 `deploy` workflow（输入 tag） | 重新部署某个已发布 release |

> **为什么是显式 dispatch（GITHUB_TOKEN 限制）**：GitHub 不会为「用 `GITHUB_TOKEN` 创建的 release」发出
> `release: published` 事件（framework 的递归触发保护）。`release.yml` 自动发布 release 时用的正是
> `GITHUB_TOKEN`，所以 `deploy.yml` 的 `on: release: published` **不会**因它触发——P0 `v0.1.0` 就是这样
> 发布成功但 deploy 没有自动跑（当时人工补部署）。`workflow_dispatch` 不受该限制，因此 release job 的最后一步
> 执行 `gh workflow run deploy.yml --ref <默认分支> -f tag=<tag>`（工作流已声明 `permissions.actions: write`），
> `deploy.yml` 只额外修了 tarball 落地路径（`strip_components: 1`，见 §8「部署脚本修复」）。人工在 GitHub 上发布/重新发布 release 仍走 `release: published`；
> `deploy.yml` 的 `workflow_dispatch` 仍是手动重部署入口。

> **该修复只能在下一次打 tag 时端到端证明**（本地无法触发 GitHub 事件）。届时看：`release` run 是否全绿 →
> release 是否 published → release run 的 **`trigger deploy (workflow_dispatch)`** 步骤日志里是否出现
> `dispatched deploy.yml for vX.Y.Z on master` → Actions 列表里是否出现一条 **`deploy` run（event = workflow_dispatch）**
> 并跑完。若没有：检查 `trigger deploy` 步骤日志（常见原因：工作流 `permissions` 缺 `actions: write`、默认分支不叫
> `master`），手动补部署：`gh workflow run deploy.yml --ref master -f tag=vX.Y.Z`。

## 2. 产物

服务器端是 **Go 单二进制**（`apps/signaling-go/`）：一个静态链接的可执行文件，内嵌 Web 应用、信令 WebSocket 监听与 in-process TURN，**服务器不需要 Node 运行时、也不需要单独的 coturn**；协议仍是 v2，客户端零改动。

| 文件 | 用途 |
|---|---|
| `crossfile-signaling-<version>-linux-x64.tar.gz` | 服务器解压部署包（x64）：`crossfile-signaling` + `ecosystem.config.cjs` + `VERSION`，解压后 `pm2 start` 即单进程提供网页 + `/v1/ws` + TURN（不再需要 Node） |
| `crossfile-signaling-<version>-linux-arm64.tar.gz` | 同上，arm64 服务器 |
| `crossfile-signaling-<version>-linux-x64` | 单文件静态 Go 二进制（Web 资源已嵌入，约 10 MB），下载后 `chmod +x` 直接运行，x64 |
| `crossfile-signaling-<version>-linux-arm64` | 同上，arm64（约 9.5 MB） |
| `CrossFile-<version>-x86_64.AppImage` | Linux 桌面（Electron/Chromium，ADR 0009） |
| `CrossFile_<version>_x64_en-US.msi` / `CrossFile_<version>_x64-setup.exe` | Windows 桌面（Tauri，**未签名**，SmartScreen 会提示） |
| `CrossFile_<version>_universal.dmg` | macOS 桌面（Tauri universal，**未签名/未公证**） |
| `CrossFile-<version>-android-arm64.apk` | Android（Tauri，`org.hancel.file`，release keystore 签名，arm64，versionName = tauri.conf version） |
| `SHA256SUMS` | 全部产物的 SHA-256 |

iOS 暂不打包（需要 Apple 开发者账号与签名/TestFlight 流程）。

### 2.1 服务器包内容与运行时环境

`crossfile-signaling-<version>-linux-x64.tar.gz`（arm64 同理）解开后是三个文件，没有 `node_modules`、没有 `public/`、也没有 `server.cjs`（仓库里的 Node 实现已删除；只有旧 tag 的 release 资产里还带 `server.cjs`，仅供回滚）：

```text
crossfile-signaling     静态 Go 二进制（模式 0755；网页 + /v1/ws + in-process TURN）
ecosystem.config.cjs    PM2 配置（name: crossfile-signaling；interpreter: "none"；cwd=__dirname）
VERSION                 commit / version / built 三行
```

`ecosystem.config.cjs` 把以下环境变量透传给二进制（其余用二进制默认值；空值视为未设置）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址；反代后面建议 `127.0.0.1` |
| `PORT` | `8788` | 单进程对外端口（网页 + `/v1/ws` 同源） |
| `MAX_MEMBERS` | 4（官方实例 2） | 房间成员上限，不含管理员（docs/01 D6） |
| `TURN_URIS` | 空 | 下发给浏览器的 TURN 地址；空 = 不提供 TURN |
| `TURN_SECRET` | 空 | TURN 临时凭据的 HMAC secret（内嵌 TURN 与下发凭据用同一份） |
| `TURN_EXTERNAL_IP` | 启用 TURN 时必填 | 内嵌 TURN 通告给浏览器的 relay 地址；公网主机填公网 IPv4。TURN 仅在 `TURN_URIS` 非空**且** `TURN_SECRET` 设置时启动（与 Node 门禁一致）；缺此地址则启动失败 |
| `TURN_LISTEN_PORT` | `3478` | 内嵌 TURN 监听端口（udp+tcp） |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49200` | relay 端口段（防火墙需同步放行） |

`deploy.yml` **无需为本流水线改动**：资产名与解压后路径不变，`pm2 delete` + `pm2 start <release>/ecosystem.config.cjs --update-env` 对新的 Go 包和旧 tag 的 Node 包都成立（每个 release 自带自己的 ecosystem 配置），健康检查 `curl http://127.0.0.1:$PORT/` 由 Go 二进制内嵌的 Web 应用应答。它唯一一次改动是 v0.2.0 首次自动部署暴露的 scp 落地路径修复（见 §8）。

体积参考（2026-11-27 本地按本工作流命令实测）：x64 静态二进制约 10 MB、arm64 约 9.5 MB；gzip 后的 tarball 分别约 3.9 MB / 3.5 MB（旧 Node SEA 单文件为 123 MB）。

> 仓库里的 Node 信令实现（`packages/signaling/`、`infra/signaling/build*.mjs`、`entry.ts`、`sea-entry.ts`、Node 版 PM2 配置）已于 v0.2.0 后删除：Go 是唯一实现，本流水线只产出 Go 资产。旧 tag 的 release 资产不受影响，回滚仍可部署（见 §7）。

> ✅ **切换已完成**：`v0.2.0`（commit `2d2d5fd`）起，master 上的 release 流水线产出的 server 资产是 Go 单二进制，生产 `https://file.time-pack.com` 已切到 Go（内嵌 TURN，不再需要 coturn）。P0 的 `v0.1.0` tag 指向旧 commit（`acdd78f`），产物仍是 Node 版本，可作为回滚目标。

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
4. `release` workflow 构建完成后会**自动发布 release**（含产物 + 自动生成的 release notes + SHA256SUMS），
   随后 release job 的 **`trigger deploy (workflow_dispatch)`** 步骤会显式 dispatch `deploy`
   （`environment: production`，如配置了 required reviewers 需先批准）。这一步失败会让 release workflow 变红，
   避免「已发布但没部署」静默发生。
5. 验收：Actions 里应出现一条 **`deploy` run（event = workflow_dispatch）** 且为绿色；然后
   `https://file.time-pack.com/` 200、`pm2 ls` online、`current` 软链指向 `releases/<tag>`。
   如果 release 产物有问题，删除该 release 并修复后重新打 tag（或在 Actions 里重跑）；
   如果 deploy 没被 dispatch，手动补：`gh workflow run deploy.yml --ref master -f tag=vX.Y.Z`。

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
本地生成/更新与 Android 签名细节见 `docs/mobile.md` §发布签名。**缺少这 4 个 secret 时 release workflow 会直接失败**，
不会把 debug 签名的 APK 发出去（job 会校验 APK 证书为 `CN=CrossFile`）。

**工作流权限**：`release.yml` 声明了 `permissions: { contents: write, actions: write }`——`contents: write` 用于创建
release，`actions: write` 用于最后一步 `gh workflow run deploy.yml` 的 dispatch。若仓库把默认 token 权限设为只读，
工作流里显式声明的权限依然生效；不需要额外的个人 token secret。

## 5. 签名与分发说明

- **Windows / macOS**：当前无证书，产物可下载可运行，但 Windows 会弹 SmartScreen、macOS 会提示"无法验证开发者"（右键打开或 `xattr -dr com.apple.quarantine`）。要正式分发需要代码签名证书（Windows）与 Apple Developer ID + 公证（macOS）。
- **Android**：release APK 用 `org.hancel.file` 包名与 release keystore 签名，可直接侧载安装；上架 Google Play 需要 AAB（后续可加 `--aab`）。
- **server**：Go 单二进制（`apps/signaling-go/`，`CGO_ENABLED=0` 静态链接，`-trimpath -ldflags="-s -w"`），一个进程内嵌 Web 应用、`/v1/ws` 与 TURN。生产部署不再需要 Node 运行时或单独的 coturn，协议仍是 v2、客户端零改动。x64 与 arm64 各产出一个 tarball 和一个裸二进制；二进制只能在与构建相同的 OS/架构上运行（当前只出 linux）。
- **server 包的回滚兼容性**：每个 release 的 tarball 自带自己的 `ecosystem.config.cjs`（旧 Node 版指向 `server.cjs`，Go 版 `interpreter: "none"` 直接跑二进制），所以 `deploy.yml` 用旧 tag 重跑即可回滚到 Node 或 Go 版本，工作流不需要区分；仓库里不再需要（也没有）Node 源码。

## 6. dry run 与本地验证

```bash
# 不创建 release，只验证全矩阵构建（Actions → release → Run workflow，dry_run=true）
# 本地验证版本门禁
node scripts/check-version.mjs 0.1.0

# 本地复现 release 的 server 产物（不依赖 CI 产物）
pnpm --filter @crossfile/web build
mkdir -p apps/signaling-go/webdist && cp -r apps/web/dist/. apps/signaling-go/webdist/
SKIP_WEB=1 bash apps/signaling-go/build.sh
PORT=18998 HOST=127.0.0.1 apps/signaling-go/bin/crossfile-signaling   # 单进程网页 + /v1/ws + TURN
curl -fsS http://127.0.0.1:18998/ | grep -q '<div id="root">'
curl -fsS -o /dev/null http://127.0.0.1:18998/r/abcdefghijklmnopqrstuvwxyz   # SPA 回退

# 用真实 e2e 与零存储审计验证 Go 二进制（默认就是 Go 信令，无需 E2E_SERVER）
pnpm exec playwright test              # 全量 e2e（Go 信令 + Vite 页面）
bash tests/audit/zero-storage.sh       # strace：0 写盘 / 0 DB / 1 行启动日志
```

## 7. 回滚

- 生产：在服务器上 `pm2 start /var/www/rust/cross-file/releases/<旧 tag>/ecosystem.config.cjs --update-env && pm2 save`，
  或手动跑 `deploy` workflow 并输入旧 tag。
- Release：GitHub 上把旧 release 标记为 Latest / 重新下载旧产物即可；tag 不要删除（已发布产物保持可追溯）。
- 回滚到 Node 版（v0.1.0）：先 `sudo systemctl enable --now coturn`（Go 内嵌 TURN 让出了 3478），再 `deploy` 工作流输入旧 tag。
  两个版本的 tarball 各自带适配自己运行时的 `ecosystem.config.cjs`，`deploy.yml` 不需要区分；回滚不依赖仓库里的 Node 代码（已删除），
  只需旧 release 资产仍然存在。服务器上 Node 仅用于运行 PM2 本身（或改用 systemd，见 `docs/self-host.md` §12）。

## 8. 部署脚本修复（2026-11-27，v0.2.0 首次自动部署发现）

`appleboy/scp-action` 上传 `source: release/crossfile-signaling-*.tar.gz` 时保留了 `release/` 前缀，tarball 落到
`releases/<tag>/release/`，而解压步骤只在 `releases/<tag>/` 下找 → `set -e` 退出，PM2 未被触碰（生产仍是旧版本，
安全失败但没部署）。修复：scp-action 加 `strip_components: 1`，解压步骤用 `find -maxdepth 2` 兜底并清理嵌套目录。
同版本重跑 `deploy` 工作流即可复验——v0.2.0 修复后重跑（run 45981294402）全绿：tarball 直接落在 `releases/v0.2.0/`、解压后目录只有 `crossfile-signaling` + `ecosystem.config.cjs` + `VERSION`、PM2 重启健康检查通过、生产 AC10/AC2 复跑通过。
