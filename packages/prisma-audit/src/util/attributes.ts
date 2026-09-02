/**
 * Reading Prisma's field attributes.
 *
 * Attribute arguments nest — `@default(autoincrement())`, `@relation(fields: [a],
 * references: [b])` — so the scan tracks bracket depth rather than matching a
 * closing delimiter with a regular expression.
 */

export interface Attribute {
  name: string;
  text: string;
}

/** Split `@id @default(now()) @db.Date` into its individual attributes. */
export function splitAttributes(attributes: string): Attribute[] {
  const out: Attribute[] = [];
  let index = 0;

  while (index < attributes.length) {
    if (attributes[index] !== "@") {
      index++;
      continue;
    }

    const start = index;
    index++; // consume '@'

    const nameStart = index;
    while (index < attributes.length && /[A-Za-z0-9_.]/.test(attributes[index] as string)) {
      index++;
    }
    const name = attributes.slice(nameStart, index);

    // Skip whitespace between the name and an argument list, if any.
    let lookahead = index;
    while (lookahead < attributes.length && /\s/.test(attributes[lookahead] as string)) {
      lookahead++;
    }

    if (attributes[lookahead] === "(") {
      index = skipBalanced(attributes, lookahead);
    }

    out.push({ name, text: attributes.slice(start, index).trim() });
  }

  return out;
}

/** `db.VarChar` -> `db`, `default` -> `default`. */
function rootName(name: string): string {
  return name.split(".")[0] as string;
}

/** Return the index just past the balanced group that starts at `open`. */
function skipBalanced(source: string, open: number): number {
  let depth = 0;
  let index = open;
  let quote: string | null = null;

  while (index < source.length) {
    const char = source[index] as string;

    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth--;
      if (depth === 0) return index + 1;
    }

    index++;
  }

  // Unbalanced input: consume the rest rather than looping forever.
  return source.length;
}
