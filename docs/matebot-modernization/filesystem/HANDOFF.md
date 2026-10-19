# File system 特性交接（来自 Claude Desktop 逆向）

> 目标：在 AutoAgent 中集成安全的工作区文件浏览器/编辑器。
> **状态（2026-10-19）：T0 已实现并合入。** `SafeFileService` 位于
> `backend/src/autoagent_backend/adapters/files/safe_file_service.py`，路由位于
> `backend/src/autoagent_backend/api/routes/file_router.py`，前端位于
> `frontend/src/features/files/`，`Shell` 增加 Files tab。本目录保留为来源证据。
> 实现遵循 `docs/matebot-modernization/architecture.md` 的深接口与安全约定。

## 文件

- `ANALYSIS.md` — Claude Desktop 文件系统端到端逆向（75 KB，file+offset 证据）
- `reference/README.md` — 参考架构、API、安全模型、集成映射、验收
- `reference/PATCH_PLAN.md` — AutoAgent 文件级 T0/T1/T2 计划、验证命令、回滚
- `reference/backend/file_service.py` — stdlib `SafeFileService`（无 FastAPI）
- `reference/backend/file_router.py` — FastAPI 路由（list/stat/read/write/upload/...）
- `reference/backend/test_file_service.py` — 31 个 pytest
- `reference/frontend/fileClient.ts` — typed API client（sha256/abort/upload progress）
- `reference/frontend/useFileTree.ts` — 懒加载、分页、取消、刷新
- `reference/frontend/FileBrowser.tsx` — 文件树 + 预览/编辑 + 对话框

## Claude Desktop 的关键结论（用于设计判断）

- `FileSystem` 有 19 个方法：list/read/write/browse/open/reveal/thumbnail/system path/Drive export 等。
- 数据根：`userData/local-agent-mode-sessions/<acct>/<org>/<sessionDir>`；会话目录含 `outputs/uploads/.claude/.projects/host-cwd`；Cowork 根 `~/Claude` → `Documents/Claude` → `userData/cowork-user-files`。
- 安全是分层：集中校验 + 允许根 + 扩展名/文件名封锁 + symlink 40 跳 + realpath + dev/ino TOCTOU 复核 + 单文件 consent + 管理员只读；原生 `*Beneath` 是强制层（CC-2885）。
- 限制：核心读 50 MiB、缩略图 20 MiB/50MP/2048、Drive 导出 30 MiB/18 分钟；写只支持 UTF-8 string。
- 索引：独立 worker；`git ls-files` + 浅 BFS 回退；`rg` + `git grep` 回退；内存索引，无磁盘库。
- Claude Desktop 的若干实现**不要照搬**：`writeLocalFile` 非原子、下载直接写最终文件名、大文件整读、父目录信任继承过宽、绝对路径直接进 renderer。

## AutoAgent 参考实现

- **路径模型**：`root_id + relative path`，SPA 永远拿不到绝对路径；原生 picker 返回的绝对路径先换成短时/命名 root。
- **SafeFileService**：
  - `resolve(root_id)` → canonical root；`lstat` 逐段；`realpath` + `commonpath` 包含校验；
  - 拒绝 NUL、`.`/`..`、绝对路径、Windows drive/UNC、控制字符；
  - `O_NOFOLLOW` + fd containment（`/proc/self/fd`）；TOCTOU 复核；
  - 原子写 temp+fsync+replace；`expectedHash` CAS；读/写/复制/扫描/行数上限；
  - NUL/UTF-8 二进制检测；不可执行文件；无 shell。
- **API**：`GET /api/files`、`/stat`、`/content`、`/download`、`/thumbnail`；`PUT /content`；`POST /mkdir|/create|/rename|/delete|/copy|/move|/upload|/reveal`（reveal 在无 desktop hook 时 501，且不返回绝对路径）。
- **上传**：raw `application/octet-stream`，**不要用 `UploadFile`** —— AutoAgent 没有 `python-multipart`，声明 `File/Form` 会让路由 import 直接失败。
- **前端**：虚拟化树、面包屑、搜索、隐藏文件、创建/重命名/删除、上传/下载/reveal、图片/二进制预览、截断保护、dirty guard、Ctrl/Cmd+S、键盘导航。

## T0 集成（详见 reference/PATCH_PLAN.md）

后端：
1. 新增 `backend/src/autoagent_backend/adapters/files/{__init__.py,safe_file_service.py}`。
2. 新增 `backend/src/autoagent_backend/api/routes/file_router.py`，修正 import 为 `...adapters.files.safe_file_service`。
3. `composition.py` 构造 `SafeFileService` 并注入 `Container`。
4. `app.py` include router（static catch-all 之前）。
5. `deps.py` 增 getter / 上传 body 上限。
6. `config.py` 增文件功能开关与大小上限。
7. 测试：`tests/unit/test_file_service.py`。

前端：
1. 新增 `frontend/src/features/files/{fileClient.ts,useFileTree.ts,FileBrowser.tsx,FilesPanel.tsx}`。
2. `api/client.ts` 增文件 API。
3. `app/Shell.tsx` 增 Files tab。

验收：
1. 列出/展开/搜索工作区；打开文本/图片；二进制拒绝或只读预览。
2. `..`、绝对路径、symlink 逃逸、未知 root 全部被拒绝。
3. 写入原子；`expectedHash` 冲突返回 409。
4. 上传/下载/缩略图正常；超限返回 413。
5. reveal 不泄露绝对路径；删除/重命名不越界。
6. 刷新后状态一致；无 shell 调用。

## 已验证

`py_compile` exit 0；`pytest` **31 passed (0.57s)**；`ruff` clean；`mypy --strict` on `file_service.py` exit 0；前端 `tsc --noEmit` TSC_OK；scratch FastAPI TestClient smoke 覆盖 list/read/write、400/403/404/409/206/413、raw upload、reveal 不泄露路径。

## 风险

- `MAX_BODY_BYTES` 1 MiB 中间件需对上传路径做例外/分级。
- `BootConfig.default_cwd` 默认 home 目录，不能成为隐式 workspace root。
- 中间目录 TOCTOU 在无 `openat2` 时只能 best-effort；symlink 密集仓库默认不能打开链接。
- `architecture.md §8.6` 的“禁止通用文件端点”表述需在合并前更新。
- 不实现 Google Drive、VM/挂载、完整索引、TCC；这些是 P2。
