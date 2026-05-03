# Claude Desktop 逆向分析报告 (二)：Artifacts 机制

## 一、存储架构

```
{Documents}/Claude/Artifacts/
├── {artifact-slug}/              ← 每个 artifact 一个目录
│   ├── index.html                ← 核心：artifact 的完整 HTML 页面
│   ├── thumbnail.png             ← 缩略图
│   └── versions/
│       ├── {timestamp1}.html     ← 历史版本快照
│       ├── {timestamp2}.html
│       └── ...                   ← 最多保留 100 个旧版本 (cPr = 100)
├── {another-artifact}/
│   └── ...
└── manifest.json?               ← artifact 索引清单
```

### 关键路径常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `__t()` | `{documents}/Claude/Artifacts` | 根目录 |
| `q6` | `"index.html"` | 主文件名 |
| `mKe` | `"thumbnail.png"` | 缩略图文件名 |
| `wKe` | `"versions"` | 版本历史目录名 |
| `cPr` | `100` | 最大保留版本数 |
| `Gce` | `"cowork-artifact-meta"` | 元数据 script 标签 ID |
| `JU` | `"cowork-artifact"` | Artifact 标识 |

## 二、数据模型

### Artifact 对象结构

```typescript
interface Artifact {
  id: string;                    // slug 化名称 (如 "my-diagram")
  name: string;                  // 人类可读名称 (如 "My Diagram")
  createdAt: number;             // Unix timestamp (毫秒)
  updatedAt?: number;            // 最后更新时间戳
  versions?: number[];           // 历史版本时间戳列表
  isStarred: boolean;            // 收藏状态
  description?: string;          // 描述文字
  mcpTools?: string[];           // 关联的 MCP 工具名
  mcpServerNames?: string[];     // MCP 服务器名
  importedAt?: number;           // 导入时间
  createdBySessionId?: string;   // 创建者会话 ID
  lastModifiedBySessionId?: string;  // 最后修改者会话 ID
  errors?: ArtifactError[];      // 错误状态
}

enum ArtifactError {
  ArtifactFolderMissing = "artifactFolderMissing"
}
```

### 内嵌元数据结构（存在 HTML 中）

```typescript
interface ArtifactMeta {
  name: string;
  schemaVersion: 1;
  description?: string;
  mcpTools?: string[];
  mcpServerNames?: string[];
}
```

### 数据库表（Operon/KV store）

```
artifacts              (ti)  — artifact 索引
artifactFolders        (dn)  — 文件夹存在性追踪
artifactVersions       (sr)  — 版本历史
artifactDependencies   (Uqt) — 依赖关系 (MCP tools 等)
```

## 三、HTML 文件格式（关键！）

`index.html` 的结构 — **元数据以 JSON 形式嵌入在 `<script>` 标签中**：

```html
<!DOCTYPE html>
<script type="application/json" id="cowork-artifact-meta">
{
  "name": "My Diagram",
  "schemaVersion": 1,
  "description": "An example artifact",
  "mcpTools": ["tool1", "tool2"],
  "mcpServerNames": ["server1"]
}
</script>
<html>
  <head>
    <meta charset="UTF-8">
    <title>My Diagram</title>
  </head>
  <body>
    <!-- artifact content goes here -->
  </body>
</html>
```

### 元数据读写

**写入 (`o2A`):**
```javascript
function o2A(html, meta) {
  // 1. 去除旧的 meta script 标签
  html = iPr(html)
  // 2. 生成新的 meta script 标签
  const metaTag = tPr(meta)
  // 3. 处理 DOCTYPE
  //    有 DOCTYPE: DOCTYPE + metaTag + 其余内容
  //    无 DOCTYPE: metaTag + 全部内容
  return r ? r[0] + metaTag + html.slice(r[0].length) : metaTag + html
}

function tPr(meta) {
  const json = JSON.stringify(meta, null, 2)
                       .replace(/<\//g, "<\\/")  // 转义 </ 防止破坏 HTML
  return `<script type="application/json" id="cowork-artifact-meta">\n${json}\n<\/script>\n`
}
```

**读取 (`s2A`):**
```javascript
function s2A(html) {
  const match = html.match(
    /^\s*<script type="application\/json" id="cowork-artifact-meta">(.*?)<\/script>\s*/is
  )
  if (!match) return null
  try {
    return JSON.parse(match[2])
  } catch {
    return null
  }
}
```

## 四、ID 生成规则

```javascript
function FF(input) {
  const slug = input
    .toLowerCase()                          // 转小写
    .replace(/\s+/g, "-")                   // 空格 → 连字符
    .replace(/[^a-z0-9_-]/g, "")            // 去除非允许字符
    .replace(/^[-_]+|[-_]+$/g, "")          // 去头尾特殊字符

  // 必须包含至少一个字母数字
  if (!slug || !slug.match(/[a-z0-9]/))
    throw new Error("Invalid task name: must contain at least one alphanumeric character")

  return slug
}

// 然后从 slug 生成显示名:
// "hello-world" → "Hello World"
function cHt(slug) {
  return slug.replace(/-/g, " ")
             .replace(/^./, (c) => c.toUpperCase())
}
```

## 五、全部 IPC 接口

接口名: `CoworkArtifacts`，IPC 通道前缀: `claude.web`

| 方法 | 参数 | 返回 | 功能 |
|------|------|------|------|
| `getAllArtifacts` | — | `ArtifactWithDiskStatus[]` | 获取所有 artifact + 磁盘状态检查 |
| `getArtifactMetadata` | `artifactId: string` | `ArtifactMeta` | 从 HTML `<script>` 中提取 JSON 元数据 |
| `getArtifactThumbnail` | `artifactId: string` | `string (base64)` | 读 `thumbnail.png` 返回 base64 |
| `getArtifactIndexHtmlPath` | `artifactId: string` | `string (绝对路径)` | 返回 `index.html` 的绝对路径 |
| `deleteArtifact` | `artifactId: string, removeFiles: boolean` | `void` | 删除 artifact（可选保留文件） |
| `exportArtifact` | `artifactId: string` | `文件路径` | 打包为 `.zip` 导出 |
| `importArtifact` | — | `{ok, artifactId, artifactName, pendingMcpTools?, mcpServerNames?}` | 从 `.zip` 导入（含冲突检测） |
| `showArtifact` | `artifactId: string, bounds: Rect, version?: number` | `void` | 在独立窗口中显示 artifact |
| `hideArtifact` | — | `void` | 关闭当前 artifact 窗口 |
| `parkAndCaptureArtifact` | `bounds: Rect` | `void` | 停靠并截图 |
| `reloadArtifactView` | — | `void` | 刷新 artifact 窗口 |
| `printArtifactToPdf` | — | `void` | 打印为 PDF |

## 六、核心操作流程

### 创建 Artifact

```
create(name, html, options):
  1. slug = FF(name)                          // 生成 ID
  2. isSlugTaken(slug) → 检查是否冲突
  3. displayName = cHt(slug)                  // 生成人类可读名
  4. meta = { name, schemaVersion: 1, ...options }
  5. mkdir(Artifacts/{slug})
  6. writeFile(index.html, o2A(html, meta))   // 写入含 meta 的 HTML
  7. artifact = { id: slug, name: displayName, createdAt: Date.now(), isStarred: true, ... }
  8. artifacts.set(slug, artifact)            // 写入内存
  9. saveManifest()                            // 持久化清单
  10. emit("changed")                          // 通知 UI 更新
  11. 埋点: cowork_artifacts_created
  12. return artifact
```

### 更新 Artifact

```
update(id, newHtml, options):
  1. 读取当前 artifact
  2. 提取当前 meta (s2A)
  3. 合并新 meta 字段
  4. mkdir(versions/) (如果不存在)
  5. copyFile(index.html → versions/{currentUpdatedAt}.html)  // 保存旧版本
  6. versions.push(oldTimestamp)
  7. 如果 versions.length > 100: 删除最旧的
  8. writeFile(index.html, o2A(newHtml, mergedMeta))          // 写入新版本
  9. 更新内存记录
  10. saveManifest() + emit("changed") + emit("updated", id)
  11. 埋点: cowork_artifacts_updated
```

### 版本回退

```
restoreVersion(id, timestamp):
  1. copyFile(versions/{timestamp}.html → index.html)
  2. 触发 update 逻辑保存当前版本
```

### 删除 Artifact

```
deleteArtifact(id, removeFiles):
  1. removeFiles=true → rm(Artifacts/{id}/, recursive)
  2. artifacts.delete(id)
  3. saveManifest()
  4. emit("changed")
```

### 导出 Artifact

```
exportArtifact(id):
  1. 读取 artifact 元数据
  2. 将 index.html 打包为 {name}.zip
  3. 返回 zip 文件路径
```

### 导入 Artifact

```
importArtifact():
  1. 弹出文件选择器 (仅 .zip)
  2. 解压 zip
  3. 查找 index.html (跳过 __MACOSX)
  4. s2A(html) 提取元数据
  5. 从文件名或 meta.name 生成显示名
  6. FF() 生成 slug → 冲突检测
  7. mkdir + writeFile
  8. 提取 mcpTools / mcpServerNames
  9. 写入 artifact 记录
  10. saveManifest() + emit("changed")
  11. 埋点: cowork_artifacts_imported
```

## 七、内置 JS 库白名单

Artifact HTML 可通过 CDN 引用预置库（带 SRI 子资源完整性校验）：

| 库 | URL | SRI |
|----|-----|-----|
| Chart.js v4.5.0 | `jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js` | `sha384-iU8HYtnGQ8Cy4zl7gbNMOhsDTTKX02BTXptVP/vqAWIaTfM7isw76iyZCsjL2eVi` |

> 更多库引用在 `Uce` 和 `Fce` 数组中定义，只允许白名单 URL (`nPr` set)

## 八、Manifest 持久化

```
manifestPath → 存储 artifact 索引的 JSON 文件
saveManifest(): JSON.stringify([...artifacts.values()]) → writeFile(manifestPath)

load(initCounter):
  - 并发保护: 只有 initCounter 匹配时才更新
  - 读取 manifest → JSON.parse → 逐个 set 到 map
  - 非空时 emit("changed")
```

## 九、错误处理

| 错误类型 | 触发条件 |
|----------|----------|
| `ArtifactFolderMissing` | `access()` 检查时目录不存在 |
| `"Artifact \"X\" already exists"` | 创建时 slug 冲突 |
| `"Artifact \"X\" not found"` | 更新/删除时找不到 |
| `"Artifact manager not initialized"` | manifestPath 未设置 |
| `"artifactFolderMissing"` | getAllWithDiskStatus 检测到目录丢失 |

## 十、关键结论

1. **Artifact 的本质是一个 self-contained HTML 页面**，完全存储在本地文件系统 `Documents/Claude/Artifacts/{slug}/index.html`
2. **元数据嵌入在 HTML 中** (`<script id="cowork-artifact-meta">`)，而非单独文件或数据库 — 这样 artifact 文件可以独立分发和导入
3. **数据库只存索引** (id, name, createdAt 等查询字段)，不存实际内容
4. **MCP 工具可以绑定到 artifact** — 通过 meta 中的 `mcpTools` 和 `mcpServerNames` 字段
5. **版本管理是纯文件系统操作** — `copyFile` + 定期清理，简单可靠，最多保留 100 个版本
6. **导入 = 解压 zip 查找 index.html**，导出 = 打包目录为 zip
7. **跨平台路径**: `{userData/documents}/Claude/Artifacts/`
8. **安全措施**: CDN 库白名单 + SRI 校验，HTML 中 `</` 转义防止注入
