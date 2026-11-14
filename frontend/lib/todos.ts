import { API_PATHS, apiFetch, encodePath, jsonBody } from "./api";

/** 工位待办接口（/api/todos），数据按登录账号隔离，字段说明见 chatworld/todos.py */

export interface TodoSubtask {
  id: string;
  title: string;
  done: boolean;
}

/** 优先级：0 无、1 低、2 中、3 高 */
export type TodoPriority = 0 | 1 | 2 | 3;

export interface Todo {
  id: string;
  title: string;
  note: string;
  /** 所属清单，空字符串为「未分类」 */
  list: string;
  priority: TodoPriority;
  /** 截止日期 YYYY-MM-DD，空为不设 */
  due_date: string;
  /** 加入「今天」的日期 YYYY-MM-DD；不是今天的日期视为未加入 */
  my_day: string;
  done: boolean;
  done_at: number | null;
  subtasks: TodoSubtask[];
  sort: number;
  created_at: number;
  updated_at: number;
}

export type TodoInput = Partial<Pick<Todo, "title" | "note" | "list" | "priority" | "due_date" | "my_day" | "done" | "subtasks" | "sort">>;

const BASE = `${API_PATHS.hub}/todos`;

export const TODO_TITLE_MAX = 200;
export const TODO_NOTE_MAX = 4000;
export const TODO_LIST_MAX = 24;
export const TODO_SUBTASK_MAX = 50;

export const PRIORITY_LABELS: Record<TodoPriority, string> = { 0: "无", 1: "低", 2: "中", 3: "高" };

export function fetchTodos(): Promise<{ todos: Todo[] }> {
  return apiFetch<{ todos: Todo[] }>(BASE);
}

export function createTodo(input: TodoInput): Promise<Todo> {
  return apiFetch<Todo>(BASE, { method: "POST", body: jsonBody(input) });
}

export function updateTodo(id: string, input: TodoInput): Promise<Todo> {
  return apiFetch<Todo>(`${BASE}/${encodePath(id)}`, { method: "PATCH", body: jsonBody(input) });
}

export function deleteTodo(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${BASE}/${encodePath(id)}`, { method: "DELETE" });
}

export function reorderTodos(ids: string[]): Promise<{ todos: Todo[] }> {
  return apiFetch<{ todos: Todo[] }>(`${BASE}/reorder`, { method: "POST", body: jsonBody({ ids }) });
}

export function clearCompletedTodos(list?: string): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>(`${BASE}/clear-completed`, { method: "POST", body: jsonBody(list === undefined ? {} : { list }) });
}

/** 浏览器本地日期 YYYY-MM-DD（offset 为相对今天的天数） */
export function localDate(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 子任务编号：短随机串 */
export function newSubtaskId(): string {
  return Math.random().toString(36).slice(2, 10);
}
