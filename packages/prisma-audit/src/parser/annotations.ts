/**
 * The `prisma-audit` annotation vocabulary.
 *
 * Annotations are written in square brackets, Java/C#-attribute style:
 *
 *     [Auditable]
 *     model Product {
 *       [NotAudited]
 *       internalCode String?
 *     }
 *
 * Because this is not valid Prisma syntax, `schema.prisma` is our own source
 * file and never handed to the Prisma CLI directly — `prisma-audit generate`
 * strips the annotations and writes a clean schema for Prisma to consume.
 */

export const ANNOTATIONS = {
  /** Placed above a `model`: the model gets an audit table. */
  auditable: "Auditable",
  /** Placed above a field: the field is left out of the audit table. */
  notAudited: "NotAudited",
} as const;

export type AnnotationName = (typeof ANNOTATIONS)[keyof typeof ANNOTATIONS];

const KNOWN = new Set<string>(Object.values(ANNOTATIONS));

/** A line that consists of nothing but one annotation, e.g. `  [Auditable]`. */
const STANDALONE = /^\s*\[([A-Za-z][A-Za-z0-9_]*)\]\s*$/;

/** An annotation at the end of a declaration line, e.g. `foo String [NotAudited]`. */
const TRAILING = /\s*\[([A-Za-z][A-Za-z0-9_]*)\]\s*$/;

export interface StandaloneAnnotation {
  name: string;
  known: boolean;
}

/** Parse a line that is only an annotation, or `null` if it is something else. */
export function matchStandaloneAnnotation(line: string): StandaloneAnnotation | null {
  const match = STANDALONE.exec(line);
  if (!match) return null;

  const name = match[1] as string;
  return { name, known: KNOWN.has(name) };
}

export interface TrailingAnnotation {
  name: string;
  known: boolean;
  /** The line with the annotation removed. */
  rest: string;
}

/**
 * Parse an annotation written at the end of a declaration line.
 *
 * `String[]` and `@@index([a, b])` also end in `]`, so the pattern only matches
 * a bare `[Name]` and the caller additionally checks that the name is known.
 */
export function matchTrailingAnnotation(line: string): TrailingAnnotation | null {
  const match = TRAILING.exec(line);
  if (!match) return null;

  const name = match[1] as string;
  if (!KNOWN.has(name)) return null;

  return { name, known: true, rest: line.slice(0, match.index) };
}
