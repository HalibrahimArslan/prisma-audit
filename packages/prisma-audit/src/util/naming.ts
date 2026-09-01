/** `Product` -> `product`, `OrderLine` -> `orderLine`. Prisma Client delegate naming. */
export function toDelegateName(modelName: string): string {
  if (modelName.length === 0) return modelName;
  // Prisma lower-cases a leading run of capitals: `HTTPCall` -> `hTTPCall` is wrong,
  // but Prisma itself only lower-cases the first character, so mirror that exactly.
  return modelName.charAt(0).toLowerCase() + modelName.slice(1);
}

/** `OrderLine` -> `order_line`, `Product` -> `product`, `HTTPCall` -> `http_call`. */
export function toSnakeCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}
