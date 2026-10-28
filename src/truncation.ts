import type { TruncatedText, TruncationMetadata, TruncationStrategy } from "./types.ts";

export interface TruncateTextOptions {
  maxLines?: number;
  maxBytes?: number;
  strategy?: TruncationStrategy;
  label?: string;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceToBytesFromHead(text: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const char of text) {
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    output += char;
    bytes += nextBytes;
  }
  return output;
}

function sliceToBytesFromTail(text: string, maxBytes: number): string {
  let bytes = 0;
  const chars = Array.from(text);
  const kept: string[] = [];
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (char === undefined) continue;
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) break;
    kept.push(char);
    bytes += nextBytes;
  }
  kept.reverse();
  return kept.join("");
}

function truncateLines(text: string, maxLines: number, strategy: TruncationStrategy): string {
  if (maxLines <= 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return strategy === "tail" ? lines.slice(-maxLines).join("\n") : lines.slice(0, maxLines).join("\n");
}

function truncateBytes(text: string, maxBytes: number, strategy: TruncationStrategy): string {
  if (byteLength(text) <= maxBytes) return text;
  return strategy === "tail" ? sliceToBytesFromTail(text, maxBytes) : sliceToBytesFromHead(text, maxBytes);
}

export function formatTruncationNotice(metadata: TruncationMetadata): string | undefined {
  if (!metadata.truncated) return undefined;
  const label = metadata.label ? `${metadata.label}: ` : "";
  return `[Truncated ${label}showing ${metadata.outputLines} of ${metadata.originalLines} lines, ${metadata.outputBytes} of ${metadata.originalBytes} bytes.]`;
}

export function truncateText(text: string, options: TruncateTextOptions): TruncatedText {
  const strategy = options.strategy ?? "head";
  const originalBytes = byteLength(text);
  const originalLines = countLines(text);

  let output = text;
  if (typeof options.maxLines === "number" && options.maxLines >= 0) {
    output = truncateLines(output, options.maxLines, strategy);
  }
  if (typeof options.maxBytes === "number" && options.maxBytes >= 0) {
    output = truncateBytes(output, options.maxBytes, strategy);
  }

  const metadata: TruncationMetadata = {
    truncated: output !== text,
    strategy,
    originalBytes,
    outputBytes: byteLength(output),
    originalLines,
    outputLines: countLines(output),
    label: options.label,
  };

  return {
    text: output,
    metadata,
    notice: formatTruncationNotice(metadata),
  };
}

export function appendTruncationNotice(truncated: TruncatedText): string {
  if (!truncated.notice) return truncated.text;
  return `${truncated.text}\n\n${truncated.notice}`;
}

export function collectTruncationMetadata(items: Array<{ truncation?: TruncationMetadata }>): TruncationMetadata[] {
  return items.flatMap((item) => (item.truncation ? [item.truncation] : []));
}

function escapedControlCharacter(character: string, codePoint: number): string {
  if (character === "\r") return String.raw`\r`;
  if (character === "\n") return String.raw`\n`;
  if (character === "\t") return String.raw`\t`;
  return String.raw`\x${codePoint.toString(16).padStart(2, "0")}`;
}

export function formatDisplayPath(path: string): string {
  let output = "";
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    output += codePoint <= 0x1f || codePoint === 0x7f ? escapedControlCharacter(character, codePoint) : character;
  }
  return output;
}
