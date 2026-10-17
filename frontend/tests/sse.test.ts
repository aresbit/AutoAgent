import { describe, expect, it } from "vitest";
import { SSEParser, parseSSEText } from "@/api/sse";

describe("SSE parser", () => {
  it("parses a complete frame", () => {
    const frames = parseSSEText(
      'id: 1\nevent: message.delta\ndata: {"text":"hello"}\n\n',
    );
    expect(frames).toEqual([
      { id: "1", event: "message.delta", data: '{"text":"hello"}' },
    ]);
  });

  it("reassembles frames split across chunks", () => {
    const parser = new SSEParser();
    expect(parser.push("id: 2\nevent: message.del")).toEqual([]);
    expect(parser.push('ta\ndata: {"text":"hel')).toEqual([]);
    expect(parser.push('lo"}\n\n')).toEqual([
      { id: "2", event: "message.delta", data: '{"text":"hello"}' },
    ]);
  });

  it("normalizes CRLF and multiple frames in one chunk", () => {
    const frames = parseSSEText(
      "event: usage\r\ndata: {\"a\":1}\r\n\r\nevent: turn.completed\r\ndata: {\"b\":2}\r\n\r\n",
    );
    expect(frames.map((frame) => frame.event)).toEqual(["usage", "turn.completed"]);
    expect(frames[1].data).toBe('{"b":2}');
  });

  it("joins multi-line data and ignores comments", () => {
    const frames = parseSSEText(": keep-alive\nevent: note\ndata: one\ndata: two\n\n");
    expect(frames).toEqual([{ id: undefined, event: "note", data: "one\ntwo" }]);
  });

  it("flushes an unterminated final frame", () => {
    const parser = new SSEParser();
    expect(parser.push("event: heartbeat\ndata: {}")).toEqual([]);
    expect(parser.flush()).toEqual([
      { id: undefined, event: "heartbeat", data: "{}" },
    ]);
  });

  it("drops blocks without data", () => {
    expect(parseSSEText("event: ping\n\n")).toEqual([]);
  });
});
