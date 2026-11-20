import { API_PATHS, apiFetch, encodePath, jsonBody } from "./api";

/** 工位待办接口（/api/todos），数据按登录账号隔离，字段说明见 chatworld/todos.py */

export interface TodoSubtask {
  id: string;
  title: string;
  done: boolean;
}

export interface TodoProgress {
  id: string;
  text: string;
  created_at: number;
}

/** 优先级：3 P0（高）、2 P1（默认，含兼容旧值 0）、1 P2（低） */
export type TodoPriority = 0 | 1 | 2 | 3;

/** 未完成任务的执行状态（严格只有这三个值，与 done 独立） */
export type TodoStatus = "not_started" | "in_progress" | "blocked";

export const TODO_STATUSES: TodoStatus[] = ["not_started", "in_progress", "blocked"];
export const TODO_STATUS_LABELS: Record<TodoStatus, string> = {
  not_started: "待开始",
  in_progress: "进行中",
  blocked: "阻塞中",
};

export function normalizeTodoStatus(value: unknown): TodoStatus {
  if (value === "in_progress" || value === "blocked" || value === "not_started") return value;
  return "not_started";
}

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
  status: TodoStatus;
  subtasks: TodoSubtask[];
  progress: TodoProgress[];
  sort: number;
  /** 所属分区编号（TodoSpace.id） */
  space: string;
  created_at: number;
  updated_at: number;
}

/** 分区：如「工作」「学习」，分区之间的待办互相独立；每个账号至少一个 */
export interface TodoSpace {
  id: string;
  name: string;
  sort: number;
  created_at: number;
}

export type TodoInput = Partial<Pick<Todo, "title" | "note" | "list" | "priority" | "due_date" | "my_day" | "done" | "status" | "subtasks" | "sort" | "space">>;

const BASE = `${API_PATHS.hub}/todos`;

export const TODO_TITLE_MAX = 200;
export const TODO_NOTE_MAX = 4000;
export const TODO_LIST_MAX = 24;
export const TODO_SUBTASK_MAX = 50;
export const TODO_PROGRESS_MAX = 1000;
export const TODO_SPACE_NAME_MAX = 12;
export const TODO_SPACE_MAX = 20;

export const PRIORITY_OPTIONS: TodoPriority[] = [3, 2, 1];
export const PRIORITY_TAGS: Record<TodoPriority, string> = {
  3: "P0",
  2: "P1",
  1: "P2",
  0: "P1",
};
export const PRIORITY_LABELS: Record<TodoPriority, string> = {
  3: "P0（高）",
  2: "P1（默认）",
  1: "P2（低）",
  0: "P1（默认）",
};

export function fetchTodos(): Promise<{ todos: Todo[]; spaces: TodoSpace[] }> {
  return apiFetch<{ todos: Todo[]; spaces: TodoSpace[] }>(BASE);
}

export function createTodoSpace(name: string): Promise<TodoSpace> {
  return apiFetch<TodoSpace>(`${BASE}/spaces`, { method: "POST", body: jsonBody({ name }) });
}

export function renameTodoSpace(id: string, name: string): Promise<TodoSpace> {
  return apiFetch<TodoSpace>(`${BASE}/spaces/${encodePath(id)}`, { method: "PATCH", body: jsonBody({ name }) });
}

export function reorderTodoSpaces(ids: string[]): Promise<{ spaces: TodoSpace[] }> {
  return apiFetch<{ spaces: TodoSpace[] }>(`${BASE}/spaces/reorder`, { method: "POST", body: jsonBody({ ids }) });
}

/** 删除分区：分区里还有待办时传 moveTo（移到哪个分区）或 deleteTodos（一并删除） */
export function deleteTodoSpace(
  id: string,
  options: { moveTo?: string; deleteTodos?: boolean } = {},
): Promise<{ spaces: TodoSpace[]; moved: number; deleted: number }> {
  const query = new URLSearchParams();
  if (options.moveTo) query.set("move_to", options.moveTo);
  if (options.deleteTodos) query.set("delete_todos", "true");
  const text = query.toString();
  const suffix = text ? `?${text}` : "";
  return apiFetch<{ spaces: TodoSpace[]; moved: number; deleted: number }>(
    `${BASE}/spaces/${encodePath(id)}${suffix}`,
    { method: "DELETE" },
  );
}

export function createTodo(input: TodoInput): Promise<Todo> {
  return apiFetch<Todo>(BASE, { method: "POST", body: jsonBody(input) });
}

export function updateTodo(id: string, input: TodoInput): Promise<Todo> {
  return apiFetch<Todo>(`${BASE}/${encodePath(id)}`, { method: "PATCH", body: jsonBody(input) });
}

export interface AddProgressOptions {
  status?: TodoStatus;
  done?: boolean;
}

export interface AddProgressResult extends TodoProgress {
  status?: TodoStatus;
  done?: boolean;
  done_at?: number | null;
}

export function addTodoProgress(id: string, text: string, options: AddProgressOptions = {}): Promise<AddProgressResult> {
  const payload: { text: string; status?: TodoStatus; done?: boolean } = { text };
  if (options.status !== undefined) payload.status = options.status;
  if (options.done !== undefined) payload.done = options.done;
  return apiFetch<AddProgressResult>(`${BASE}/${encodePath(id)}/progress`, { method: "POST", body: jsonBody(payload) });
}

export function deleteTodo(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`${BASE}/${encodePath(id)}`, { method: "DELETE" });
}

export function reorderTodos(ids: string[]): Promise<{ todos: Todo[] }> {
  return apiFetch<{ todos: Todo[] }>(`${BASE}/reorder`, { method: "POST", body: jsonBody({ ids }) });
}

export function clearCompletedTodos(list?: string, space?: string): Promise<{ deleted: number }> {
  const payload: { list?: string; space?: string } = {};
  if (list !== undefined) payload.list = list;
  if (space !== undefined) payload.space = space;
  return apiFetch<{ deleted: number }>(`${BASE}/clear-completed`, { method: "POST", body: jsonBody(payload) });
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
