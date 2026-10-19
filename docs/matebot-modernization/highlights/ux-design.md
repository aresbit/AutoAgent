# Claude Desktop UX 与设计系统亮点（2.42304.0 Linux）

> 范围：`/home/tars/yysapp/claude-desktop/app`（桌面包 renderer 壳层）与
> `/home/tars/yysapp/claude-desktop/extracted/usr/lib/claude-desktop/resources`
> （ion-dist 网页主体、字体、locale）。只读分析，未修改 `app` 或 `extracted`。
> 结论标记：**[已证实]** 有直接代码/资产证据；**[推断]** 由证据组合推出；
> **[未知]** 未定位到实现或无法验证。文中“offset”是文件内字符偏移，便于复核。

---

## 0. 结论速览（按影响与独特性排序）

| # | 亮点 | 评级 | 为什么值得注意 |
|---|------|------|----------------|
| 1 | 设计令牌六层模型（palette → ramp → elevation → purpose → density → motion） | A+ | 组件只消费 purpose 层；模式、密度、品牌色一次切换即可全局生效，避免逐组件暗色补丁。 |
| 2 | 滚动边缘渐隐用 CSS scroll-driven animation 实现，无 JS 监听 | A+ | 7 段非线性 alpha 渐变 + `mask-composite:intersect`，双向/横纵/RTL 全支持，主线程零成本。 |
| 3 | 流式跟随滚动控制器（24px 判定、触摸/隐藏暂停、质量计数器） | A+ | 不是“滚到底”那么简单：区分用户触摸、标签隐藏、程序写入、迟到帧，并上报 pinned/written/late/missed/settled。 |
| 4 | 启动占位帧（boot placeholder）复用上次侧栏布局 | A+ | 第一帧就画出接近真实布局的侧栏骨架（默认 288px、<700px 折叠、缩放同步），并保留 48px 拖拽条，消除白闪。 |
| 5 | 双环焦点 + 禁用原因焦点重路由 | A | 内环用页面底色“挖空”，外环 accent + 6px 光晕；禁用控件失去焦点时把焦点移到邻近可用控件。 |
| 6 | 输入法合成守卫与 500ms 后合成抑制 | A | 同时检查 `isComposing`、`keyCode 229`、`Process`；合成结束后的短暂窗口内 Enter 不误发送。 |
| 7 | 复制衰减 hook（2s、富文本、过期调用保护） | A | 复制成功 2s 后回落；同一 hook 服务消息、代码块、链接；带 `role="status"` 的屏幕阅读器反馈。 |
| 8 | 标题栏 overlay 随主题、缩放、无痕、模态遮罩联动 | A | overlay 高度按缩放计算（36px 基准、最小 24px），无痕模式 44px 且用实色，模态时与遮罩色合成。 |
| 9 | 查找栏的 CJK 特化与焦点归还 | A | 拉丁文要求 >2 字符，汉字/假名/韩文 2 字符即搜；250ms 防抖；关闭后 10ms 归还焦点。 |
| 10 | 本地执行同意页的“无框架 + 500ms 输入保护” | A | 同意页不运行 Web 来源可影响的栈，内容只用 `textContent`；按钮在窗口显示后 500ms 内忽略点击。 |
| 11 | Quick Entry 的 “skooch” 边缘避让与焦点恢复 | A | 606×470 透明浮窗，按内容重排；贴边时自动内移 30px；关闭后 30s 内尽量恢复原前台应用。 |
| 12 | 离线小游戏作为连接失败兜底 | B+ | 错误页可嵌入可玩的 micro-game（`role="application"`、Space 开始、reduced-motion 感知），把挫折点转成品牌记忆点。 |
| 13 | 设计系统治理：CSS layer 顺序、legacy pins、暗色字重补偿 | B+ | 迁移期不“混搭漂移”，每个 pin 有消费者/删除条件；主窗口主动选择 CDS 暗色字重策略。 |
| 14 | 43 个唯一 locale + ICU 复数 + 前缀回退 | B+ | 桌面 43 个 locale、65 个 JSON 文件；`react-intl`，49 条 plural、1 条 select，按系统语言精确→前缀→en-US 回退。 |
| 15 | 命令面板/查找/快捷键的统一菜单加速器 | B | `CmdOrCtrl+K` 命令面板、`CmdOrCtrl+/` 快捷键表、`CmdOrCtrl+B` 侧栏、`CmdOrCtrl+F` 查找；标准但完整。 |

**一句话判断**：Claude Desktop 的 UX 强项不在“更多控件”，而在**手感工程**：它把
滚动、焦点、IME、复制、加载、窗口遮挡这些容易被忽略的边角，做成了有明确常量、
降级路径和可观测指标的子系统。视觉上克制的根源是强约束的令牌系统，而不是组件数量。

---

## 1. 设计系统

### 1.1 令牌分层（来自包内嵌的 CDS 文档）

`app/.vite/build/index.chunk-bli2ILAi.js` 内嵌了一份由 `packages/cds` 生成的 CDS
使用文档（约 offset 2.8k 起），明确给出六层模型：

| 层 | 令牌 | 说明 |
|----|------|------|
| 1 基础色板 | `--{hue}-{stop}` | 9 个色相、36 档；0=`#fff`、900=`#0b0b0b`；模式稳定。 |
| 2 主题 ramp | `--neutral-N`、`--alpha-N` | `neutral-N` 亮色=gray-N、暗色=gray-(900-N)；`alpha-N` 是 neutral-900 的固定透明度，天然随模式翻转。 |
| 3 高度 | `--surface-{0..3}` | 0 最暗、3 最亮；亮暗都保持这个序数语义。 |
| 4 用途 | `--surface-{popover,panel}`、`--text-*`、`--fill-*`、`--bg-*`、`--border-*`、`--on-*` | **组件只消费这一层**。 |
| 5 密度 | `--h-control*`、`--pad-*`、`--gap-*`、`--radius`、`--font-size-*`、`--leading-*` | rem 长度（px ÷ 16），由 `[data-density]` / `[data-step]` 重映射。 |
| 6 动效 | `--dur-*`、`--ease-*` | 与模式/密度无关，保证“同一种手感”。 |

文档中的硬规则值得单独摘出：
- **文字禁止用 opacity 做弱化**，必须用 `--text-secondary` / `--text-muted`；opacity 会与背景相乘而漂移。
- **一屏最多一个 accent-filled 主按钮**；烟土色（clay/brand）只留给 Claude 发起的动作（发送、生成、spark），普通用户 CTA 用中性 accent。
- **最多两层浮动高度**（panel/popover）；需要第三层就应改用 Dialog。
- **默认更安静**：secondary 是默认按钮；避免禁用按钮，优先“可点击后解释”；密集列表用带边框行而不是圆角卡片。
- **衬线是 Claude 的声音**（`--font-voice`），周边 chrome 保持 sans。

**[已证实]** 文档原文、层级表与规则均在 `index.chunk-bli2ILAi.js`。
**[推断]** 这份文档被随包分发，说明团队把“给模型读的设计系统说明书”也当作产品交付物；
它与 CDS 令牌的同源性使 Claude 生成 UI 时更容易命中同一套约束。

### 1.2 颜色与表面

基础灰阶（`MainWindowPage-DTxMhyWF.css`，`:root`/品红块）：

```
gray-0 #fff      gray-10 #fcfcfb   gray-20 #f9f9f7   gray-30 #f6f6f4
gray-40 #f3f3f0  gray-50 #f0efec   gray-60 #edece8   gray-70 #eae9e4
gray-80 #e7e6e1  gray-90 #e4e3dd   gray-100 #e1e0d9  gray-150 #d2d1c7
gray-200 #c3c2b7 gray-300 #a5a49a  gray-400 #898781  gray-500 #6d6b67
gray-600 #52514e gray-700 #383835  gray-750 #2c2c2a  gray-800 #20201f
gray-850 #151515 gray-900 #0b0b0b
```

| 语义 | 亮色 | 暗色 |
|------|------|------|
| `--surface-0` / 页面 | `gray-20 #f9f9f7` | `gray-900 #0b0b0b` |
| `--surface-1` / 行内卡片 | `gray-10 #fcfcfb` | `gray-850 #151515` |
| `--surface-2` / panel | `gray-0 #ffffff` | `gray-830 #1a1a19` |
| `--surface-3` / popover | `gray-0 #ffffff` | `gray-800 #20201f` |
| `--text-primary` | `neutral-900` | `gray-50 #f0efec` |
| `--text-secondary` | `neutral-600 #52514e` | `gray-200 #c3c2b7` |
| `--text-muted` | `neutral-400 #898781` | `gray-400 #898781` |
| `--border` | `alpha-2`（neutral-900 10%） | 同一 token，翻成白 10% |
| accent（用户动作） | `blue-450 #2a78d6` | 同色相，暗色用较低档位 |
| brand（Claude 动作） | `clay #d97757`，hover `#c6613f` | 同名角色，不换语义 |

关键细节：
- `surface-0..3` 的序数不是“越高越亮”，而是“0 最暗、3 最亮”；亮色下 2/3 都是白，
  靠边框/阴影区分；暗色下用 900→850→830→800 四级微差。**[已证实]**
- `--alpha-N` 用 `hsl(from var(--cds-neutral-900) h s l / N%)` 表达，因此“黑洗/白洗”
  自动随模式翻转，组件无需写两套。**[已证实]**
- 文字角色禁用 opacity；`--text-disabled` 才用 alpha-4。**[已证实，来自内嵌文档与 CSS]**

### 1.3 密度、尺寸与局部缩放

`<html class="cds-root" data-mode="system" data-density="comfortable" data-platform="desktop">`
是主窗口、Quick Entry、About、Buddy、Find-in-page 的共同根标记。**[已证实]**

| 令牌 | compact（基础 `.cds-root`） | comfortable（`[data-density=comfortable]`） |
|------|------------------------------|----------------------------------------------|
| `--cds-radius` | 6px | 8px |
| `--cds-radius-composer` | 12px | 14px |
| `--cds-h-control` | 24px | 32px |
| `--cds-icon` | 16px | 20px |
| pad xs/sm/md/lg/xl | 4 / 6 / 8 / 12 / 20px | 6 / 8 / 12 / 16 / 24px |
| gap xs/sm/md/lg/xl | 6 / 8 / 12 / 20 / 32px | 8 / 12 / 16 / 28 / 40px |
| body | 13px / 19px | 14px / 20px |
| prose | 14px / 20px | 16px / 24px |
| title | 20px / 25px | 22px / 28px |
| code | 12px / 17px | 13px / 19px |

说明：
- 桌面壳层固定声明 `comfortable`；**基础 `.cds-root` 本身就是 compact 尺度**，
  所以 `[data-density=compact]` 没有覆盖块也会回落到基础值。**[已证实]**
- `data-step="1".."5"` 是**局部尺寸缩放**，与全局密度正交：把工具栏、嵌套控件按
  12/13/14/14/15px body、20/24/28/32/40px 控件高度重排。**[已证实]**
- `data-size="xs|sm|lg"` 再提供组件级 t-shirt 尺寸（radius/height/icon/pad/font/leading）。**[已证实]**
- 所有尺寸都乘 `--cds-rem-scale`，为浏览器缩放/根字号调整留了口子。**[已证实]**
- 主窗口 `minWidth:600, minHeight:400`，窄于 700px 时启动占位帧自动折叠侧栏。**[已证实]**

### 1.4 排版

| 项 | 证据/值 |
|----|---------|
| Sans | `anthropic-sans`，variable，CSS 声明 `font-weight:300 800`，`font-display:swap`，`font-feature-settings:"dlig" 0`。 |
| Serif | `anthropic-serif`，同样 300–800、Roman/Italic 各一份；用于 `--font-voice`。 |
| Mono | `--font-anthropic-mono, "SF Mono", ui-monospace, Menlo, Consolas, monospace`；桌面壳层未找到该字体的 `@font-face`，实际大概率回落到 SF Mono/ui-monospace。 |
| 字重 | regular 400、medium 500、semibold 580、bold 600；variable 轴配合 `GRAD` 180/200。 |
| 光学尺寸 | `font-optical-sizing:auto`；字体内部有 Text/Display 两套命名实例。 |
| 回退链 | 显式覆盖 CJK（PingFang、Hiragino、Apple SD Gothic）、天城文、孟加拉、泰卢固、泰米尔、古吉拉特、马拉雅拉姆、卡纳达、泰文、埃塞俄比亚文。 |
| 渲染 | `-webkit-font-smoothing:antialiased`、`text-rendering:optimizeLegibility`、`font-synthesis:none`。 |
| 文字大小设置 | `data-text-size=sm|md|lg` 只作用于助手/用户消息与排队消息：sm prose 13/19、md 14/20、lg 15/22。 |

**[已证实]** `@font-face`、字体栈与字号令牌见 `MainWindowPage-DTxMhyWF.css`
（@font-face 约 250k；字体栈约 248k；字号块约 178k–210k、232k）。
**[推断]** “衬线是 Claude 的声音”在实现中主要体现在标题/voice 类（`font-voice`）
与部分响应表面；并非每一条助手正文都强制 serif。不要把它误读为“整套聊天改用衬线”。

一个容易被忽略的细节：输入控件有 `--cds-font-size-text-entry-floor:16px`，
用于避免移动端聚焦输入框时被浏览器放大。**[已证实]**

### 1.5 动效

| 令牌 | 值 | 用途 |
|------|----|------|
| `--cds-ease-out` | `cubic-bezier(.165,.84,.44,1)` | 默认衰减 |
| `--cds-ease-snap` | `cubic-bezier(.32,.72,0,1)` | 快速进入/消息操作显现 |
| `--cds-ease-overshoot` | `cubic-bezier(.34,1.3,.64,1)` | pill/pop 的轻微过冲 |
| `--cds-dur-fast` | 60ms | 按下、操作条淡出 |
| `--cds-dur-snap` | 120ms | 操作条淡入、pill 进出 |
| `--cds-dur-base` | 200ms | 常用过渡 |
| `--cds-dur-sheet` | 300ms | sheet |
| `--cds-dur-slow` | 450ms | 弹簧释放、卡片 clip-path |
| `--cds-btn-spring` | `linear(0,.2459,.6526,.9468,1.0764,1.0915,1.0585,1.0219,.9993,.9914,.9921,.9957,.9988,1.0004,1)` | 用 CSS `linear()` 近似弹簧，无 JS 弹簧库 |

可分层的“手感配方”：
- **按钮按下**：scale `0.975`，60ms ease-out；松开用 450ms spring，形成“压下去很快、回弹有阻尼”的质地。**[已证实]**
- **卡片按下**：scale `0.99` + `clip-path` 内缩 2px，同样按下快、松开弹。**[已证实]**
- **消息操作条**：默认 opacity 0；hover 进入 120ms snap，并**延迟 100ms** 才显现，避免鼠标划过整列消息时闪烁；离开 60ms 消失；键盘 `focus-within` 与 popup 打开则**立即**显现。这是一个非常成熟的 hover/focus 折中。**[已证实]**
- **骨架屏**：默认延迟 500ms 才出现（快加载不闪骨架），150ms 淡入，2s 呼吸；wave 模式每项错开 90ms；另有 2s 扫光。`prefers-reduced-motion` 下扫光隐藏、动画压到 0.01ms。**[已证实]**
- **滚动渐隐**：见 2.2。**[已证实]**
- **工作点/光晕**：`cds-working-dot-halo` 2.5s、`cds-dot-pulse` 1.8s。**[已证实]**

减少动态：
- 13 处 `@media (prefers-reduced-motion:reduce)` 规则；
- 70 处 `[data-reduce-motion=true]`（应用内手动开关）选择器；
- 覆盖按钮/卡片/pill/骨架/扫光/文字 shimmer/flipbook/工作点/评论 landing/附件过渡；
- 同时保留 `:focus-visible` 的静态反馈。**[已证实]**

### 1.6 焦点、阴影与高度

- **焦点双环**：
  `--cds-focus-shadow: inset 0 0 0 1px var(--cds-page-bg), 0 0 0 1px var(--cds-fill-accent), 0 0 6px 1px var(--cds-bg-accent)`。
  内环用页面底色“挖空”出 1px 缝，外环 accent 1px，再加 6px 光晕；危险场景换成 danger 版本。
  所有控件统一 `:focus-visible`，并保留 `outline:2px solid transparent` 供 forced-colors 使用。**[已证实]**
- **发丝环**：`--cds-ring-hairline` 在 2x/3x/4x DPI 下分别 0.5px、1/3px、1/4px，避免“1px 看起来太粗”。**[已证实]**
- **阴影**：sm/md/lg 双层（接触阴影 + 扩散阴影），`--shadow-color` 暗色加深到约 24%；popover 固定双层 `0 8px 24px /12%, 0 2px 6px /8%`。**[已证实]**

### 1.7 设计系统治理（工程侧但直接影响 UX 一致性）

- `window-shared.css` 首行必须是裸 `@layer cds-card;`，随后 `@import "tailwindcss"` 与
  `@import "@ant/cds/theme.css"`；注释明确写出“破坏顺序会静默失败”。**[已证实]**
- 暗色模式默认会**降低无字重文字的字重**以避免“暗底白字显胖”；主窗口/壳层通过
  `@ant/cds/root-weight-pin.css` 主动关闭该补偿，把字重决策收回产品。**[已证实]**
- 旧界面迁移采用 `window-legacy-pins.css`：把 `rounded`、`font-bold`、`font-mono`、
  `space-y-2`、按钮 cursor、`b/strong` 等逐项钉回 Tailwind v3 值；每个 pin 都有
  “最后一个消费者移除后删除”的规则。**[已证实]**
- 这套“layer 顺序 + 显式 pin + 逐面移除”比简单全局替换更贵，但能避免迁移期视觉漂移；
  是 CDS 能在多个窗口/多代界面上共存的原因。**[推断]**

---

## 2. 交互细节与证据

### 2.1 启动占位帧（boot placeholder）

主窗口 `index.html` 在第一帧前就执行内联脚本，读取 `globalThis.desktopBootPlaceholder`：

- 默认布局：侧栏宽 288px、窄视口阈值 700px；侧栏形状为 4 个导航行（高 36/56/60/72）、
  一个分组标题、5 个会话行（宽度比例 0.68/0.54/0.44/0.68/0.54），圆角 3–4px。
- 形状数量上限 160；所有坐标乘 `frame.zoomFactor / shellZoomFactor`，因此窗口缩放时
  占位骨架与应用布局同步。
- 侧栏折叠（`collapsed` 或 `innerWidth/scale <= narrowViewportMaxWidth`）时只保留
  一条 48px 高的顶部拖拽条。
- 布局持久化键：`bootFrameLayout`、`bootSidebarPlaceholder`；下一次启动直接复用。
- 出现 `data-load-error-overlay` 时占位侧栏自动隐藏，避免与错误页叠加。
- 占位层 `pointer-events:none`，不抢焦点；主窗口错误页本身整体是 `nc-drag`，内部控件
  `nc-no-drag`。

**[已证实]** `app/.vite/renderer/main_window/index.html` 全文；
`app/.vite/build/index.chunk-Z7WxBjyE.js` 中 `hqn`（约 offset 3208246）、`vqn`（3208736）。

**判断**：这比“空白 + spinner”贵不了多少，却显著改善冷启动的“确定感”。默认布局来自
上次真实布局，而不是硬编码，所以占位帧看起来像“尚未绘制的应用”，不像 loading 页。
这是最值得低成本复刻的亮点之一。

### 2.2 聊天、流式与滚动

**滚动边缘渐隐（CSS-only）**

`ion-dist/assets/v1/c6a992d55-sXiDGMFQ.css`（约 offset 243107）：

- `.scroll-fade` 的 mask 是 14 个色标：上下各 7 段，alpha 从 0 经
  `0.15/0.3/0.45/0.6/0.75/0.87` 到实色，形成非线性渐隐；
- 横向同理；`mask-composite:intersect` 保证四边同时裁切；
- `animation-timeline:scroll(self)` / `scroll(self inline)` 驱动
  `--cds-scroll-fade-*`，完全不需要 `scroll` 事件；
- RTL 下左右 raw 值互换（`:root[dir=rtl] :dir(rtl)`）；
- `scroll-fade-strip-top/bottom` 还提供 28px 的 sticky 渐隐条，作为不支持
  scroll-driven animation 时的可见降级。

**流式跟随**

`ion-dist/assets/v1/shared-104-Cqo2-vQh.js` 与 `c4a9ee384-ZZIKqgNM.js`：

- 跟随判定容差 `nb=24`（距底部 24px 内视为 pinned）；种子中的“40px/120px”在
  两个 bundle 中未找到，实际常量是 24px。**[已证实；种子数值需修正]**
- 暂停条件：用户触摸中（`isTouchHeld`）、文档隐藏（`lastHiddenAt`）、探针超时
  （2s，`fb=2000`）、以及“迟到帧”超过 1.5 帧（`Ny=1.5`，按刷新率折算）。
- 用户发送时主动 `scrollToBottom("smooth")`；另有 `transcript:jump-to-latest`
  事件与“跳到最新/需要输入”的浮动按钮。
- 质量计数器：`pinnedSteps / writtenSteps / lateSteps / missedSteps / settledSteps /
  touchSteps / lagMsTotal / lagMaxMs`，并有 `follow_*` 遥测字段；还记录
  `scroll_draw` 采样率。
- 隐藏标签、触摸、程序写入、用户读取分别计数，说明团队把“滚动跟手”当作可回归的
  性能指标，而不是主观感觉。

**[已证实]** `shared-104-Cqo2-vQh.js` offset 约 149304（Ny）、153557
（distanceFromBottom）、155376（指标）；`c4a9ee384-ZZIKqgNM.js`
（follow controller / jump-to-latest）。
**[未知]** 具体的 token 级文本“打字机”节奏；未定位到聊天正文的逐字 reveal 常量。
**[未知]** 40px/120px 两个阈值未在任何分析过的 bundle 中出现。

**消息布局**

- 用户消息/气泡助手：`--cds-message-bubble-radius = --cds-radius + .25rem`；
  `--cds-message-bubble-measure:85%`，窄屏 `clamp(85%,448px,100%)`。
- 气泡堆叠：stack gap 4px、相遇边圆角 4px、相邻气泡用负 margin 贴合；
- 助手默认文本内缩 4px，`--cds-assistant-message-text-stop:
  clamp(0px,(100% - 384px)*.175,56px)`，让正文在大屏下保持可读行宽而不是铺满。
- 消息操作条与正文解耦，操作条出现不改变布局。**[已证实]**

**代码块**

- 代码块复制按钮复用同一个 copy hook，标签 `Copy code` / `Copied!`，带 tooltip 与
  `aria-label`；生成式 UI 中的操作按钮在流式期间保持 `hidden`，完成后才出现。
- 行号设置由本地编辑器配置控制（`on`/`relative`/`interval`），不是每块临时开关。
**[已证实]** `c05b96c7f-DklIyA-P.js` 约 53k；ion-dist 中 `Copy code` 相关片段。

### 2.3 Composer、IME 与命令

- Composer 是富文本/contenteditable 结构（`data-cds=ChatComposerEditor`），
  空态用 `data-composer-placeholder-ghost` + `[data-doc-empty=false]` 隐藏占位，
  避免 placeholder 与真实内容叠加。**[已证实]**
- 发送判定（`shared-3-DnHYUZdJ.js` 约 322k）：
  - `fW`: Enter、无 Shift/Alt、非合成、非（平台相关）后合成窗口、且
    （平台默认或 Meta/Ctrl）才发送；
  - `hW`: 还要求 `!disabled && !mentionMenuOpen && !slashMenuOpen`。
  - `cW`: `isComposing || keyCode 229` 直接拦截；`Process` 键也拦截；
    合成结束后留下约 500ms 的抑制窗口，防止候选词确认的 Enter 直接发送。
- Slash 菜单与 @mention 菜单是独立浮层，打开时 Enter 交给菜单，不发送消息。**[已证实]**
- 快捷键：
  - `CmdOrCtrl+K` 命令面板；
  - `CmdOrCtrl+/` 键盘快捷键表；
  - `CmdOrCtrl+B` 侧栏；
  - `CmdOrCtrl+F` 查找；
  - `CmdOrCtrl+G` / `Shift+G` 查找下一个/上一个（`CmdOrCtrl` 在 UI 上按平台显示为
    Ctrl/Command，并提供“spoken”标签给屏幕阅读器）。
  **[已证实]** `app/.vite/build` 菜单加速器与 find-in-page 常量。
- Quick Entry：Enter 发送、Escape 关闭、点击外部聚焦输入框、滚轮滚动 textarea、
  输入 750ms 防抖后请求窗口重排（`requestSkooch`）；`maxlength=16384`。
  **注意**：其 Enter 监听没有 `isComposing` 守卫，是明确的 IME 缺口。**[已证实]**

### 2.4 复制衰减

`ion-dist/assets/v1/shared-1-CAAiD7E3.js`（约 offset 236718）的 `MP({timeout=2000,trim=true})`：

- 成功复制后 `didCopy=true`，2s 后自动复位；重复复制会清除旧 timer；
- 用自增序号丢弃过期的异步 clipboard 结果；
- 优先写 `text/html + text/plain` 的 `ClipboardItem`，失败回退 `writeText`；
- 默认 trim；
- UI 同时显示视觉态（Check + “Copied”）与 `role="status"` 的 sr-only 文案。
- 同一个 hook 服务消息、代码块、链接、Webhook URL 等，保证反馈一致。

**[已证实]** 该 hook 定义与调用点；代码块、消息操作条、链接复制均引用同一模式。

### 2.5 窗口与多窗口

| 窗口 | 关键参数 | UX 决策 |
|------|----------|---------|
| 主窗口 | `minWidth:600,minHeight:400`；`titleBarStyle:"hidden"`、`titleBarOverlay:true`；背景取主题色 | 请求隐藏标题栏 + 原生 overlay；启动可 `show:false` 等 ready-to-show；带 boot placeholder。 |
| 标题栏 overlay | 基准 36px，按 zoom 取整、最小 24px；无痕模式 44px；亮/暗 symbolColor `#3d3d3a`/`#c2c0b6`，无痕 `#fff`/`#000` | 高度与缩放同步，避免高 DPI 下标题区错位；无痕/模态各自有明确视觉态。 |
| 非主窗口标题条 | 36px，标题 12px、opacity 40%，底部 1px 分隔 | 统一壳层窗口；主窗口不渲染该条（由网页侧负责）。 |
| Quick Entry | 606×470，透明、无边框、`pop-up-menu`、skipTaskbar、无阴影 | 606×470 足够一屏短提示；透明圆角由网页绘制；位置按显示器相对坐标持久化。 |
| “Skooch” | 贴底/贴右时内移 30px | 浮窗不会越过工作区；内容变高时自动重排。 |
| About | 320×428，`modal:true`、hiddenInset、skipTaskbar | 小而固定，避免“关于”页变成第二个主窗口。 |
| Buddy | 700×460，hiddenInset，背景 `#F4F3EE` | 设备配对/固件页有独立暖色背景。 |
| Local exec consent | 无边框、模态；500ms 输入保护；手动 focus trap | 信任面：不运行 Web 来源可影响的栈。 |
| Find in page | 不是独立窗口，而是主窗口上的透明 `WebContentsView`；320px 宽、compact 40 / comfortable 48 高；offset 12，padding 8/16/24 | 浮层不打断页面；关闭后 10ms 归还焦点。 |
| SableOtter HUD | 无边框/透明/置顶；默认 460×72；宽 120–620、高 40–520；caret 锚定，空间不足自动翻到上方 | 文本工具贴在光标旁；无交互内容时可点击穿透。 |

**证据**：`index.chunk-Z7WxBjyE.js` 的 `PSe`/`V2a`（主窗口）、`tKn`（overlay，约 3187858）、
`T4r/E4r/D4r` 与 `requestSkooch`（约 4378197/4381819）、About/Buddy 的 `BrowserWindow`；
`index.chunk-q0jzbo6d.js`（SableOtter）；`find_in_page` 渲染器常量。

**[推断]** 主窗口显式请求 `titleBarStyle:"hidden"` + `titleBarOverlay:true`，但
`setTitleBarOverlay` 的异常会被捕获并记为“expected”，这在 Linux 上通常意味着
原生 overlay 不可用。Linux 最终是自绘标题栏还是系统边框，需要真机截图确认。**[未知]**

### 2.6 查找栏

`app/.vite/renderer/find_in_page/assets/FindInPage-B0JEOIxH.js`（约 62k）：

- 语义：`role="search"`；输入框 `aria-label`/placeholder 均为 “Find in page”；
  匹配计数是 `role="status"`，用 `tabular-nums` 防抖动。
- 搜索：250ms 防抖；**拉丁文 >2 字符、CJK 2 字符**即可搜索
  （`/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u`）。
- 显示：宽 320，compact 40 / comfortable 48 高；`VIEW_PADDING {top:8,x:16,bottom:24}`；
  offset 12；密度来自主进程 store，随应用密度变化。
- 焦点：显示后延迟 100ms 聚焦；若距上次聚焦超过 400ms 才 `select()`，避免连续打开时
  误全选；关闭后 `setTimeout(...,10)` 把焦点还给页面。
- 键盘：Enter 下一个、Shift+Enter 上一个、Escape 关闭；上下按钮有 `aria-label`
  与带平台格式的 `title`（如 “Next match (Ctrl+G)”）。
- 空查询或 0 结果时按钮禁用，但仍保留计数区域。

这是“小浮层也认真做 i18n 与焦点”的典型。

### 2.7 错误、空态与离线小游戏

- 主窗口加载错误覆盖层从标题栏下方 36px 开始，整体是拖拽区，内部控件 `nc-no-drag`；
  标题 “Couldn't connect to Claude”，描述“Check your network connection”；
  自动重试时显示 `role="status"` 的 “Retrying automatically…”；
  操作有 Reload / Restart Claude。**[已证实]**
- 错误覆盖层可承载 Clawd Quest：`role="application"`、`tabIndex=0`、
  `aria-label="Press Space to play"`；游戏读取 `prefers-color-scheme`、
  `prefers-reduced-motion`、`topInset`（标题栏高度）并响应式重排；
  拥有独立暖灰/深灰两套色板。**[已证实]**
- 空态/错误态的常规模式：`role="status"` 用于空列表，`role="alert"` 用于错误，
  并提供 “Try again” 按钮；不使用红色大色块。**[已证实，ion-dist 片段]**
- Skeleton 组支持 `data-hold=delayed|none`、`data-motion=lockstep|wave`，
  用延迟与错峰避免“骨架闪烁”。**[已证实]**

### 2.8 信任面（consent / permissions）

- 本地执行同意页：
  - 内容通过 query 传入，只用 `textContent` 渲染，避免把组织/连接器名称当 HTML；
  - 无 React、无 windowBase、无 Tailwind，字体只依赖 “Anthropic Sans Variable” 或系统栈；
  - `role="dialog" aria-modal="true"`，`aria-labelledby` / `aria-describedby` 指向动态内容；
  - 按钮在窗口显示后 **500ms 内忽略选择**（`choice arrived before input-protection window elapsed`）；
  - 手动 Tab 循环焦点；Escape 取消；窗口禁止导航与 `window.open`；
  - 对 URL 行把“显示名”和“来源 origin”拆成两个元素，避免组织名伪装成来源。**[已证实]**
- 权限文案：`Allow once` / `Allow for this session` / `Always allow` / `Don't allow`；
  位置变化会清空 “Always allowed” 列表；设备工具在 SDK 更新后需要重新批准；
  本地网络主机名有“同名不同设备”的安全提示；computer-use 场景提供
  `cmd+shift+enter` 快捷确认。**[已证实，locale + bundle]**
- 这些文案的共同点：先说明“将发生什么”，再给范围（一次/本会话/始终），最后才是按钮。
  比单纯 “Allow/Deny” 更利于形成正确的信任模型。**[推断]**

---

## 3. 可访问性

### 3.1 焦点

- 统一 `:focus-visible`，而不是 `:focus`；鼠标点击不画环，键盘/读屏才画。**[已证实]**
- 双环 + 6px 光晕（见 1.6）。**[已证实]**
- 消息操作条在 `focus-within` 时显现，键盘用户不必“hover”才能找到操作。**[已证实]**
- 禁用原因模式：带 `data-cds-disabled-reason-wrapper` 的禁用控件失去焦点时，
  焦点会在最多 2 层容器内寻找下一个可用控件；重新启用后再把焦点还回原控件。
  **[已证实]** `cfaabd194-BS-aJhBm.js` 约 8585。
- 查找栏/同意页/Quick Entry 都有明确的焦点进入、焦点归还与 Escape 行为。**[已证实]**

### 3.2 ARIA 与语义

在 ion-dist 的 bundle 中统计到（粗略但可复核）：
`aria-describedby` 682、`aria-labelledby` 727、`aria-live` 252、
`aria-expanded` 500、`aria-selected` 72、`aria-checked` 53、`aria-pressed` 221、
`aria-busy` 360、`aria-haspopup` 160、`aria-controls` 120、
`role="status"` 809、`role="alert"` 450。**[已证实，grep 计数]**

具体模式：
- 会话行是 `role="article"`，带 `aria-setsize` / `aria-posinset`，只有当前键盘行
  `tabIndex=0`（roving tabindex）。**[已证实]**
- “跳到最新”按钮同时承担状态播报：`aria-label` 在 “Scroll to bottom” 与
  “Needs your input. Scroll to the request” 间切换，隐藏时 `aria-hidden` 且
  `tabIndex=-1`。**[已证实]**
- 单选卡片用 `role="radio" aria-checked` + roving tabindex。**[已证实]**
- 复制/查找/保存等图标按钮均有 `aria-label`；复制同时给出 sr-only `role="status"`。**[已证实]**
- 命令面板/组合框使用 `aria-activedescendant`（编辑器与查找组件中可见），
  并有 `aria-keyshortcuts`。**[已证实；Claude 自有 palette 与 Monaco 编辑器需区分]**
- `inert` 用于关闭的 palette 面板/隐藏的 composer panel，避免隐藏内容进入 Tab 序。**[已证实]**

### 3.3 减少动态、强制色、粗指针

- 13 处 `prefers-reduced-motion:reduce` + 70 处 `[data-reduce-motion=true]`；
  同时覆盖入场、骨架、shimmer、工作点、评论、附件、flipbook。**[已证实]**
- 7 处 `forced-colors:active`；焦点环在强制色下回退为透明 outline + offset，
  并隐藏 shimmer clone。**[已证实]**
- 4 处 `(pointer:coarse),(hover:none)`：把 composer chin 的触控目标扩展为
  `min-height: var(--cds-h-control)`，并把按钮的负 margin 抵消，保证可点面积。**[已证实]**

### 3.4 缺口

- Quick Entry 与 SableOtter HUD 的 Enter 监听没有 IME 合成守卫。**[已证实]**
- 查找栏的 `onKeyUp` Enter 也没有 `isComposing` 判断；CJK 用户用 Enter 确认候选词时
  可能触发“下一个匹配”。**[推断，代码路径明确但未真机复现]**
- 没有发现 AccessibilityAddon/screenReaderMode 在终端中的启用；终端只设置 textarea
  aria-label。这是终端实现的已知取舍，不属于壳层设计系统。**[已证实，见 terminal 研究]**

---

## 4. i18n 与 RTL

### 4.1 资产与流程

- 桌面 `resources/*.json`：43 个 locale。
- `ion-dist/i18n/`：22 个 JSON（11 个静态 + 11 个 dynamic），与桌面 locale 大量重叠。
- 合计 65 个 JSON 文件、**43 个唯一 locale**（种子中的“53”与实际计数不符，需修正）。
- 语言覆盖：欧洲主要语言、中文简繁、日韩、阿拉伯语系外的南亚/东南亚/非洲语言
  （am、bho、bn、gu、ha、hi、ig、kn、ml、mr、ny、om、rn、rw、so、sw、ta、te、wo、yo 等）。
- **没有 ar/he/fa/ur 等 RTL locale 文件**；RTL 支持在 CDS 层存在，但本包未交付 RTL 语言。**[已证实]**
- 消息以 `defaultMessage + hashed id` 写在代码里，locale JSON 是 `id -> translation`；
  使用 `react-intl`。en-US 中 49 条 ICU `plural`、1 条 `select`、1 条富文本 `<a>`。**[已证实]**
- 语言选择：`app.getPreferredSystemLanguages()` 先精确匹配（如 `pt-BR`），再按语言前缀
  匹配（如 `pt-*`），最后回落 en-US；结果通过 `desktopPreferredLanguages` 暴露给渲染器。**[已证实]**
- Quick Entry 走同一 `DesktopIntl` bridge，并监听 `onLocaleChanged` 热切换。**[已证实]**

### 4.2 RTL 与逻辑属性

- CSS 大量使用 `margin-inline-start`、`padding-inline-start`、`inset-inline-start`。**[已证实]**
- shimmer 在 `:root[dir=rtl] :is(:lang(ar|fa|he|ur|...))` 下反向播放，并切换
  `-rtl` keyframes；scroll-fade 的左右 raw 值在 RTL 下互换；附件 transform-origin
  在 RTL 下改为 100%。**[已证实]**
- 同意页对动态标题使用 `unicode-bidi:isolate`，对 URL 明细使用
  `unicode-bidi:plaintext`，避免 RTL 文本把 origin 顺序打乱。**[已证实]**
- 查找栏在 RTL 下快捷键显示强制 LTR（`dir="ltr"`），避免 “Ctrl+G” 被重排。**[已证实]**

### 4.3 缺口

- 本地执行同意页正文**尚未本地化**，只有原生窗口标题本地化（HTML 注释明说）。**[已证实]**
- 无 RTL 交付语言，因此 RTL 的排版/焦点顺序/图标方向未得到产品级验证。**[未知]**

---

## 5. 状态设计速查

| 状态 | 模式 | 证据 |
|------|------|------|
| 冷启动 | 复用上次布局的占位侧栏 + 48px 拖拽条；缩放同步；错误时隐藏 | `main_window/index.html`；`hqn/vqn` |
| 加载中 | SkeletonGroup：延迟 500ms、150ms 淡入、2s 呼吸/扫光、wave 90ms 错峰；reduced-motion 关闭 | `MainWindowPage CSS` 约 130k |
| 流式 | 跟随滚动 24px 容差；触摸/隐藏暂停；迟到帧统计；跳转最新按钮 | `shared-104`、`c4a9ee384` |
| 复制 | 2s 衰减；视觉 + sr-only status；富文本回退 | `shared-1-CAAiD7E3.js` |
| 空列表 | `role="status"` + 轻量文本，通常带 “Try again”/下一步 CTA | ion-dist 片段 |
| 错误 | `role="alert"`；说明发生了什么 + 下一步；不暴露原始异常 | ion-dist 片段；CDS 文案规范 |
| 连接失败 | 错误覆盖层 + 自动重试状态 + Reload/Restart；可嵌入离线小游戏 | `MainWindowPage-D0WzTN0N.js` |
| 同意/权限 | 说明范围 + 一次/会话/始终；500ms 输入保护；焦点陷阱 | `local_exec_consent`；locale |
| 查找 | 250ms 防抖；CJK 2 字符；状态计数；关闭归还焦点 | `FindInPage-B0JEOIxH.js` |

---

## 6. 哪些是真正独特的，哪些是标准做法

| 决策 | 判断 | 说明 |
|------|------|------|
| 六层令牌 + 密度/step 双尺度 | 独特（工程化程度） | 很多产品有 token；少见的是把“局部缩放”和“全局密度”分开，并强制组件只读 purpose 层。 |
| CSS scroll-driven 滚动渐隐 | 独特 | 绝大多数产品用 JS 监听或静态渐变；这里把边缘渐隐做成纯 CSS、可组合、RTL 感知。 |
| 仪表化的流式跟随 | 独特 | 把 pinned/late/missed/touch 作为质量指标，超出常规“自动滚底”。 |
| 启动占位帧复用布局 | 独特 | 不是通用 skeleton，而是“上次布局的重投影”。 |
| 复制 2s 衰减 + 过期保护 | 较常见但实现扎实 | 2s 是常见值；亮点是富文本/失败回退/屏幕阅读器反馈统一。 |
| 双环焦点 | 较独特 | 多数设计系统只有单环；内环挖空 + 外环光晕在暖灰底上更清晰。 |
| IME 500ms 后合成抑制 | 较独特 | 很多 Electron 应用只判断 `isComposing`；这里额外处理候选词确认后的 Enter。 |
| 标题栏 overlay 随缩放/无痕/遮罩 | 较独特 | 原生 overlay 的常见坑是缩放后高度不对；这里显式按 zoom 计算。 |
| Quick Entry “skooch” | 独特 | 贴边避让 + 显示器相对坐标持久化 + 前台应用恢复。 |
| 同意页无框架 + 500ms 保护 | 独特 | 把信任面从 Web 技术栈中隔离出来。 |
| Tailwind v4 + CDS + legacy pins | 标准工具的严谨用法 | 价值在治理流程，不在技术本身。 |
| 命令面板、查找、快捷键 | 标准 | 完整且一致，但不是差异化来源。 |
| 变体字体 + serif voice | 标准但执行到位 | 真正有辨识度的是“clay 只给 Claude、serif 只给声音”的角色约束。 |
| 分栏/多窗口/浮窗 | 标准 | 亮点在尺寸、焦点、遮挡与恢复策略。 |

---

## 7. AutoAgent 借鉴清单

> 原则：借鉴**结构、常量与降级策略**，不要复制 Anthropic 的字体文件、图标、插画、
> Clawd Quest 或任何品牌视觉资产。字体和 clay 色属于品牌资产；AutoAgent 应换用
> 开源字体与自有强调色，只保留“角色化用色”的方法。

### P0（1–3 天，立即提升质感与正确性）

| 项 | 做法 | 成本 | 收益 |
|----|------|------|------|
| P0-1 语义令牌层 | `surface 0..3` / `text primary|secondary|muted` / `border alpha` / `accent` / `danger`；亮暗各一套；禁止组件写 hex | 1–2 天 | 暗色不再逐个打补丁；后续换肤成本接近 0 |
| P0-2 焦点可见性 | 全局 `:focus-visible` + 双环（内环底色 + 外环 accent + 6px 光晕）；`forced-colors` 保留 outline | 0.5 天 | 键盘/读屏可用性立刻达标，且视觉不突兀 |
| P0-3 复制衰减 | 2s reset、trim、自增序号防过期、`ClipboardItem` 富文本回退、`role=status` | 0.5 天 | 消除“复制后永远显示已复制”和异步竞态 |
| P0-4 IME 守卫 | `isComposing || keyCode===229 || key==='Process'`；Enter 发送前检查；菜单打开时不发送 | 0.5 天 | 中日韩用户不再误发送 |
| P0-5 减少动态 | `prefers-reduced-motion` + 应用内 `data-reduce-motion`；覆盖入场/骨架/脉冲/附件 | 0.5–1 天 | 合规与舒适度 |
| P0-6 滚动渐隐 | 28px、7 段非线性 mask；优先 CSS scroll-driven，回退静态渐变 | 1 天 | 列表/日志/消息边缘更干净，且无 JS 抖动 |
| P0-7 按钮按下/回弹 | 按下 60ms 缩放，松开 450ms `linear()` spring；同款用于卡片 | 0.5 天 | 极低成本的“高级手感” |

### P1（1–2 周，形成产品辨识度）

| 项 | 做法 | 成本 | 收益 |
|----|------|------|------|
| P1-1 流式跟随控制器 | 24px pin 容差；触摸/隐藏暂停；2s 探针超时；1.5 帧迟到阈值；跳转最新按钮 | 3–5 天 | 长回答/工具输出时体验稳定，不“抢滚动” |
| P1-2 启动占位帧 | 持久化侧栏宽度/折叠状态/骨架形状；第一帧内联绘制；错误时隐藏；48px 拖拽条 | 2–3 天 | 冷启动观感提升最明显的一项 |
| P1-3 密度 + 局部 step | 全局 comfortable/compact + 组件级 step 1–5；全部尺寸走 rem scale | 2 天 | 一套组件适配控制台与消费级界面 |
| P1-4 排版角色 | 正文字体 + “voice”衬线用于标题/助手；代码用独立 mono；完整 CJK/Indic 回退 | 1–2 天 | 品牌声音清晰，且国际化不豆腐块 |
| P1-5 查找栏 | 250ms 防抖；CJK 2 字符阈值；计数 status；关闭归还焦点；平台快捷键显示 | 2 天 | 长文档/日志检索体验显著提升 |
| P1-6 标题栏 overlay | 主题色/缩放/无痕/遮罩联动；高度按 zoom 计算并 clamp 24px | 2–3 天 | 高 DPI 与暗色下不再出现“标题栏断层” |
| P1-7 状态矩阵 | 骨架（延迟 500ms + 呼吸）、空态邀请式文案、错误“发生什么 + 下一步”、重试状态 | 2 天 | 减少焦虑与重复点击 |

### P2（2–4 周，平台级体验）

| 项 | 做法 | 成本 | 收益 |
|----|------|------|------|
| P2-1 Quick Entry | 透明置顶浮窗；快捷键唤起；位置按显示器相对坐标持久化；skooch 30px 避让；blur 关闭；焦点恢复 | 1–2 周 | 高频用户“随手问”入口，留存提升 |
| P2-2 信任同意面 | 无框架/无动态 HTML；`textContent`；500ms 输入保护；焦点陷阱；范围选项（一次/会话/始终） | 3–5 天 | 高风险操作的信任与合规 |
| P2-3 可观测手感 | 记录 composer 输入延迟、菜单/代码块/IME 分段、滚动 follow 指标 | 3–5 天 | 把“卡不卡”变成可回归指标 |
| P2-4 命令面板 | Cmd/Ctrl+K；模糊搜索；最近使用；类型 tab；`aria-activedescendant`；`inert` 关闭态 | 1–2 周 | 高级用户效率；与设置/会话/技能统一入口 |
| P2-5 完整 i18n | ICU MessageFormat；hash id；43+ locale 管线；语言前缀回退；RTL 真机验证 | 1–2 周 + 翻译成本 | 出海与可维护性 |
| P2-6 多窗口 HUD | caret 锚定、上下翻转、点击穿透、键盘映射、尺寸 clamp | 1–2 周 | 写作/审批/设备等场景的沉浸式入口 |

### 不建议照搬

- 不要复制 `AnthropicSans/Serif/Mono` 字体文件、`clay` 品牌色值、Clawd Quest 素材、
  Claude starburst 图标或任何插画。可替换为开源 variable font 与自有强调色。**[推断/合规建议]**
- 不要照搬 36 档色板 + 952 个 CSS 变量的完整规模；AutoAgent 先用约 40–60 个语义令牌
  覆盖 90% 场景，再按需扩展。**[推断]**
- 不要在没有真实 RTL 语言前投入大量 RTL 细节；先把逻辑属性写对即可。**[推断]**

---

## 8. 证据索引

| 文件 | 内容 | 关键位置 |
|------|------|----------|
| `app/.vite/renderer/main_window/index.html` | CDS 根标记、首帧色、boot placeholder 脚本与样式 | 全文 274 行 |
| `app/.vite/renderer/main_window/assets/MainWindowPage-DTxMhyWF.css` | 全部 CDS token/密度/排版/动效/组件样式 | 基础块 162046；compact 排版约 179k；comfortable 204828；step 206146–210610；text-size 232092；message actions 114003；ease/dur 166333；font-face 250020 |
| `app/.vite/renderer/main_window/assets/MainWindowPage-D0WzTN0N.js` | 主窗口壳层：标题栏、错误覆盖层、离线游戏 | `function E`/`T`/`w`；标题栏高度 `v=36` |
| `app/.vite/renderer/main_window/assets/main-5EBctoma.js` | Sentry/引导、页面 chunk 加载 | 全文件 |
| `app/.vite/renderer/quick_window/quick-window.html` | Quick Entry 静态结构、logo、textarea | body 与 head 内联样式/脚本 |
| `app/.vite/renderer/quick_window/assets/main-RLZWnFae.js` | Quick Entry 键盘/750ms 防抖/onLocaleChanged | 约 341k |
| `app/.vite/renderer/find_in_page/assets/FindInPage-B0JEOIxH.js` | 查找语义/常量/防抖/CJK/焦点 | 常量约 65560；组件约 62k |
| `app/.vite/renderer/local_exec_consent/localExecConsent.html` | 无框架同意页、焦点/aria/500ms 保护 | 全文 7553 字节 |
| `app/.vite/renderer/local_exec_consent/assets/main-Ddc-H8_l.js` | 同意页逻辑、Escape/Tab 循环、textContent | 全文 5061 字节 |
| `app/.vite/renderer/*/window-shared.css` | CDS import/layer 顺序、暗色字重 pin、旧值对照 | 全文 8k |
| `app/.vite/renderer/*/window-legacy-pins.css` | 迁移 pin 与删除模型 | 全文 6.3k |
| `app/.vite/build/index.chunk-Z7WxBjyE.js` | 主窗口/overlay/Quick Entry/About/Buddy/consent/placeholder | `tKn` 3187858；`hqn/vqn` 3208246；`T4r` 4378197；`requestSkooch` 4381819；主窗口 `PSe/V2a` |
| `app/.vite/build/index.chunk-bli2ILAi.js` | 内嵌 CDS 文档：六层模型、规则、内容语气 | 约 offset 2.8k 起 |
| `app/.vite/build/index.chunk-q0jzbo6d.js` | SableOtter HUD：布局/键盘/点击穿透 | 约 18.7k 起 |
| `app/.vite/build/mainWindow.js` | 主窗口 preload 暴露的标题栏 IPC | 全文 88k |
| `extracted/.../resources/*.json` | 43 个桌面 locale | en-US 837 条、其他语种 639 条 |
| `extracted/.../resources/ion-dist/i18n/*.json` | 11 静态 + 11 dynamic | 与桌面 locale 重叠 |
| `extracted/.../ion-dist/assets/v1/shared-1-CAAiD7E3.js` | 复制衰减 hook `MP` | 约 236718 |
| `extracted/.../ion-dist/assets/v1/shared-3-DnHYUZdJ.js` | IME/Enter/slash/mention 守卫 | 约 322436 |
| `extracted/.../ion-dist/assets/v1/shared-104-Cqo2-vQh.js` | 滚动跟随常量与指标 | 149304、153557、155376 |
| `extracted/.../ion-dist/assets/v1/c4a9ee384-ZZIKqgNM.js` | follow controller / jump-to-latest | 全文件 |
| `extracted/.../ion-dist/assets/v1/c6a992d55-sXiDGMFQ.css` | scroll-fade 7 段 mask + scroll timeline + RTL | 243107 |
| `extracted/.../ion-dist/assets/v1/c05b96c7f-DklIyA-P.js` | 消息/代码复制反馈 | 约 53k、约 129k |
| `extracted/.../ion-dist/assets/v1/cfaabd194-BS-aJhBm.js` | disabled-reason 焦点重路由 | 约 8585 |
| `extracted/.../ion-dist/assets/v1/c6a992d55-sXiDGMFQ.css` | compact 类、密度变体、settings 分隔 | 约 243k 起 |
| `extracted/.../resources/ion-dist/_frame-rt/_runtime/*.woff2` | Anthropic Sans/Serif/Mono 变量字体 | 文件系统 |

---

## 9. 置信度、修正与未知

### 已证实（可直接引用）

1. CDS 根标记、密度/模式/平台属性与首帧色。
2. 六层令牌模型与“组件只读 purpose 层”的规则。
3. 亮暗表面映射、文字角色、clay/brand 与 accent 的职责分离。
4. compact/comfortable/step/text-size 的具体数值。
5. 三种 easing、五档 duration、`linear()` 按钮弹簧。
6. 消息操作条 hover 延迟、焦点立即显现。
7. scroll-fade 的 7 段非线性 mask 与 CSS scroll timeline。
8. 流式跟随 24px 容差、触摸/隐藏暂停、1.5 帧迟到阈值、2s 探针超时。
9. IME 合成拦截与 500ms 后合成窗口。
10. 复制 2s 衰减、富文本回退与过期调用保护。
11. 主窗口最小尺寸、标题栏 overlay 高度/颜色/无痕 44px。
12. Quick Entry 606×470、skooch 30px、30s 焦点恢复、750ms 防抖。
13. 查找栏 250ms、CJK 2 字符、320px、40/48 高度、焦点归还。
14. 同意页无框架、textContent、500ms 输入保护、手动 focus trap。
15. 43 个唯一 locale、65 个 JSON 文件、49 条 plural、1 条 select。
16. 无 RTL locale 交付；CDS 层有 RTL 样式。
17. 骨架延迟 500ms / 2s 呼吸 / 90ms 错峰。
18. 13 条 reduced-motion 媒体规则与 70 个 `data-reduce-motion` 选择器。

### 推断（合理但需真机/源码确认）

1. Linux 主窗口最终是自绘标题栏还是系统边框；overlay 调用在 Linux 会失败。
2. “衬线是 Claude 的声音”在实际聊天正文中的覆盖比例。
3. Quick Entry/查找栏的 IME 缺口在真实输入法下的复现率与严重度。
4. 设计系统迁移 pin 的长期维护成本与团队实际执行严格度。
5. 遥测指标是否用于发布门禁，还是仅做观测。
6. Clawd Quest 是否为所有用户默认开启，还是仅特定 flag/错误类型。

### 未知（未定位/无法验证）

1. 聊天正文逐 token 的 pacing/reveal 算法与常量。
2. 种子中的 40px/120px 滚动阈值；实际证据只有 24px。
3. Linux 下标题栏 overlay 的视觉结果与窗口按钮布局。
4. RTL 交付语言的真实排版/焦点顺序验证。
5. 同意页正文未本地化的原因与计划。
6. 字体许可证细节与再分发限制；本报告只建议“不要复制资产”。
7. 命令面板的完整自有实现（部分命中 Monaco 编辑器命令面板，不能混为 Claude 自有）。
8. SableOtter HUD 的原生 Linux 实现细节（addon 内部不可见）。

---

## 10. Handoff（10 条）

1. **优先复刻 P0-1/2/3/4**：语义令牌、双环焦点、复制衰减、IME 守卫。这四项总计约 3 天，直接改善一致性、可访问性与输入正确性。
2. **滚动渐隐用纯 CSS**：28px、7 段非线性 mask、`mask-composite:intersect`；只有不支持 scroll-driven animation 时才回退到静态渐变或 JS。
3. **流式跟随不要只写 `scrollToBottom`**：至少实现 24px pin 容差、触摸暂停、隐藏标签暂停、跳转最新按钮；有精力再加 late/missed 计数。
4. **启动占位帧是性价比最高的“高级感”**：持久化侧栏宽度/折叠/形状，首帧内联绘制，缩放同步；默认 288px / 700px 折叠阈值可直接作为起点。
5. **字体与颜色只借方法不借资产**：保留“正文/voice 分离、品牌色只给 AI 动作、一个 accent 主按钮”的规则；换用开源 variable font 与自有强调色。
6. **标题栏 overlay 必须按 zoom 计算高度**：36px 基准、最小 24px；无痕/模态给独立视觉态；Linux 需真机确认是否走原生 overlay。
7. **查找栏小但影响大**：250ms 防抖、CJK 2 字符阈值、计数 `role=status`、关闭归还焦点、平台化快捷键显示。
8. **信任面要隔离技术栈**：同意页尽量无框架、无动态 HTML、`textContent`、500ms 输入保护、焦点陷阱；权限文案写清“范围 + 后果”。
9. **把这些变成指标**：composer 输入延迟、IME/菜单/代码块分段、滚动 follow 的 pinned/late/missed；否则“手感”无法回归。
10. **明确不做的部分**：不要照搬 952 个变量、36 档色板、Anthropic 字体/插画/Clawd Quest；不要在没有 RTL 语言前投入 RTL 细节；不要把 Monaco 的命令面板行为误当作 Claude 自有实现。

---

*本报告基于 2.42304.0 Linux deb 解包物；所有关键结论均标注了可复核的文件与偏移。
未验证项已明确标为 [未知]，未使用或复制任何专有视觉资产。*
