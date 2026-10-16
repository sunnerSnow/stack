/**
 * 取出 Postgres 錯誤碼與約束名稱。
 * Drizzle 會把驅動的錯誤包在 cause 裡；postgres.js 用 constraint_name，PGlite 用 constraint。
 */
interface PgLikeError {
  code?: string;
  constraint?: string;
  constraint_name?: string;
  cause?: unknown;
}

function findPgError(error: unknown): PgLikeError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const e = current as PgLikeError;
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    current = e.cause;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = findPgError(error);
  if (!e || e.code !== "23505") return false;
  return constraint === undefined || (e.constraint ?? e.constraint_name) === constraint;
}
