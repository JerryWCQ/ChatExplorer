/**
 * Server-sent events, incrementally.
 *
 * Both wire formats stream SSE, but relays are not careful with it: some omit
 * `event:` lines, some use CRLF, some split one event across network chunks at
 * arbitrary byte offsets. So this parser only assumes the core of the spec —
 * lines, `data:` fields joined with "\n", a blank line ends an event — and
 * leaves interpreting the payload to the provider layer.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buf.slice(0, nl);
      const sepLen = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sepLen);
      this.line(line, out);
    }
    return out;
  }

  /** Flush whatever is left — a stream that ends without a final blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.data.length > 0) out.push({ event: this.event, data: this.data.join("\n") });
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
  }
}
