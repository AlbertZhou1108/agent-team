# 开发、测试与发行构建

[返回产品介绍](../README.md) · [架构](architecture.md) · [前端设计](../DESIGN.md)

## 环境与源码运行

需要 Node.js ≥22.13.0、npm，以及要使用的宿主 CLI。SQLite 由 Node 提供，不需要外部数据库。先克隆仓库，再在仓库根执行：

```bash
npm ci
npm run dev
```

开发 API 为 `127.0.0.1:62048`，Vite 页面为 `http://127.0.0.1:5173/`，开发数据在 `work/dev`。生产模式使用 `npm start -- serve --data /独立数据目录`；其 `prestart` 会先构建前端。终端与模型使用见 [CLI](cli.md)。

## 目录

| 位置 | 内容 |
| --- | --- |
| `src/` | Node ESM 后端，宿主适配器在 `src/hosts/` |
| `web/` | Vue 3、TypeScript、Vite 前端，npm workspace |
| `test/` | `node:test` 后端测试 |
| `web/src/**/*.test.ts` | Vitest 前端测试 |
| `scripts/` | 门禁、发行构建与手动真宿主验证工具 |
| `guide/` | 正式使用与技术文档 |
| `assets/readme/` | 产品介绍使用的插画和实机截图 |
| `work/` | 本地运行数据，不入库，不清理已有用户数据 |
| `docs/` | gitignored 的本地开发过程材料，不作为公开文档目录 |

## 检查

```bash
npm run check
npm test
npm run build
```

`check` 包含语法、设计治理、双端类型与后端 ESLint。CI 在 Ubuntu、macOS、Windows 上执行 check、build、test。测试需要平台中性；宿主行为用 fake command stub，不能依赖真实 CLI 或模型。

真实宿主验收另行手动执行，会使用宿主认证和模型额度：

```bash
node --disable-warning=ExperimentalWarning scripts/verify-collaboration.mjs
```

前端统一遵循 [DESIGN.md](../DESIGN.md)。shadcn-vue 工程根是 `web/`，CLI 必须在那里运行；优先已有组件与语义 token。

## 制作发行包

在目标平台构建，输出必须是新目录：

```bash
npm ci
npm run package -- /绝对路径/新的发行目录
```

工具复制本机 Node、许可证、后端运行依赖闭包和预构建前端，记录 Node 版本与 SHA-256。macOS 将运行资源放在 `Agent Team.app` 内；Windows 生成 `.cmd`，Linux 生成 `.sh` 入口。macOS app 只是启动器，不包含桌面 WebView。

当前不交叉构建。需要包含 LICENSE 的完整 Node 发行环境；构建工具拒绝覆盖已有目录。框架自带 Node 不代表外部宿主的运行依赖、认证或模型配置已经完成。


### 自动构建发行产物（不自动发布）

`.github/workflows/release.yml` 在推送 `v*` tag 或手动触发时，于 Ubuntu/macOS/Windows 三个平台执行 check、test、打包，并把压缩包与 SHA-256 上传为 Actions 产物；**不会创建或发布 GitHub Release**。

- tag 必须与 `package.json` 的 `version` 一致（`vX.Y.Z`），否则构建在第一步失败。
- 构建成功后，在该 Actions run 页面下载对应平台的 Artifacts，再人工创建 Release 并上传。
- 手动 `workflow_dispatch` 可用于试跑，不校验 tag。
- Actions 产物默认保留 30 天；实际分发前仍需人工完成签名、安装与真实环境验收。

公开分发仍需针对系统完成签名、安装和真实环境验收。源码三平台 CI 通过不等于已验收三平台安装包。停服升级、应用数据位置和备份见[开始使用](quick-start.md)。

## Skill 维护与同步

`skills/agent-team/` 是 agent-team Skill 的维护源，入口与 references、agents 元数据一起更新。修改工具、权限、消息读取或会话路由时，同步核对 Skill 与使用指南；实际参数以当前暴露的工具 schema 为准。

安装到多个 Agent 工具时，优先让本机共享技能目录链接到维护源，再让各工具受支持的 skills 目录引用这个共享入口；维护源必须保留在稳定路径。已有独立副本迁移前保留备份，核对目录内全部文件的 SHA-256；保留宿主特有元数据。只更新技能文件，不复制认证配置或运行数据。更新后新会话重新发现技能，已加载旧说明的会话需重新读取或新建，不声称已热更新。
