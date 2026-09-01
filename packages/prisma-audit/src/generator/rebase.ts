import path from "node:path";

/**
 * `prisma-audit generate` writes the clean schema into its own directory, so
 * any relative path inside a `generator` block would otherwise resolve from the
 * wrong place. This rewrites those paths so they still point at the same file.
 *
 * `output = "../src/generated/prisma"` in `prisma/schema.prisma` becomes
 * `output = "../../src/generated/prisma"` in `prisma/.audit/schema.prisma`.
 */
export function rebaseRelativePaths(
  schema: string,
  fromDir: string,
  toDir: string,
): string {
  if (path.resolve(fromDir) === path.resolve(toDir)) return schema;

  const lines = schema.split("\n");
  let inGenerator = false;

  return lines
    .map((line) => {
      if (/^\s*generator\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line)) {
        inGenerator = true;
        return line;
      }
      if (inGenerator && /^\s*\}\s*$/.test(line)) {
        inGenerator = false;
        return line;
      }
      if (!inGenerator) return line;

      return line.replace(
        /^(\s*output\s*=\s*)"([^"]+)"/,
        (whole, prefix: string, value: string) => {
          if (!isRelative(value)) return whole;
          const absolute = path.resolve(fromDir, value);
          const rebased = path.relative(path.resolve(toDir), absolute);
          return `${prefix}"${normalise(rebased)}"`;
        },
      );
    })
    .join("\n");
}

function isRelative(value: string): boolean {
  if (value.startsWith("/")) return false;
  // `env("...")` and other function calls are not paths.
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(value)) return false;
  return true;
}

function normalise(value: string): string {
  const posix = value.split(path.sep).join("/");
  return posix.startsWith(".") ? posix : `./${posix}`;
}
