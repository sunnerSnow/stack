export interface FieldIssue {
  field: string;
  message: string;
}

/** 服務層丟出的可預期錯誤；API 與表單會把它轉成使用者看得懂的訊息 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 不存在與「不是你的」回同一個錯誤，不洩漏別人的資料是否存在 */
export function notFound(what: string): AppError {
  return new AppError("not_found", `找不到${what}，或你沒有權限存取`, 404);
}

export function validationFailed(issues: FieldIssue[]): AppError {
  return new AppError("validation_failed", issues[0]?.message ?? "輸入資料有誤", 400, issues);
}

export function unauthorized(): AppError {
  return new AppError("unauthorized", "請先登入", 401);
}

/** 把 zod 的錯誤轉成欄位訊息（欄位名稱用 a.b 表示巢狀） */
export function issuesFromZod(error: { issues: { path: PropertyKey[]; message: string }[] }): FieldIssue[] {
  return error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message }));
}
