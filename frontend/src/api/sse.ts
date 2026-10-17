export interface SSEFrame {
  id?: string;
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = "";

  push(chunk: string): SSEFrame[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, "\n");
    const frames: SSEFrame[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
      boundary = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  flush(): SSEFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const block = this.buffer;
    this.buffer = "";
    const frame = parseBlock(block);
    return frame ? [frame] : [];
  }
}

function parseBlock(block: string): SSEFrame | null {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

export function parseSSEText(text: string): SSEFrame[] {
  const parser = new SSEParser();
  return [...parser.push(text), ...parser.flush()];
}
