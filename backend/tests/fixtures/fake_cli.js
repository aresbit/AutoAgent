// Scripted opencc CLI used by integration tests. It speaks the same NDJSON
// stream-json protocol but never calls a model. It also refuses to start unless
// the modern backend passes --matebot, which makes argv regressions fail tests.
const fs = require("fs");

const argv = process.argv.slice(2);
if (!argv.includes("--matebot")) {
  console.error("fake_cli: --matebot missing");
  process.exit(2);
}
if (!argv.includes("--input-format") || !argv.includes("stream-json")) {
  console.error("fake_cli: stream-json input missing");
  process.exit(2);
}
const argvFile = process.env.FAKE_CLI_ARGV_FILE;
if (argvFile) {
  fs.writeFileSync(argvFile, JSON.stringify(argv));
}
const pidFile = process.env.FAKE_CLI_PID_FILE;
if (pidFile) {
  fs.writeFileSync(pidFile, String(process.pid));
}
const envFile = process.env.FAKE_CLI_ENV_FILE;
if (envFile) {
  fs.writeFileSync(
    envFile,
    JSON.stringify({
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || null,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || null,
    })
  );
}

const sessionId = "44444444-4444-4444-8444-444444444444";
const scenario = process.env.FAKE_CLI_SCENARIO || "normal";
const dieFile = process.env.FAKE_CLI_DIE_FILE || "";

function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

emit({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  cwd: process.cwd(),
  model: "fake-cli-model",
  claude_code_version: "2.1.888",
  permissionMode: "bypassPermissions",
});

let buffer = "";

function handle(message) {
  if (message.type === "keep_alive") {
    return;
  }
  if (message.type !== "user") {
    return;
  }
  if (scenario === "die") {
    process.exit(1);
  }
  if (scenario === "die_once" && dieFile && fs.existsSync(dieFile)) {
    fs.unlinkSync(dieFile);
    process.exit(1);
  }
  if (scenario === "hang") {
    return;
  }
  const text = message.message.content[0].text;
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "echo:" },
    },
    session_id: sessionId,
  });
  emit({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "echo:" + text }],
    },
    session_id: sessionId,
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "echo:" + text,
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 3 },
    session_id: sessionId,
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch (error) {
      console.error("fake_cli: bad frame");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => {
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["interrupted"],
    session_id: sessionId,
  });
  process.exit(130);
});
