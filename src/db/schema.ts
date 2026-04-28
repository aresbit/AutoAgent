// Desktop agent database schema adapted for bun:sqlite.

export const MIGRATIONS = [
  // v1: Initial schema
  `
  CREATE TABLE IF NOT EXISTS chat (
    id TEXT PRIMARY KEY NOT NULL,
    createdAt INTEGER NOT NULL,
    title TEXT NOT NULL,
    model TEXT,
    lastReplyAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY NOT NULL,
    chatId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    content TEXT NOT NULL,
    role TEXT NOT NULL,
    model TEXT,
    files TEXT
  );

  CREATE INDEX IF NOT EXISTS message_chatId_idx ON message (chatId);
  `,

  // v2: Add assistant
  `
  CREATE TABLE IF NOT EXISTS assistant (
    id TEXT PRIMARY KEY NOT NULL,
    createdAt INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    description TEXT,
    model TEXT,
    temperature REAL,
    systemInstruction TEXT,
    replyLanguage TEXT,
    truncateMessages TEXT
  );

  ALTER TABLE chat ADD COLUMN assistantId TEXT;
  CREATE INDEX IF NOT EXISTS chat_assistantId_idx ON chat (assistantId);
  `,

  // v3: Add prompt
  `
  CREATE TABLE IF NOT EXISTS prompt (
    id TEXT PRIMARY KEY NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER,
    displayId TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    variables TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS prompt_displayId_unique ON prompt (displayId);
  `,

  // v4: Add provider
  `
  CREATE TABLE IF NOT EXISTS provider (
    id TEXT PRIMARY KEY NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER,
    name TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    models TEXT,
    apiKey TEXT
  );
  `,

  // v5: Add tool
  `
  CREATE TABLE IF NOT EXISTS tool (
    id TEXT PRIMARY KEY NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER,
    displayId TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER,
    autoRun INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS tool_displayId_unique ON tool (displayId);

  ALTER TABLE assistant ADD COLUMN toolEnabled INTEGER;
  ALTER TABLE assistant ADD COLUMN toolIds TEXT;
  ALTER TABLE chat ADD COLUMN toolEnabled INTEGER;
  ALTER TABLE chat ADD COLUMN toolIds TEXT;
  `,
];

export const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS __migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL,
    checksum BLOB NOT NULL,
    execution_time BIGINT NOT NULL
  )
`;
