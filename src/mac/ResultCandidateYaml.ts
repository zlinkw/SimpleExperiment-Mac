/** Decode a single-line YAML result scalar once, before POSIX candidate validation.
 * YAML quoting/escapes: https://yaml.org/spec/1.2.2/#57-escaped-characters
 * This is the existing Plan preview reader's scalar boundary, not a full YAML loader.
 */
export function decodeMacResultYamlScalar(value: string): string {
  const token = value.trim();
  const quote = token[0];
  if (quote !== '"' && quote !== "'") {
    return token.replace(/[ \t]+#.*$/, '').trim();
  }
  const escapes: Record<string, string> = {
    '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
    ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
  };
  let decoded = '';
  for (let index = 1; index < token.length; index++) {
    const char = token[index];
    if (char === quote) {
      if (quote === "'" && token[index + 1] === "'") { decoded += "'"; index++; continue; }
      const suffix = token.slice(index + 1);
      return !suffix || /^[ \t]+(?:#.*)?$/.test(suffix) ? decoded : '';
    }
    if (char !== '\\' || quote === "'") { decoded += char; continue; }
    const escaped = token[++index];
    if (Object.hasOwn(escapes, escaped)) { decoded += escapes[escaped]; continue; }
    const count = ({ x: 2, u: 4, U: 8 } as Record<string, number>)[escaped];
    if (!count) return '';
    const digits = token.slice(index + 1, index + 1 + count);
    if (digits.length !== count || !/^[0-9a-f]+$/i.test(digits)) return '';
    const point = parseInt(digits, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '';
    decoded += String.fromCodePoint(point); index += count;
  }
  return ''; // Unclosed quotes must never become a repaired candidate.
}
