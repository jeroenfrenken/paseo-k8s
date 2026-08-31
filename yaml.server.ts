/**
 * Minimal YAML reader, scoped to what a kubeconfig actually contains:
 * nested block mappings, block sequences, plain/quoted scalars, block
 * scalars and inline flow collections. No anchors, tags or multi-doc
 * merging — the first document wins.
 *
 * Kept in-tree on purpose: plugins load as loose TypeScript on the daemon,
 * so pulling a YAML dependency into the runtime is not worth it for a file
 * format this regular.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

function tokenize(source: string): Line[] {
  const raw = source.split(/\r?\n/);
  const lines: Line[] = [];
  let i = 0;

  while (i < raw.length) {
    const current = raw[i];
    if (current.trim() === "") {
      i++;
      continue;
    }
    const indent = current.length - current.trimStart().length;
    const text = current.trimStart();

    if (text.startsWith("#")) {
      i++;
      continue;
    }
    if (text === "---") {
      if (lines.length > 0) break;
      i++;
      continue;
    }
    if (text === "...") break;

    const block = /^(.*?):[ \t]*([|>])([-+]?)\d*[ \t]*$/.exec(text);
    if (block) {
      const [, key, style, chomp] = block;
      const folded = style === ">";
      i++;
      const body: string[] = [];
      let bodyIndent = Number.POSITIVE_INFINITY;
      while (i < raw.length) {
        const line = raw[i];
        if (line.trim() === "") {
          body.push("");
          i++;
          continue;
        }
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent) break;
        bodyIndent = Math.min(bodyIndent, lineIndent);
        body.push(line);
        i++;
      }
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      const strip = Number.isFinite(bodyIndent) ? bodyIndent : 0;
      const stripped = body.map((line) => (line === "" ? "" : line.slice(strip)));
      let value = folded ? stripped.join(" ").replace(/\s+/g, " ").trim() : stripped.join("\n");
      if (!folded && chomp !== "-" && value !== "") value += "\n";
      lines.push({ indent, text: `${key}: ${JSON.stringify(value)}` });
      continue;
    }

    lines.push({ indent, text });
    i++;
  }

  return lines;
}

/** Index of the `:` that terminates a mapping key, or -1 when there is none. */
function keyEnd(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === ":" && !inSingle && !inDouble) {
      if (i + 1 >= text.length || text[i + 1] === " " || text[i + 1] === "\t") return i;
    }
  }
  return -1;
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

function parseScalar(raw: string): YamlValue {
  let text = raw.trim();
  if (text === "") return null;

  const doubleQuoted = /^"(?:[^"\\]|\\.)*"/.exec(text);
  if (doubleQuoted) {
    try {
      return JSON.parse(doubleQuoted[0]) as string;
    } catch {
      return doubleQuoted[0].slice(1, -1);
    }
  }
  const singleQuoted = /^'(?:[^']|'')*'/.exec(text);
  if (singleQuoted) return singleQuoted[0].slice(1, -1).replace(/''/g, "'");

  const comment = text.search(/\s#/);
  if (comment >= 0) text = text.slice(0, comment).trim();

  if (text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?(?:\d+\.\d*|\.\d+)$/.test(text)) return Number(text);

  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((part) => parseScalar(part));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    const flow: Record<string, YamlValue> = {};
    if (inner === "") return flow;
    for (const part of inner.split(",")) {
      const split = part.indexOf(":");
      if (split < 0) continue;
      flow[unquote(part.slice(0, split).trim())] = parseScalar(part.slice(split + 1));
    }
    return flow;
  }

  return text;
}

function isSequenceItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseNode(lines: Line[], start: number, indent: number): [YamlValue, number] {
  if (start >= lines.length) return [null, start];
  return isSequenceItem(lines[start].text)
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = start;

  while (i < lines.length && lines[i].indent === indent && isSequenceItem(lines[i].text)) {
    const { text } = lines[i];
    const after = text === "-" ? "" : text.slice(2);

    if (after.trim() === "") {
      i++;
      if (i < lines.length && lines[i].indent > indent) {
        const [value, next] = parseNode(lines, i, lines[i].indent);
        items.push(value);
        i = next;
      } else {
        items.push(null);
      }
      continue;
    }

    // `- key: value` — re-emit the payload as a line indented to where it
    // actually starts, so sibling keys on following lines line up with it.
    const offset = 2 + (after.length - after.trimStart().length);
    const virtual: Line = { indent: indent + offset, text: after.trimStart() };
    const rest = [virtual, ...lines.slice(i + 1)];
    const [value, next] = parseNode(rest, 0, virtual.indent);
    items.push(value);
    i += next;
  }

  return [items, i];
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, YamlValue>, number] {
  const map: Record<string, YamlValue> = {};
  let i = start;

  while (i < lines.length && lines[i].indent === indent) {
    const { text } = lines[i];
    if (isSequenceItem(text)) break;

    const split = keyEnd(text);
    if (split < 0) {
      i++;
      continue;
    }

    const key = unquote(text.slice(0, split).trim());
    const inline = text.slice(split + 1).trim();

    if (inline !== "") {
      map[key] = parseScalar(inline);
      i++;
      continue;
    }

    i++;
    if (i < lines.length && lines[i].indent > indent) {
      const [value, next] = parseNode(lines, i, lines[i].indent);
      map[key] = value;
      i = next;
    } else if (i < lines.length && lines[i].indent === indent && isSequenceItem(lines[i].text)) {
      // `clusters:` followed by `- name: ...` at the same indent.
      const [value, next] = parseSequence(lines, i, indent);
      map[key] = value;
      i = next;
    } else {
      map[key] = null;
    }
  }

  return [map, i];
}

export function parseYaml(source: string): YamlValue {
  const trimmed = source.trim();
  if (trimmed === "") return null;
  // kubeconfigs are sometimes written as JSON, which is valid YAML anyway.
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      // fall through to the YAML path
    }
  }
  const lines = tokenize(source);
  if (lines.length === 0) return null;
  const [value] = parseNode(lines, 0, lines[0].indent);
  return value;
}
