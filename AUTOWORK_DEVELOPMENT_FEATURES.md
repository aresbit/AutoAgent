# Autowork Development Features

## Overview

`autowork` is currently implemented as a runtime capability layer inside AutoAgent, not as a standalone UI page.

That means:

- There is no separate `Autowork` tab or route in the React renderer today.
- `autowork` is enabled by prompt assembly, artifact bridging, and internal IPC/MCP handlers.
- The visible UI surfaces for it are mainly the chat area, the `Artifacts` panel, and opened artifact windows.

## How Autowork Is Enabled Today

`autowork` is effectively on by default in the current desktop runtime.

### 1. System prompt injection

Every main agent run uses the assembled Autowork prompt:

- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1890)
- [src/autowork/desktop-replica.ts](D:/yyscode/AutoAgent/src/autowork/desktop-replica.ts:15)

The runtime prompt is built from bundled upstream prompt assets:

- [src/autowork/assets/upstream/desktop-system-prompts-extracted.md](D:/yyscode/AutoAgent/src/autowork/assets/upstream/desktop-system-prompts-extracted.md)
- [src/autowork/assets/upstream/claude-desktop-artifacts-mechanism.md](D:/yyscode/AutoAgent/src/autowork/assets/upstream/claude-desktop-artifacts-mechanism.md)
- [src/autowork/assets/upstream/claude-desktop-ui-generation.md](D:/yyscode/AutoAgent/src/autowork/assets/upstream/claude-desktop-ui-generation.md)
- [src/autowork/assets/upstream/claude-code-internal-mcp-servers.md](D:/yyscode/AutoAgent/src/autowork/assets/upstream/claude-code-internal-mcp-servers.md)

### 2. Helper Claude calls also use the same prompt stack

Artifact-side `askClaude` calls also go through the Autowork prompt assembler:

- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1764)

### 3. Artifact windows expose `window.autowork`

Opened artifact pages receive the Autowork bridge:

- [src/artifact-preload.ts](D:/yyscode/AutoAgent/src/artifact-preload.ts:5)

### 4. Inline artifact previews expose `window.autowork`

Artifacts rendered inside chat iframes also proxy Autowork bridge calls back to the host:

- [src/renderer/message-content.tsx](D:/yyscode/AutoAgent/src/renderer/message-content.tsx:203)
- [src/renderer/message-content.tsx](D:/yyscode/AutoAgent/src/renderer/message-content.tsx:356)

## Why There Is No Dedicated Autowork Page

The current right-side control panel only has these tabs:

- `Skills`
- `Agent`
- `MCP`
- `Workspace`
- `Artifacts`

See:

- [src/renderer/app.tsx](D:/yyscode/AutoAgent/src/renderer/app.tsx:837)

So `autowork` is not missing because it failed to load. It is missing because no dedicated page or tab has been built for it yet.

## Current Autowork Feature Set

## Prompt and persona replication

- Claude Desktop style system prompt assembly is implemented via prompt assets plus section parsing.
- `Imagine` guidance, palette rules, UI component rules, elicitation rules, SVG/chart/art guidance, and artifacts guidance are included in the assembled prompt.
- A source index is bundled into the assembled prompt for traceability.

Key files:

- [src/autowork/prompt-assets.ts](D:/yyscode/AutoAgent/src/autowork/prompt-assets.ts)
- [src/autowork/markdown-sections.ts](D:/yyscode/AutoAgent/src/autowork/markdown-sections.ts)
- [src/autowork/desktop-replica.ts](D:/yyscode/AutoAgent/src/autowork/desktop-replica.ts)

## Artifact generation and persistence

- Detects fenced `artifact-html` and `artifact` blocks from assistant responses.
- Falls back to ingesting local `.html` file paths from assistant output when the model fails to emit an artifact block.
- Persists artifacts as local HTML files with embedded `cowork-artifact-meta`.
- Maintains a manifest and artifact version snapshots.
- Supports import and export as zip archives.

Key files:

- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1122)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1180)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:648)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:680)

## Artifact rendering in the UI

- Chat messages can render artifact previews inline through iframes.
- Artifact windows open in dedicated Electron BrowserWindows.
- The `Artifacts` side panel lists persisted artifacts and allows `Open`, `Versions`, `Export`, and `Import`.

Key files:

- [src/renderer/message-content.tsx](D:/yyscode/AutoAgent/src/renderer/message-content.tsx)
- [src/renderer/app.tsx](D:/yyscode/AutoAgent/src/renderer/app.tsx:961)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:767)

## Autowork bridge APIs

Artifact code can call:

- `window.autowork.callMcpTool(name, args)`
- `window.autowork.askClaude(prompt, data)`
- `window.autowork.sample(prompt, data)`
- `window.autowork.runScheduledTask(taskId)`
- `window.autowork.navigateHost(direction)`
- `window.autowork.openExternalUrl(url)`

These are exposed in:

- [src/artifact-preload.ts](D:/yyscode/AutoAgent/src/artifact-preload.ts:5)

They are also proxied into inline artifact previews from:

- [src/renderer/message-content.tsx](D:/yyscode/AutoAgent/src/renderer/message-content.tsx:183)

## Internal MCP-compatible visualize server

Autowork now includes a built-in `visualize` compatibility layer with:

- `visualize/read_me`
- `visualize/show_widget`

Behavior:

- `read_me` returns Imagine guidance assembled from bundled prompt assets.
- `show_widget` turns HTML or SVG widget code into a persisted artifact and refreshes the host UI.

Key files:

- [src/autowork/visualize.ts](D:/yyscode/AutoAgent/src/autowork/visualize.ts)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1731)

## MCP integration

- External MCP servers can be configured from the `MCP` tab.
- `autowork:call-mcp-tool` tries internal Autowork tools first, then falls back to enabled external MCP servers.

Key files:

- [src/renderer/app.tsx](D:/yyscode/AutoAgent/src/renderer/app.tsx:908)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:1731)

## Skills and workspace context

- Skills can be scanned and toggled from the `Skills` panel.
- Enabled skill names are appended as hidden runtime directives in `appendSystemPrompt`.
- Workspace Git status is visible in the `Workspace` panel.

Key files:

- [src/renderer/app.tsx](D:/yyscode/AutoAgent/src/renderer/app.tsx:577)
- [src/main.ts](D:/yyscode/AutoAgent/src/main.ts:2261)

## Current UI Surfaces Related To Autowork

### Visible today

- Main chat thread
- `Artifacts` panel
- Opened artifact window
- Inline artifact preview inside chat
- `MCP` panel for external server configuration

### Not built yet

- Dedicated `Autowork` control panel tab
- Dedicated `Imagine` playground page
- Dedicated `Visualize` tool inspector page
- Manual `read_me/show_widget` test console in UI

## How To Use Autowork Right Now

## As a user

1. Start the desktop app with the current build.
2. Use the normal chat input.
3. Ask for an artifact or interactive HTML result.
4. If the model emits an `artifact-html` block, it will be persisted and shown in `Artifacts`.
5. If the model only emits a local `.html` file path, the app will try to ingest that file into the artifact system automatically.

## As artifact/widget code

Inside an artifact you can call:

```js
await window.autowork.callMcpTool('visualize/read_me', {
  modules: ['diagram', 'chart'],
  platform: 'desktop'
});
```

```js
await window.autowork.callMcpTool('visualize/show_widget', {
  loading_messages: ['Rendering widget'],
  title: 'demo_widget',
  widget_code: '<div>Hello</div>'
});
```

## As a developer

If you want to verify Autowork is active:

1. Confirm the app is built from the latest code.
2. Restart the desktop app.
3. Trigger a normal agent run.
4. Check that `runAgent()` is passing `composeAutoworkSystemPrompt(...)`.
5. Create or open an artifact and verify `window.autowork` exists inside the artifact context.

## OpenCC Status

`opencc` does not currently provide a local `visualize` MCP implementation in this repository.

What exists in `opencc` today:

- `cowork`-related plugin directory support
- bridge and session references
- no `visualize`, `show_widget`, or `read_me` tool implementation

So the current `visualize` support is implemented in AutoAgent itself, not inherited from `opencc`.

## Current Gaps And Follow-Up Work

- No dedicated `Autowork` page or tab in the renderer
- No UI control to inspect the final assembled system prompt
- No UI for invoking internal `visualize` tools manually
- `runScheduledTask` is still a stub
- No true Cowork VM sandbox model
- No feature-flag gate mirroring Claude Desktop's exact `sessionType === "cowork"` behavior
- No artifact deletion, rollback UI, or thumbnail generation yet

## Recommended Next Steps

1. Add a dedicated `Autowork` tab in the right panel.
2. Add a read-only prompt inspector showing the final assembled system prompt.
3. Add a `Visualize` playground for testing `read_me` and `show_widget` directly.
4. Add artifact deletion and rollback actions to the `Artifacts` panel.
5. Add a small runtime badge showing whether Autowork prompt injection is active for the current session.
