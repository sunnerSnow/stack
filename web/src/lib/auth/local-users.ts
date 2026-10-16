/** 本機示範模式的兩個固定使用者（可用來測試資料互相看不到） */
export const LOCAL_USERS = [
  { key: "a", id: "00000000-0000-4000-8000-00000000000a", email: "demo-a@stack.local", label: "示範使用者 A" },
  { key: "b", id: "00000000-0000-4000-8000-00000000000b", email: "demo-b@stack.local", label: "示範使用者 B" },
] as const;

export const LOCAL_SESSION_COOKIE = "stack_local_user";
