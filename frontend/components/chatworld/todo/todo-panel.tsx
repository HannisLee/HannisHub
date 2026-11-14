"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { errorMessage } from "../../../lib/format";
import {
  clearCompletedTodos, createTodo, deleteTodo, fetchTodos, localDate, newSubtaskId, PRIORITY_LABELS, reorderTodos,
  TODO_LIST_MAX, TODO_NOTE_MAX, TODO_SUBTASK_MAX, TODO_TITLE_MAX, updateTodo, type Todo, type TodoInput, type TodoPriority,
} from "../../../lib/todos";
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, ProgressBar } from "../../ui/primitives";

/** 左侧视图：今天、计划中、重要、全部、已完成，以及按清单筛选（list:清单名） */
type View = "today" | "planned" | "important" | "all" | "done" | `list:${string}`;
type SortMode = "manual" | "due" | "priority" | "created";

interface Group {
  key: string;
  title: string;
  items: Todo[];
  /** 已完成分组默认折叠 */
  collapsible?: boolean;
}

const VIEW_TITLES: Record<string, string> = {
  today: "今天", planned: "计划中", important: "重要", all: "全部待办", done: "已完成",
};
const VIEW_HINTS: Record<string, string> = {
  today: "加入今天的事、今天到期和已逾期的事",
  planned: "设了截止日期的待办，按日期分组",
  important: "高优先级的待办",
  all: "全部未完成的待办",
  done: "按完成时间倒序",
};
const SORT_LABELS: Record<SortMode, string> = { manual: "手动顺序", due: "截止日期", priority: "优先级", created: "创建时间" };
const UNLISTED = "未分类";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function dateLabel(value: string, today: string): string {
  if (!value) return "";
  if (value === today) return "今天";
  if (value === localDate(1)) return "明天";
  if (value === localDate(-1)) return "昨天";
  const [y, m, d] = value.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y === new Date().getFullYear() ? "" : `${y}年`}${m}月${d}日 ${weekday}`;
}

function sameLocalDay(timestamp: number | null, day: string): boolean {
  if (!timestamp) return false;
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === day;
}

function sortTodos(items: Todo[], mode: SortMode): Todo[] {
  const copy = [...items];
  const byManual = (a: Todo, b: Todo) => a.sort - b.sort || a.created_at - b.created_at;
  if (mode === "due") copy.sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || byManual(a, b));
  else if (mode === "priority") copy.sort((a, b) => b.priority - a.priority || byManual(a, b));
  else if (mode === "created") copy.sort((a, b) => b.created_at - a.created_at);
  else copy.sort(byManual);
  return copy;
}

/** 工位待办：上班用的个人待办清单（今天 / 计划 / 重要 / 清单分组，优先级、截止日期、子任务、备注、搜索与排序）。
 *  既是独立页面 /todo，也内嵌在聊天大厅「我的工位」的对话框中。数据按登录账号隔离。 */
export function TodoPanel() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>("today");
  const [sortMode, setSortMode] = useState<SortMode>("manual");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  // 快速添加
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TodoPriority>(0);
  const [due, setDue] = useState("");
  const [listName, setListName] = useState("");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 过了零点后「今天」随之变化：每分钟检查一次本地日期
  const [today, setToday] = useState(() => localDate());

  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDate()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await fetchTodos();
      setTodos(data.todos);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
      setTodos(current => current ?? []);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    fetchTodos()
      .then(data => {
        if (alive) setTodos(data.todos);
      })
      .catch(value => {
        if (!alive) return;
        setError(errorMessage(value));
        setTodos([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 乐观更新：先改本地，失败时提示并重新读取 */
  const patch = useCallback(async (id: string, input: TodoInput) => {
    setTodos(current => current?.map(todo => (todo.id === id ? { ...todo, ...input } as Todo : todo)) ?? current);
    try {
      const saved = await updateTodo(id, input);
      setTodos(current => current?.map(todo => (todo.id === id ? saved : todo)) ?? current);
    } catch (value) {
      setError(errorMessage(value));
      void load();
    }
  }, [load]);

  const remove = useCallback(async (todo: Todo) => {
    if (!window.confirm(`删除待办「${todo.title}」？`)) return;
    setTodos(current => current?.filter(item => item.id !== todo.id) ?? current);
    try {
      await deleteTodo(todo.id);
    } catch (value) {
      setError(errorMessage(value));
      void load();
    }
  }, [load]);

  const all = useMemo(() => todos ?? [], [todos]);
  const lists = useMemo(() => {
    const counts = new Map<string, number>();
    for (const todo of all) {
      if (!todo.list) continue;
      counts.set(todo.list, (counts.get(todo.list) ?? 0) + (todo.done ? 0 : 1));
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
  }, [all]);

  const inToday = useCallback((todo: Todo) => todo.my_day === today || (Boolean(todo.due_date) && todo.due_date <= today), [today]);
  const open = all.filter(todo => !todo.done);
  const counts = {
    today: open.filter(inToday).length,
    planned: open.filter(todo => todo.due_date).length,
    important: open.filter(todo => todo.priority === 3).length,
    all: open.length,
    done: all.filter(todo => todo.done).length,
  };
  const overdue = open.filter(todo => todo.due_date && todo.due_date < today).length;
  const doneToday = all.filter(todo => todo.done && sameLocalDay(todo.done_at, today)).length;
  const todayTotal = counts.today + doneToday;

  const groups = useMemo<Group[]>(() => {
    const query = search.trim().toLowerCase();
    const matches = (todo: Todo) => !query || todo.title.toLowerCase().includes(query) || todo.note.toLowerCase().includes(query)
      || todo.list.toLowerCase().includes(query) || todo.subtasks.some(sub => sub.title.toLowerCase().includes(query));
    const pool = all.filter(matches);
    const pending = pool.filter(todo => !todo.done);
    const finished = pool.filter(todo => todo.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
    const sorted = (items: Todo[]) => sortTodos(items, sortMode);
    const doneGroup = (items: Todo[], title = "已完成"): Group[] => (items.length ? [{ key: "done", title, items, collapsible: true }] : []);

    if (view === "today") {
      const late = pending.filter(todo => todo.due_date && todo.due_date < today);
      const now = pending.filter(todo => inToday(todo) && !(todo.due_date && todo.due_date < today));
      return [
        ...(late.length ? [{ key: "late", title: "已逾期", items: sorted(late) }] : []),
        { key: "today", title: "今天", items: sorted(now) },
        ...doneGroup(finished.filter(todo => sameLocalDay(todo.done_at, today)), "今天完成"),
      ];
    }
    if (view === "planned") {
      const buckets: [string, string, (d: string) => boolean][] = [
        ["late", "已逾期", d => d < today],
        ["today", "今天", d => d === today],
        ["tomorrow", "明天", d => d === localDate(1)],
        ["week", "未来 7 天", d => d > localDate(1) && d <= localDate(7)],
        ["later", "以后", d => d > localDate(7)],
      ];
      const dated = pending.filter(todo => todo.due_date);
      return buckets
        .map(([key, title, test]) => ({ key, title, items: sortTodos(dated.filter(todo => test(todo.due_date)), "due") }))
        .filter(group => group.items.length);
    }
    if (view === "important") {
      return [{ key: "important", title: "高优先级", items: sorted(pending.filter(todo => todo.priority === 3)) }];
    }
    if (view === "done") return [{ key: "done-all", title: "已完成", items: finished }];
    if (view.startsWith("list:")) {
      const name = view.slice(5);
      return [
        { key: "list", title: name || UNLISTED, items: sorted(pending.filter(todo => todo.list === name)) },
        ...doneGroup(finished.filter(todo => todo.list === name)),
      ];
    }
    return [{ key: "all", title: "未完成", items: sorted(pending) }, ...doneGroup(finished)];
  }, [all, view, sortMode, search, today, inToday]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text || adding) return;
    setAdding(true);
    // 在哪个视图添加，就带上对应属性：今天视图加入今天、重要视图设为高优先级、清单视图归入该清单
    const input: TodoInput = {
      title: text,
      priority: view === "important" && priority === 0 ? 3 : priority,
      due_date: due || (view === "planned" ? today : ""),
      list: listName.trim() || (view.startsWith("list:") ? view.slice(5) : ""),
      my_day: view === "today" ? today : "",
    };
    try {
      const saved = await createTodo(input);
      setTodos(current => [...(current ?? []), saved]);
      setTitle("");
      setDue("");
      setPriority(0);
      setError("");
      inputRef.current?.focus();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setAdding(false);
    }
  }

  /** 手动顺序下与相邻项交换位置 */
  async function move(items: Todo[], index: number, delta: number) {
    const other = items[index + delta];
    const todo = items[index];
    if (!other || !todo) return;
    const ordered = delta < 0 ? [todo.id, other.id] : [other.id, todo.id];
    setTodos(current => current?.map(item => {
      if (item.id === todo.id) return { ...item, sort: other.sort };
      if (item.id === other.id) return { ...item, sort: todo.sort };
      return item;
    }) ?? current);
    try {
      const data = await reorderTodos(ordered);
      setTodos(data.todos);
    } catch (value) {
      setError(errorMessage(value));
      void load();
    }
  }

  async function clearDone() {
    const scope = view.startsWith("list:") ? view.slice(5) : undefined;
    const count = all.filter(todo => todo.done && (scope === undefined || todo.list === scope)).length;
    if (!count || !window.confirm(`删除 ${count} 条已完成的待办？`)) return;
    try {
      await clearCompletedTodos(scope);
      await load();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  const viewTitle = view.startsWith("list:") ? view.slice(5) || UNLISTED : VIEW_TITLES[view];
  const viewHint = view.startsWith("list:") ? "这个清单里的待办" : VIEW_HINTS[view];
  const canMove = sortMode === "manual" && !search.trim() && view !== "planned" && view !== "done";

  const navItem = (key: View, label: string, count: number) => (
    <button key={key} type="button" className={`todo-nav-item${view === key ? " is-active" : ""}`} onClick={() => { setView(key); setExpanded(null); }}>
      <span>{label}</span>
      {count ? <span className="todo-nav-count">{count}</span> : null}
    </button>
  );

  return <>
    <PageHeader
      kicker="聊天大厅 / 我的工位"
      title="工位待办"
      description={`${dateLabel(today, "")}${overdue ? ` · ${overdue} 项已逾期` : ""}。只有你自己看得到，按账号保存。`}
    />
    {error ? <ErrorState message={error} /> : null}
    {todos === null ? <LoadingState /> : (
      <div className="todo-layout">
        <nav className="todo-nav" aria-label="待办视图">
          {navItem("today", "今天", counts.today)}
          {navItem("planned", "计划中", counts.planned)}
          {navItem("important", "重要", counts.important)}
          {navItem("all", "全部", counts.all)}
          {navItem("done", "已完成", counts.done)}
          {lists.length ? <p className="todo-nav-label">清单</p> : null}
          {lists.map(([name, count]) => navItem(`list:${name}`, name, count))}
        </nav>

        <section className="todo-main">
          <header className="todo-main-head">
            <div>
              <h2 className="todo-view-title">{viewTitle}</h2>
              <p className="todo-view-hint">{viewHint}</p>
            </div>
            {view === "today" && todayTotal ? (
              <div className="todo-progress" aria-label="今天的进度">
                <span>今天已完成 {doneToday} / {todayTotal}</span>
                <ProgressBar value={(doneToday / todayTotal) * 100} tone="success" />
              </div>
            ) : null}
          </header>

          <form className="todo-add" onSubmit={event => void add(event)}>
            <input
              ref={inputRef}
              className="todo-add-input"
              value={title}
              maxLength={TODO_TITLE_MAX}
              onChange={event => setTitle(event.target.value)}
              placeholder={view === "today" ? "添加今天要做的事，回车保存" : "添加待办，回车保存"}
              aria-label="待办内容"
            />
            <div className="todo-add-options">
              <select className="select-compact" value={priority} onChange={event => setPriority(Number(event.target.value) as TodoPriority)} aria-label="优先级">
                {([0, 1, 2, 3] as TodoPriority[]).map(p => <option key={p} value={p}>优先级：{PRIORITY_LABELS[p]}</option>)}
              </select>
              <input className="todo-date" type="date" value={due} onChange={event => setDue(event.target.value)} aria-label="截止日期" title="截止日期" />
              <input
                className="todo-list-input"
                value={listName}
                maxLength={TODO_LIST_MAX}
                onChange={event => setListName(event.target.value)}
                placeholder={view.startsWith("list:") ? view.slice(5) : "清单（可选）"}
                list="todo-lists"
                aria-label="清单"
              />
              <datalist id="todo-lists">{lists.map(([name]) => <option key={name} value={name} />)}</datalist>
              <Button type="submit" size="sm" disabled={!title.trim() || adding}>{adding ? "添加中…" : "添加"}</Button>
            </div>
          </form>

          <div className="todo-toolbar">
            <input className="todo-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题、备注、清单、子任务" aria-label="搜索待办" />
            <select className="select-compact" value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} aria-label="排序">
              {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => <option key={mode} value={mode}>排序：{SORT_LABELS[mode]}</option>)}
            </select>
            {counts.done ? <Button size="sm" variant="quiet" onClick={() => void clearDone()}>清除已完成</Button> : null}
          </div>

          {groups.every(group => !group.items.length) ? (
            <EmptyState
              title={search.trim() ? "没有匹配的待办" : view === "today" ? "今天还没有安排" : "这里还是空的"}
              detail={search.trim() ? "换个关键词试试。" : view === "today" ? "在上方输入框写下今天要做的第一件事。" : "在上方输入框添加一条待办。"}
            />
          ) : groups.map(group => {
            if (!group.items.length && group.key !== "today") return null;
            const folded = group.collapsible && !showDone;
            return (
              <div className="todo-group" key={group.key}>
                {group.collapsible ? (
                  <button type="button" className="todo-group-title is-toggle" onClick={() => setShowDone(value => !value)} aria-expanded={!folded}>
                    <span className={`todo-caret${folded ? "" : " is-open"}`} aria-hidden="true">›</span>
                    {group.title} · {group.items.length}
                  </button>
                ) : (
                  <h3 className={`todo-group-title${group.key === "late" ? " is-late" : ""}`}>{group.title} · {group.items.length}</h3>
                )}
                {folded ? null : (
                  <ul className="todo-list">
                    {group.items.length ? group.items.map((todo, index) => (
                      <TodoRow
                        key={todo.id}
                        todo={todo}
                        today={today}
                        expanded={expanded === todo.id}
                        lists={lists.map(([name]) => name)}
                        onToggleExpand={() => setExpanded(current => (current === todo.id ? null : todo.id))}
                        onPatch={input => void patch(todo.id, input)}
                        onRemove={() => void remove(todo)}
                        onMove={canMove && !todo.done ? delta => void move(group.items, index, delta) : undefined}
                        isFirst={index === 0}
                        isLast={index === group.items.length - 1}
                      />
                    )) : <li className="todo-group-empty">今天的事都安排好了？在上方添加，或把其他待办「加入今天」。</li>}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      </div>
    )}
  </>;
}

interface TodoRowProps {
  todo: Todo;
  today: string;
  expanded: boolean;
  lists: string[];
  onToggleExpand: () => void;
  onPatch: (input: TodoInput) => void;
  onRemove: () => void;
  onMove?: (delta: number) => void;
  isFirst: boolean;
  isLast: boolean;
}

function TodoRow({ todo, today, expanded, lists, onToggleExpand, onPatch, onRemove, onMove, isFirst, isLast }: TodoRowProps) {
  const late = !todo.done && Boolean(todo.due_date) && todo.due_date < today;
  const dueToday = !todo.done && todo.due_date === today;
  const subDone = todo.subtasks.filter(sub => sub.done).length;
  const inMyDay = todo.my_day === today;

  return (
    <li className={`todo-item${todo.done ? " is-done" : ""}${expanded ? " is-expanded" : ""}`}>
      <div className="todo-row">
        <input
          type="checkbox"
          className="todo-check"
          checked={todo.done}
          onChange={event => onPatch({ done: event.target.checked })}
          aria-label={todo.done ? `标记「${todo.title}」为未完成` : `完成「${todo.title}」`}
        />
        <button type="button" className="todo-row-main" onClick={onToggleExpand} aria-expanded={expanded}>
          <span className="todo-title">
            {todo.priority ? <span className={`todo-priority is-p${todo.priority}`} title={`优先级：${PRIORITY_LABELS[todo.priority]}`} aria-label={`优先级${PRIORITY_LABELS[todo.priority]}`} /> : null}
            {todo.title}
          </span>
          <span className="todo-meta">
            {inMyDay ? <span className="todo-chip is-brand">今天</span> : null}
            {todo.due_date ? <span className={`todo-chip${late ? " is-late" : dueToday ? " is-due" : ""}`}>{late ? "逾期 · " : "截止 "}{dateLabel(todo.due_date, today)}</span> : null}
            {todo.list ? <span className="todo-chip">{todo.list}</span> : null}
            {todo.subtasks.length ? <span className="todo-chip">子任务 {subDone}/{todo.subtasks.length}</span> : null}
            {todo.note ? <span className="todo-chip">有备注</span> : null}
          </span>
        </button>
        <div className="todo-row-actions">
          {!todo.done ? (
            <button type="button" className={`todo-icon${inMyDay ? " is-on" : ""}`} onClick={() => onPatch({ my_day: inMyDay ? "" : today })} title={inMyDay ? "移出今天" : "加入今天"} aria-label={inMyDay ? "移出今天" : "加入今天"}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg>
            </button>
          ) : null}
          {onMove ? <>
            <button type="button" className="todo-icon" onClick={() => onMove(-1)} disabled={isFirst} title="上移" aria-label="上移">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" /></svg>
            </button>
            <button type="button" className="todo-icon" onClick={() => onMove(1)} disabled={isLast} title="下移" aria-label="下移">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
            </button>
          </> : null}
          <button type="button" className="todo-icon is-danger" onClick={onRemove} title="删除" aria-label={`删除「${todo.title}」`}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
          </button>
        </div>
      </div>
      {expanded ? <TodoDetail todo={todo} today={today} lists={lists} onPatch={onPatch} /> : null}
    </li>
  );
}

/** 展开的详情：标题、备注在失焦时保存；优先级、日期、清单、子任务改动立即保存 */
function TodoDetail({ todo, today, lists, onPatch }: { todo: Todo; today: string; lists: string[]; onPatch: (input: TodoInput) => void }) {
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [list, setList] = useState(todo.list);
  const [subtask, setSubtask] = useState("");
  const listId = `todo-detail-lists-${todo.id}`;

  const commitTitle = () => {
    const text = title.trim();
    if (!text) setTitle(todo.title);
    else if (text !== todo.title) onPatch({ title: text });
  };
  const addSubtask = (event: FormEvent) => {
    event.preventDefault();
    const text = subtask.trim();
    if (!text || todo.subtasks.length >= TODO_SUBTASK_MAX) return;
    onPatch({ subtasks: [...todo.subtasks, { id: newSubtaskId(), title: text, done: false }] });
    setSubtask("");
  };

  return (
    <div className="todo-detail">
      <label className="todo-field">
        <span>标题</span>
        <input value={title} maxLength={TODO_TITLE_MAX} onChange={event => setTitle(event.target.value)} onBlur={commitTitle}
          onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
      </label>
      <div className="todo-detail-grid">
        <label className="todo-field">
          <span>优先级</span>
          <select value={todo.priority} onChange={event => onPatch({ priority: Number(event.target.value) as TodoPriority })}>
            {([0, 1, 2, 3] as TodoPriority[]).map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
        </label>
        <label className="todo-field">
          <span>截止日期</span>
          <input type="date" value={todo.due_date} onChange={event => onPatch({ due_date: event.target.value })} />
        </label>
        <label className="todo-field">
          <span>清单</span>
          <input value={list} maxLength={TODO_LIST_MAX} list={listId} placeholder={UNLISTED} onChange={event => setList(event.target.value)}
            onBlur={() => { if (list.trim() !== todo.list) onPatch({ list: list.trim() }); }} />
          <datalist id={listId}>{lists.map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="todo-field todo-field-check">
          <input type="checkbox" checked={todo.my_day === today} onChange={event => onPatch({ my_day: event.target.checked ? today : "" })} />
          <span>加入今天</span>
        </label>
      </div>

      <div className="todo-subtasks">
        <span className="todo-field-label">子任务{todo.subtasks.length ? ` · ${todo.subtasks.filter(s => s.done).length}/${todo.subtasks.length}` : ""}</span>
        {todo.subtasks.length ? (
          <ul>
            {todo.subtasks.map(sub => (
              <li key={sub.id} className={sub.done ? "is-done" : ""}>
                <input type="checkbox" checked={sub.done} aria-label={`完成子任务「${sub.title}」`}
                  onChange={event => onPatch({ subtasks: todo.subtasks.map(item => (item.id === sub.id ? { ...item, done: event.target.checked } : item)) })} />
                <span>{sub.title}</span>
                <button type="button" className="todo-icon is-danger" aria-label={`删除子任务「${sub.title}」`}
                  onClick={() => onPatch({ subtasks: todo.subtasks.filter(item => item.id !== sub.id) })}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="todo-subtask-add" onSubmit={addSubtask}>
          <input value={subtask} maxLength={TODO_TITLE_MAX} onChange={event => setSubtask(event.target.value)} placeholder="添加子任务，回车保存" aria-label="添加子任务" />
        </form>
      </div>

      <label className="todo-field">
        <span>备注</span>
        <textarea rows={3} value={note} maxLength={TODO_NOTE_MAX} placeholder="补充说明、链接、会议记录……" onChange={event => setNote(event.target.value)}
          onBlur={() => { if (note !== todo.note) onPatch({ note }); }} />
      </label>
      <p className="todo-detail-foot">
        创建于 {new Date(todo.created_at * 1000).toLocaleString("zh-CN", { hour12: false })}
        {todo.done && todo.done_at ? ` · 完成于 ${new Date(todo.done_at * 1000).toLocaleString("zh-CN", { hour12: false })}` : ""}
      </p>
    </div>
  );
}
