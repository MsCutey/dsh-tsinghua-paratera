// The installer deliberately has no runtime dependencies. Its surgical YAML
// cleanup supports a conservative block-mapping subset, not arbitrary YAML.
// Refuse ambiguous syntax before writing anything; --keep-data remains usable.
export function patchCleanupSupported(text) {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (/^\s*\t/.test(line)) return false;
    let masked = '';
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote) {
        // Escaped scalars can spell a target identifier without its literal text.
        if (quote === '"' && char === '\\') return false;
        if (quote === "'" && char === "'" && line[index + 1] === "'") return false;
        if (char === quote) quote = null;
        masked += ' ';
      } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) break;
      else if ((char === '"' || char === "'") && (index === 0 || /[\s:[{,\-]/.test(line[index - 1]))) { quote = char; masked += ' '; }
      else masked += char;
    }
    if (quote) return false;
    const code = masked.replace(/\{\s*\}|\[\s*\]/g, '');
    if (/[{}\[\]]/.test(code) || /(?:^|[\s:,])(?:[&*!]|<<\s*:)/.test(code) || /:\s*[|>][+\-\d]*\s*$/.test(code)) return false;
    if (/^\S/.test(line) && !/^-\s+id:\s*(?:[\w.-]+|"[\w.-]+"|'[\w.-]+')\s*(?:#.*)?$/.test(line) && line.trim() !== '[]') return false;
  }
  return true;
}
