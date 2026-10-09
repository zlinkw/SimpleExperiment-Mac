export interface SerializedPanelField {
  bytes: number;
  valueBytes: number;
}

export interface PanelPayloadAttribution {
  payloadBytes: number;
  fieldBytes: Record<string, number>;
  maxFields: Array<{ field: string; bytes: number; percent: number }>;
}

export interface SerializedPanelStateScan extends PanelPayloadAttribution {
  fields: Record<string, SerializedPanelField>;
}

export function scanSerializedPanelState(serializedMessage: string, measuredPayloadBytes?: number): SerializedPanelStateScan {
  const stateStart = findRootStateStart(serializedMessage);
  const fields: Record<string, SerializedPanelField> = {};
  if (stateStart >= 0) {
    for (const item of scanObjectFields(serializedMessage, stateStart)) {
      fields[item.key] = {
        bytes: byteLengthRange(serializedMessage, item.fieldStart, item.valueEnd),
        valueBytes: byteLengthRange(serializedMessage, item.valueStart, item.valueEnd),
      };
    }
  }
  const payloadBytes = Number.isFinite(measuredPayloadBytes) && Number(measuredPayloadBytes) >= 0
    ? Number(measuredPayloadBytes)
    : byteLength(serializedMessage);
  const fieldBytes = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.bytes]));
  const maxFields = Object.entries(fields)
    .map(([field, item]) => ({ field, bytes: item.bytes, percent: payloadBytes ? item.bytes / payloadBytes * 100 : 0 }))
    .sort((left, right) => right.bytes - left.bytes || left.field.localeCompare(right.field))
    .slice(0, 8)
    .map((item) => ({ ...item, percent: Math.round(item.percent * 10) / 10 }));
  return { payloadBytes, fieldBytes, maxFields, fields };
}

export function summarizePanelPayloadAttribution(scan: SerializedPanelStateScan): PanelPayloadAttribution {
  return {
    payloadBytes: scan.payloadBytes,
    fieldBytes: { ...scan.fieldBytes },
    maxFields: scan.maxFields.slice(0, 8).map((item) => ({ ...item })),
  };
}

function findRootStateStart(input: string): number {
  const rootStart = skipWhitespace(input, 0);
  if (input[rootStart] !== "{") return -1;
  for (const item of scanObjectFields(input, rootStart)) {
    if (item.key === "state" && input[item.valueStart] === "{") return item.valueStart;
  }
  return -1;
}

function scanObjectFields(input: string, objectStart: number): Array<{ key: string; fieldStart: number; valueStart: number; valueEnd: number }> {
  const output: Array<{ key: string; fieldStart: number; valueStart: number; valueEnd: number }> = [];
  if (input[objectStart] !== "{") return output;
  let cursor = skipWhitespace(input, objectStart + 1);
  while (cursor < input.length && input[cursor] !== "}") {
    const fieldStart = cursor;
    const keyEnd = stringEnd(input, cursor);
    if (keyEnd <= cursor) return output;
    let key = "";
    try { key = JSON.parse(input.slice(cursor, keyEnd)); } catch { return output; }
    cursor = skipWhitespace(input, keyEnd);
    if (input[cursor] !== ":") return output;
    const valueStart = skipWhitespace(input, cursor + 1);
    const valueEnd = jsonValueEnd(input, valueStart);
    if (valueEnd <= valueStart) return output;
    output.push({ key, fieldStart, valueStart, valueEnd });
    cursor = skipWhitespace(input, valueEnd);
    if (input[cursor] !== ",") break;
    cursor = skipWhitespace(input, cursor + 1);
  }
  return output;
}

function jsonValueEnd(input: string, start: number): number {
  const first = input[start];
  if (first === '"') return stringEnd(input, start);
  if (first !== "{" && first !== "[") {
    let cursor = start;
    while (cursor < input.length && input[cursor] !== "," && input[cursor] !== "}" && input[cursor] !== "]") cursor += 1;
    return cursor;
  }
  const stack: string[] = [first === "{" ? "}" : "]"];
  let cursor = start + 1;
  while (cursor < input.length && stack.length) {
    const char = input[cursor];
    if (char === '"') {
      cursor = stringEnd(input, cursor);
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack[stack.length - 1] !== char) return cursor;
      stack.pop();
    }
    cursor += 1;
  }
  return cursor;
}

function stringEnd(input: string, start: number): number {
  if (input[start] !== '"') return start;
  for (let cursor = start + 1; cursor < input.length; cursor += 1) {
    if (input[cursor] === "\\") { cursor += 1; continue; }
    if (input[cursor] === '"') return cursor + 1;
  }
  return input.length;
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && (input[cursor] === " " || input[cursor] === "\n" || input[cursor] === "\r" || input[cursor] === "\t")) cursor += 1;
  return cursor;
}

function byteLengthRange(input: string, start: number, end: number): number {
  let bytes = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    const code = input.charCodeAt(cursor);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && cursor + 1 < end) {
      const next = input.charCodeAt(cursor + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        cursor += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
