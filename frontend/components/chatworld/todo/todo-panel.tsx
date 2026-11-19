"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { errorMessage } from "../../../lib/format";
import { blockedFirst, buildProgressTimeline, mergeProgressEntries, sortTodoItems, type TimelineItem, type TodoSortMode } from "../../../lib/todo-timeline";
import {
  addTodoProgress, createTodo, deleteTodo, fetchTodos, localDate, newSubtaskId, normalizeTodoStatus,
  PRIORITY_LABELS, PRIORITY_OPTIONS, PRIORITY_TAGS, reorderTodos, TODO_LIST_MAX, TODO_NOTE_MAX,
  TODO_PROGRESS_MAX, TODO_STATUS_LABELS, TODO_STATUSES, TODO_SUBTASK_MAX, TODO_TITLE_MAX, updateTodo,
  type AddProgressOptions, type Todo, type TodoInput, type TodoPriority, type TodoStatus,
} from "../../../lib/todos";
import { Button, EmptyState, ErrorState, LoadingState, ProgressBar } from "../../ui/primitives";

/** 左侧视图：今天、逾期、计划中、重要、全部、已完成，以及按清单筛选（list:清单名） */
type View = "today" | "planned" | "important" | "overdue" | "all" | "done" | `list:${string}`;

interface Group {
  key: string;
  title: string;
  items: Todo[];
  /** 已完成分组默认折叠 */
  collapsible?: boolean;
}

type ProgressDraftStatus = TodoStatus | "done";

interface ProgressDraft {
  text: string;
  status: ProgressDraftStatus;
}

const VIEW_TITLES: Record<string, string> = {
  today: "今天", planned: "计划中", important: "重要", overdue: "已逾期", all: "全部待办", done: "已完成",
};
const UNLISTED = "未分类";
/** 屏幕阅读器用的排序提示，所有可排序标题按钮共用 */
const REORDER_HINT_ID = "todo-reorder-hint";
const SORT_STORAGE_KEY = "hannishub:todo-sort";
const SORT_LABELS: Record<Exclude<TodoSortMode, "due">, string> = {
  manual: "手动排序",
  priority: "按优先级",
  updated: "按最近更新",
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function formatHeaderDate(value: string): string {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${m}月${d}日 · ${weekday}`;
}

function dateLabel(value: string, today: string): string {
  if (!value) return "";
  if (value === today) return "今天";
  if (value === localDate(1)) return "明天";
  if (value === localDate(-1)) return "昨天";
  const [y, m, d] = value.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${y === new Date().getFullYear() ? "" : `${y}年`}${m}月${d}日 ${weekday}`;
}

function assignedDayLabel(day: string, today: string): string {
  // 只比较日历日期，避免夏令时使相邻两天不满 24 小时。
  const days = (Date.parse(today) - Date.parse(day)) / 86_400_000;
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return days > 0 ? `${days}天前` : `${-days}天后`;
}

/** 进度时间：今天视图只显示 HH:MM；其他视图显示 MM-DD HH:MM（非今年加年份） */
function progressTimeLabel(item: TimelineItem, compact: boolean): string {
  if (item.kind === "unknown") return "时间未知";
  if (compact) return item.timeText;
  const [year, month, day] = item.dateTimeText.slice(0, 10).split("-");
  const prefix = year === String(new Date().getFullYear()) ? "" : `${year}-`;
  return `${prefix}${month}-${day} ${item.timeText}`;
}

function sameLocalDay(timestamp: number | null, day: string): boolean {
  if (!timestamp) return false;
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === day;
}

function normalizeTodo(raw: Todo): Todo {
  return {
    ...raw,
    status: normalizeTodoStatus(raw.status),
  };
}

function isImeComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

/** 工位待办：上班用的个人待办清单（三状态执行流、完整进度时间轴、快速添加、手动/优先级/更新排序）。
 *  既是独立页面 /todo，也内嵌在聊天大厅「我的工位」的对话框中。数据按登录账号隔离。 */
export function TodoPanel() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<View>("today");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [sortMode, setSortMode] = useState<Exclude<TodoSortMode, "due">>(() => {
    if (typeof window === "undefined") return "manual";
    const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
    return saved === "priority" || saved === "updated" ? saved : "manual";
  });

  // 快速添加
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TodoPriority>(2);
  const [due, setDue] = useState("");
  const [listName, setListName] = useState("");
  const [addExpanded, setAddExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addBlurTimerRef = useRef<number | null>(null);

  // 同一时间仅展开一个任务的原地进度编辑器，切走或按 Esc 保留未保存草稿
  const [activeProgressId, setActiveProgressId] = useState<string | null>(null);
  const [progressDrafts, setProgressDrafts] = useState<Record<string, ProgressDraft>>({});
  const [savingStatusIds, setSavingStatusIds] = useState<Record<string, boolean>>({});

  // 过了零点后「今天」随之变化：每分钟检查一次本地日期
  const [today, setToday] = useState(() => localDate());

  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDate()), 60_000);
    return () => {
      window.clearInterval(timer);
      if (addBlurTimerRef.current !== null) window.clearTimeout(addBlurTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const showNotice = useCallback((message: string) => {
    setError("");
    setNotice(message);
  }, []);

  const changeSortMode = (next: Exclude<TodoSortMode, "due">) => {
    setSortMode(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    }
  };

  const replaceTodos = useCallback((items: Todo[]) => {
    setTodos(current => {
      const byId = new Map(current?.map(todo => [todo.id, todo.progress]));
      return items.map(raw => {
        const todo = normalizeTodo(raw);
        return { ...todo, progress: mergeProgressEntries(todo.progress, byId.get(todo.id) ?? []) };
      });
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await fetchTodos();
      replaceTodos(data.todos);
    } catch (value) {
      setError(errorMessage(value));
      setTodos(current => current ?? []);
    }
  }, [replaceTodos]);

  useEffect(() => {
    let alive = true;
    fetchTodos()
      .then(data => {
        if (alive) setTodos(data.todos.map(normalizeTodo));
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

  /** 乐观更新：先改本地，失败时立即回滚并提示 */
  const patch = useCallback(async (id: string, input: TodoInput, feedback?: string): Promise<boolean> => {
    let snapshot: Todo | undefined;
    setTodos(current => {
      snapshot = current?.find(todo => todo.id === id);
      return current?.map(todo => (todo.id === id ? { ...todo, ...input } as Todo : todo)) ?? current;
    });
    if (input.status !== undefined) {
      setSavingStatusIds(prev => ({ ...prev, [id]: true }));
    }
    try {
      const saved = normalizeTodo(await updateTodo(id, input));
      setTodos(current => current?.map(todo => (
        todo.id === id ? { ...saved, progress: mergeProgressEntries(saved.progress, todo.progress) } : todo
      )) ?? current);
      if (feedback) showNotice(feedback);
      else setError("");
      return true;
    } catch (value) {
      if (snapshot) {
        const fallback = snapshot;
        setTodos(current => current?.map(todo => (todo.id === id ? fallback : todo)) ?? current);
      }
      setError(errorMessage(value));
      void load();
      return false;
    } finally {
      if (input.status !== undefined) {
        setSavingStatusIds(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
  }, [load, showNotice]);

  const addProgress = useCallback(async (id: string, text: string, options: AddProgressOptions = {}) => {
    const saved = await addTodoProgress(id, text, options);
    const entry = { id: saved.id, text: saved.text, created_at: saved.created_at };
    setTodos(current => current?.map(todo => {
      if (todo.id !== id) return todo;
      return {
        ...todo,
        status: saved.status ? normalizeTodoStatus(saved.status) : todo.status,
        done: saved.done !== undefined ? saved.done : todo.done,
        done_at: saved.done_at !== undefined ? saved.done_at : todo.done_at,
        updated_at: saved.created_at,
        progress: mergeProgressEntries(todo.progress, [entry]),
      };
    }) ?? current);
    if (options.done === true) showNotice("已完成待办并记录进度");
    else if (options.done === false) showNotice(options.status ? `已恢复并更新为「${TODO_STATUS_LABELS[options.status]}」` : "已恢复为未完成");
    else showNotice(options.status ? `进度已保存（${TODO_STATUS_LABELS[options.status]}）` : "进度已保存");
  }, [showNotice]);

  const removeTodo = useCallback(async (todo: Todo) => {
    if (typeof window !== "undefined" && !window.confirm(`确定删除「${todo.title}」吗？此操作无法撤销。`)) return;
    let snapshot: Todo[] | null = null;
    setTodos(current => {
      snapshot = current;
      return current ? current.filter(item => item.id !== todo.id) : current;
    });
    try {
      await deleteTodo(todo.id);
      if (expanded === todo.id) setExpanded(null);
      if (activeProgressId === todo.id) setActiveProgressId(null);
      setProgressDrafts(prev => {
        if (!(todo.id in prev)) return prev;
        const next = { ...prev };
        delete next[todo.id];
        return next;
      });
      showNotice("待办已删除");
    } catch (value) {
      if (snapshot) setTodos(snapshot);
      setError(errorMessage(value));
      void load();
    }
  }, [activeProgressId, expanded, load, showNotice]);

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
    const pending = all.filter(todo => !todo.done);
    const finished = all.filter(todo => todo.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0));
    const sorted = (items: Todo[]) => sortTodoItems(items, sortMode);
    const doneGroup = (items: Todo[], titleText = "已完成"): Group[] => (
      items.length ? [{ key: "done", title: titleText, items, collapsible: true }] : []
    );

    if (view === "today") {
      const late = pending.filter(todo => todo.due_date && todo.due_date < today);
      const now = pending.filter(todo => inToday(todo) && !(todo.due_date && todo.due_date < today));
      return [
        ...(late.length ? [{ key: "late", title: "已逾期", items: sorted(late) }] : []),
        // 阻塞中的任务置顶，其余保持当前排序（默认手动顺序）
        { key: "today", title: "待完成", items: blockedFirst(sorted(now)) },
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
        .map(([key, bucketTitle, test]) => ({ key, title: bucketTitle, items: sortTodoItems(dated.filter(todo => test(todo.due_date)), "due") }))
        .filter(group => group.items.length);
    }
    if (view === "overdue") return [{ key: "late", title: "已逾期", items: sorted(pending.filter(todo => todo.due_date && todo.due_date < today)) }];
    if (view === "important") {
      return [{ key: "important", title: "高优先级（P0）", items: sorted(pending.filter(todo => todo.priority === 3)) }];
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
  }, [all, view, today, inToday, sortMode]);

  function resetAddForm(collapse: boolean) {
    setTitle("");
    setDue("");
    setListName("");
    setPriority(2);
    if (collapse) {
      setAddExpanded(false);
      inputRef.current?.blur();
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const text = title.trim();
    if (!text || adding) return;
    setAdding(true);
    // 在哪个视图添加，就带上对应属性：今天视图加入今天、重要视图设为 P0、清单视图归入该清单
    const input: TodoInput = {
      title: text,
      priority: view === "important" && priority === 2 ? 3 : priority,
      due_date: due || (view === "planned" ? today : ""),
      list: listName.trim() || (view.startsWith("list:") ? view.slice(5) : ""),
      my_day: view === "today" ? today : "",
      status: "not_started",
    };
    try {
      const saved = normalizeTodo(await createTodo(input));
      setTodos(current => [...(current ?? []), saved]);
      if (view === "done" || view === "overdue") {
        setView("all");
      }
      setTitle("");
      setDue("");
      setPriority(2);
      setAddExpanded(true);
      showNotice("已添加待办");
      inputRef.current?.focus();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setAdding(false);
    }
  }

  const [dragging, setDragging] = useState<{ id: string; groupKey: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: "before" | "after" } | null>(null);

  /** 手动顺序下拖动或键盘调整条目位置 */
  async function moveTo(items: Todo[], sourceId: string, targetId: string, position: "before" | "after") {
    if (sourceId === targetId) return;
    const movable = items.filter(item => !item.done);
    const fromIndex = movable.findIndex(item => item.id === sourceId);
    const targetIndex = movable.findIndex(item => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;

    const reordered = [...movable];
    const [moved] = reordered.splice(fromIndex, 1);
    let insertAt = reordered.findIndex(item => item.id === targetId);
    if (position === "after") insertAt += 1;
    if (insertAt === fromIndex) return;
    reordered.splice(insertAt, 0, moved);

    const orderedIds = reordered.map(item => item.id);
    const slots = movable.map(item => item.sort).sort((a, b) => a - b);
    const nextSort = new Map(orderedIds.map((id, idx) => [id, slots[idx]]));

    setTodos(current => current?.map(item => (
      nextSort.has(item.id) ? { ...item, sort: nextSort.get(item.id)! } : item
    )) ?? current);
    try {
      const data = await reorderTodos(orderedIds);
      replaceTodos(data.todos);
    } catch (value) {
      setError(errorMessage(value));
      void load();
    }
  }

  function moveBy(items: Todo[], todoId: string, delta: number) {
    const movable = items.filter(item => !item.done);
    const index = movable.findIndex(item => item.id === todoId);
    const target = movable[index + delta];
    if (index < 0 || !target) return;
    void moveTo(items, todoId, target.id, delta < 0 ? "before" : "after");
  }

  const viewTitle = view.startsWith("list:") ? view.slice(5) || UNLISTED : VIEW_TITLES[view];
  const canManualReorder = sortMode === "manual" && view !== "planned" && view !== "done";
  const showSortSelect = view !== "planned" && view !== "done";
  const firstPendingGroupKey = groups.find(g => g.key !== "done" && g.key !== "done-all")?.key;
  const isAddOpen = addExpanded || Boolean(title);

  const navItem = (key: View, label: string, count: number, fullTitle?: string) => (
    <button
      key={key}
      type="button"
      title={fullTitle ?? label}
      aria-label={`${fullTitle ?? label} ${count}`}
      aria-current={view === key ? "page" : undefined}
      className={`todo-nav-item${view === key ? " is-active" : ""}${count === 0 ? " is-empty" : ""}`}
      onClick={() => { setView(key); setExpanded(null); }}
    >
      <span>{Array.from(label).slice(0, 3).join("")}</span>
      {count > 0 ? <span className="todo-nav-count">{count}</span> : null}
    </button>
  );

  return <>
    {error ? <ErrorState message={error} /> : null}
    {todos === null ? <LoadingState /> : (
      <div className="todo-layout">
        <nav className="todo-nav" aria-label="待办视图">
          {navItem("today", "今天", counts.today)}
          {navItem("overdue", "已逾期", overdue)}
          {navItem("planned", "计划中", counts.planned)}
          {navItem("important", "重要", counts.important, "重要（P0 高优先级）")}
          {navItem("all", "全部", counts.all)}
          {navItem("done", "已完成", counts.done)}
          <p className="todo-nav-label">清单</p>
          {navItem("list:", UNLISTED, open.filter(todo => !todo.list).length)}
          {lists.map(([name, count]) => navItem(`list:${name}`, name, count))}
        </nav>

        <section className="todo-main">
          <p id={REORDER_HINT_ID} className="visually-hidden">可拖动标题行调整顺序，或聚焦标题后按上下方向键移动</p>
          <header className="todo-main-head">
            <div className="todo-head-title-wrap">
              <h2 className="todo-view-title">{viewTitle}</h2>
              <time className="todo-view-date" dateTime={today}>{formatHeaderDate(today)}</time>
              {notice ? <span className="todo-notice" role="status" aria-live="polite">{notice}</span> : null}
            </div>
            {view === "today" ? (
              <div className="todo-progress" aria-label="今天的进度">
                <ProgressBar value={todayTotal ? (doneToday / todayTotal) * 100 : 0} tone="success" />
                <span>已完成 {doneToday} / {todayTotal}</span>
              </div>
            ) : null}
          </header>

          <form
            className={`todo-add${isAddOpen ? " is-expanded" : ""}`}
            onSubmit={event => void add(event)}
            onFocus={() => {
              if (addBlurTimerRef.current !== null) {
                window.clearTimeout(addBlurTimerRef.current);
                addBlurTimerRef.current = null;
              }
              setAddExpanded(true);
            }}
            onBlur={event => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              if (!title.trim() && !due && !listName.trim() && priority === 2) {
                // 延迟收起，避免点击下方任务卡片时在 mousedown/click 之间发生布局跳动
                addBlurTimerRef.current = window.setTimeout(() => {
                  addBlurTimerRef.current = null;
                  setAddExpanded(false);
                }, 160);
              }
            }}
          >
            <div className="todo-add-main">
              <span className="todo-add-plus" aria-hidden="true">+</span>
              <input
                ref={inputRef}
                className="todo-add-input"
                value={title}
                maxLength={TODO_TITLE_MAX}
                onChange={event => setTitle(event.target.value)}
                onKeyDown={event => {
                  if (isImeComposing(event)) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setAddExpanded(false);
                    inputRef.current?.blur();
                  }
                }}
                placeholder={view === "today" ? "添加今天要做的事……" : "添加待办……"}
                aria-label="待办内容"
              />
              {!isAddOpen ? (
                <Button type="submit" size="sm" className="todo-add-submit" disabled={!title.trim() || adding}>
                  {adding ? "添加中…" : "添加"}
                </Button>
              ) : null}
            </div>
            {isAddOpen ? (
              <div className="todo-add-options">
                <select
                  className="select-compact"
                  value={priority}
                  onChange={event => setPriority(Number(event.target.value) as TodoPriority)}
                  aria-label="优先级"
                >
                  {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
                </select>
                <label className="todo-add-date-wrap" title="截止日期（不设表示不限截止日）">
                  <span className="todo-add-opt-label">截止</span>
                  <input
                    className="todo-date"
                    type="date"
                    value={due}
                    onChange={event => setDue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") event.preventDefault();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setAddExpanded(false);
                        inputRef.current?.blur();
                      }
                    }}
                    aria-label="截止日期"
                  />
                </label>
                <input
                  className="todo-list-input"
                  value={listName}
                  maxLength={TODO_LIST_MAX}
                  onChange={event => setListName(event.target.value)}
                  onKeyDown={event => {
                    if (isImeComposing(event)) return;
                    if (event.key === "Enter") event.preventDefault();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setAddExpanded(false);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder={view.startsWith("list:") ? view.slice(5) : "清单（可选）"}
                  list="todo-lists"
                  aria-label="清单"
                />
                <datalist id="todo-lists">{lists.map(([name]) => <option key={name} value={name} />)}</datalist>
                <div className="todo-add-actions">
                  <Button type="button" variant="quiet" size="sm" onClick={() => resetAddForm(true)} disabled={adding}>
                    取消
                  </Button>
                  <Button type="submit" size="sm" className="todo-add-submit" disabled={!title.trim() || adding}>
                    {adding ? "添加中…" : "添加"}
                  </Button>
                </div>
              </div>
            ) : null}
          </form>

          {groups.every(group => !group.items.length) ? (
            <EmptyState
              title={view === "today" ? "今天还没有安排" : view === "important" ? "暂无 P0 高优先级待办" : "这里还是空的"}
              detail={
                view === "today"
                  ? "在上方输入框写下今天要做的第一件事。"
                  : view === "important"
                    ? "将待办优先级设为 P0（高），或在上方直接添加一条重要待办。"
                    : "在上方输入框添加一条待办。"
              }
            />
          ) : groups.map(group => {
            if (!group.items.length && group.key !== "today") return null;
            const folded = group.collapsible && !showDone;
            // 今天「待完成」中阻塞任务固定置顶，手动排序只在同一分区内调整
            const partitioned = view === "today" && group.key === "today";
            const reorderScope = (todo: Todo) => (
              partitioned ? group.items.filter(item => (item.status === "blocked") === (todo.status === "blocked")) : group.items
            );
            const dragSource = dragging && dragging.groupKey === group.key ? group.items.find(item => item.id === dragging.id) : undefined;
            const showGroupSort = showSortSelect && group.key === firstPendingGroupKey;
            return (
              <div className="todo-group" key={group.key}>
                <div className="todo-group-head">
                  {group.collapsible ? (
                    <button
                      type="button"
                      className="todo-group-title is-toggle"
                      onClick={() => setShowDone(value => !value)}
                      aria-expanded={!folded}
                    >
                      <span className={`todo-caret${folded ? "" : " is-open"}`} aria-hidden="true">›</span>
                      {group.title} · {group.items.length}
                    </button>
                  ) : (
                    <h3 className={`todo-group-title${group.key === "late" ? " is-late" : ""}`}>
                      {group.title} · {group.items.length}
                    </h3>
                  )}
                  {showGroupSort ? (
                    <select
                      className="todo-sort-select"
                      value={sortMode}
                      onChange={event => changeSortMode(event.target.value as Exclude<TodoSortMode, "due">)}
                      aria-label="任务排序方式"
                      title={sortMode === "manual" ? "当前为手动排序，可拖动调整顺序" : "切换回手动排序可拖动调整顺序"}
                    >
                      {(Object.keys(SORT_LABELS) as Exclude<TodoSortMode, "due">[]).map(mode => (
                        <option key={mode} value={mode}>{SORT_LABELS[mode]}</option>
                      ))}
                    </select>
                  ) : null}
                </div>
                {folded ? null : (
                  <ul className="todo-list">
                    {group.items.length ? group.items.map(todo => {
                      const rowCanMove = canManualReorder && !todo.done;
                      const isDragging = dragging?.id === todo.id && dragging.groupKey === group.key;
                      const rowDropPosition = dropTarget?.id === todo.id && dragging?.groupKey === group.key ? dropTarget.position : null;
                      const writingProgress = activeProgressId === todo.id;
                      const draft = progressDrafts[todo.id];
                      return (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          today={today}
                          compact={view === "today"}
                          expanded={expanded === todo.id}
                          lists={lists.map(([name]) => name)}
                          writingProgress={writingProgress}
                          progressDraft={draft}
                          savingStatus={Boolean(savingStatusIds[todo.id])}
                          onToggleExpand={() => setExpanded(current => (current === todo.id ? null : todo.id))}
                          onPatch={(input, feedback) => patch(todo.id, input, feedback)}
                          onDelete={() => void removeTodo(todo)}
                          onOpenProgress={() => {
                            setActiveProgressId(todo.id);
                            setProgressDrafts(prev => (
                              prev[todo.id] ? prev : { ...prev, [todo.id]: { text: "", status: todo.done ? "done" : todo.status } }
                            ));
                          }}
                          onCloseProgress={(clearDraft: boolean) => {
                            setActiveProgressId(current => (current === todo.id ? null : current));
                            if (clearDraft) {
                              setProgressDrafts(prev => {
                                if (!(todo.id in prev)) return prev;
                                const next = { ...prev };
                                delete next[todo.id];
                                return next;
                              });
                            }
                          }}
                          onChangeProgressDraft={next => {
                            setProgressDrafts(prev => ({ ...prev, [todo.id]: next }));
                          }}
                          onAddProgress={(text, options) => addProgress(todo.id, text, options)}
                          canReorder={rowCanMove}
                          isDragging={isDragging}
                          dropPosition={rowDropPosition}
                          onDragStart={() => {
                            setDragging({ id: todo.id, groupKey: group.key });
                            setDropTarget(null);
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropTarget(null);
                          }}
                          onDragOver={position => {
                            if (!rowCanMove || !dragSource || dragSource.id === todo.id) return;
                            if (!reorderScope(dragSource).includes(todo)) return;
                            setDropTarget(prev => (prev?.id === todo.id && prev.position === position ? prev : { id: todo.id, position }));
                          }}
                          onDragLeave={() => {
                            setDropTarget(prev => (prev?.id === todo.id ? null : prev));
                          }}
                          onDrop={position => {
                            if (rowCanMove && dragSource && dragSource.id !== todo.id && reorderScope(dragSource).includes(todo)) {
                              void moveTo(reorderScope(dragSource), dragSource.id, todo.id, position);
                            }
                            setDragging(null);
                            setDropTarget(null);
                          }}
                          onMoveStep={delta => moveBy(reorderScope(todo), todo.id, delta)}
                        />
                      );
                    }) : <li className="todo-group-empty">今天的事都安排好了？在上方添加，或把其他待办「加入今天」。</li>}
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
  /** 今天视图：不显示「今天」日期标签，进度时间只显示 HH:MM */
  compact: boolean;
  expanded: boolean;
  lists: string[];
  writingProgress: boolean;
  progressDraft?: ProgressDraft;
  savingStatus: boolean;
  onToggleExpand: () => void;
  onPatch: (input: TodoInput, feedback?: string) => Promise<boolean>;
  onDelete: () => void;
  onOpenProgress: () => void;
  onCloseProgress: (clearDraft: boolean) => void;
  onChangeProgressDraft: (draft: ProgressDraft) => void;
  onAddProgress: (text: string, options?: AddProgressOptions) => Promise<void>;
  canReorder: boolean;
  isDragging: boolean;
  dropPosition: "before" | "after" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (position: "before" | "after") => void;
  onDragLeave: () => void;
  onDrop: (position: "before" | "after") => void;
  onMoveStep: (delta: number) => void;
}

function TodoRow({
  todo,
  today,
  compact,
  expanded,
  lists,
  writingProgress,
  progressDraft,
  savingStatus,
  onToggleExpand,
  onPatch,
  onDelete,
  onOpenProgress,
  onCloseProgress,
  onChangeProgressDraft,
  onAddProgress,
  canReorder,
  isDragging,
  dropPosition,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onMoveStep,
}: TodoRowProps) {
  const late = !todo.done && Boolean(todo.due_date) && todo.due_date < today;
  const dueToday = !todo.done && todo.due_date === today;
  const subDone = todo.subtasks.filter(sub => sub.done).length;
  const inMyDay = todo.my_day === today;
  const currentStatus = normalizeTodoStatus(todo.status);

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressError, setProgressError] = useState("");
  const itemRef = useRef<HTMLLIElement>(null);
  const statusWrapRef = useRef<HTMLDivElement>(null);
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  const progressButtonRef = useRef<HTMLButtonElement>(null);
  const progressTextareaRef = useRef<HTMLTextAreaElement>(null);
  const progressFormId = `todo-progress-form-${todo.id}`;
  const olderListId = `todo-progress-older-${todo.id}`;
  const [showOlder, setShowOlder] = useState(false);

  const draftText = progressDraft?.text ?? "";
  const draftStatus: ProgressDraftStatus = progressDraft?.status ?? (todo.done ? "done" : currentStatus);
  const hasUnsavedDraft = Boolean(draftText.trim()) && !writingProgress;

  // 进度按时间倒序：最新一条单独展示，更早的折叠；时间未知的记录排在最后
  const newestFirst = useMemo(() => {
    const timeline = buildProgressTimeline(todo.progress);
    return [...timeline.filter(item => item.kind !== "unknown").reverse(), ...timeline.filter(item => item.kind === "unknown")];
  }, [todo.progress]);
  const latestEntry = newestFirst[0];
  const olderEntries = newestFirst.slice(1);

  // 状态菜单：点击外部或按 Escape 关闭
  useEffect(() => {
    if (!statusMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!statusWrapRef.current?.contains(event.target as Node)) {
        setStatusMenuOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setStatusMenuOpen(false);
        statusButtonRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [statusMenuOpen]);

  // 打开进度编辑器时自动聚焦并调整高度
  useEffect(() => {
    if (!writingProgress) return;
    const el = progressTextareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(58, el.scrollHeight))}px`;
  }, [writingProgress]);

  function pointerDropPosition(clientY: number, element: HTMLElement): "before" | "after" {
    const rect = element.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function closeEditor(clearDraft: boolean) {
    setProgressError("");
    onCloseProgress(clearDraft);
    progressButtonRef.current?.focus();
  }

  async function saveProgress() {
    const trimmed = draftText.trim();
    if (!trimmed || savingProgress) return;
    setSavingProgress(true);
    setProgressError("");
    try {
      const options: AddProgressOptions = {};
      if (draftStatus === "done") {
        if (!todo.done) options.done = true;
      } else {
        if (todo.done) options.done = false;
        if (draftStatus !== currentStatus) options.status = draftStatus;
      }
      await onAddProgress(trimmed, options);
      closeEditor(true);
    } catch (value) {
      setProgressError(errorMessage(value));
    } finally {
      setSavingProgress(false);
    }
  }

  function handleSubmitProgress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveProgress();
  }

  function selectStatus(nextStatus: ProgressDraftStatus) {
    setStatusMenuOpen(false);
    if (savingStatus) return;
    if (nextStatus === "done") {
      if (!todo.done) void onPatch({ done: true }, "已完成待办");
      return;
    }
    if (todo.done) {
      const input: TodoInput = nextStatus === currentStatus ? { done: false } : { done: false, status: nextStatus };
      void onPatch(input, `已恢复为「${TODO_STATUS_LABELS[nextStatus]}」`);
      return;
    }
    if (nextStatus === currentStatus) return;
    void onPatch({ status: nextStatus }, `状态已更新为「${TODO_STATUS_LABELS[nextStatus]}」`);
  }

  const rowClassName = [
    "todo-item",
    todo.done ? "is-done" : "",
    !todo.done && currentStatus === "blocked" ? "is-blocked" : "",
    statusMenuOpen ? "has-menu-open" : "",
    isDragging ? "is-dragging" : "",
    dropPosition === "before" ? "is-drop-before" : "",
    dropPosition === "after" ? "is-drop-after" : "",
  ].filter(Boolean).join(" ");

  const effectivePriority: TodoPriority = todo.priority || 2;
  // 默认优先级（P1）不显示，其余以 6px 圆点放在标题前
  const showPriorityDot = effectivePriority !== 2;

  // 元信息改为一行纯文字，不再使用描边标签
  const metaParts: { key: string; text: string; className?: string }[] = [];
  if (todo.due_date) {
    metaParts.push({
      key: "due",
      text: `${late ? "逾期 · " : "截止 "}${dateLabel(todo.due_date, today)}`,
      className: late || dueToday ? "is-emphasis" : undefined,
    });
  }
  if (todo.list) metaParts.push({ key: "list", text: todo.list });
  if (todo.subtasks.length) metaParts.push({ key: "sub", text: `子任务 ${subDone}/${todo.subtasks.length}` });
  if (todo.note) metaParts.push({ key: "note", text: "有备注" });

  const renderEntry = (item: TimelineItem) => (
    <li key={item.id} className="todo-progress-item">
      <span className="todo-progress-text">{item.text}</span>
      <time
        className="todo-progress-time"
        dateTime={item.isoTime ?? undefined}
        title={item.kind === "unknown" ? undefined : item.dateTimeText}
      >
        {progressTimeLabel(item, compact)}
      </time>
    </li>
  );

  const dragProps = canReorder ? {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", todo.id);
      if (itemRef.current) {
        event.dataTransfer.setDragImage(itemRef.current, 24, 24);
      }
      onDragStart();
    },
    onDragEnd,
  } : {};

  return (
    <li
      ref={itemRef}
      className={rowClassName}
      onDragOver={event => {
        if (!canReorder) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver(pointerDropPosition(event.clientY, event.currentTarget));
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDragLeave();
        }
      }}
      onDrop={event => {
        if (!canReorder) return;
        event.preventDefault();
        onDrop(pointerDropPosition(event.clientY, event.currentTarget));
      }}
    >
      <div className={`todo-row${canReorder ? " is-draggable" : ""}`} {...dragProps}>
        {compact ? null : (
          <span className={`todo-row-day${inMyDay ? " is-today" : ""}`} title={todo.my_day || undefined}>
            {todo.my_day ? assignedDayLabel(todo.my_day, today) : ""}
          </span>
        )}
        <button
          type="button"
          className="todo-row-main"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-describedby={canReorder ? REORDER_HINT_ID : undefined}
          onKeyDown={event => {
            if (!canReorder) return;
            if (event.key === "ArrowUp") {
              event.preventDefault();
              onMoveStep(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onMoveStep(1);
            }
          }}
        >
          {showPriorityDot ? (
            <span
              className={`todo-priority-dot is-p${effectivePriority}`}
              role="img"
              title={`优先级：${PRIORITY_LABELS[effectivePriority]}`}
              aria-label={`优先级${PRIORITY_TAGS[effectivePriority]}`}
            />
          ) : null}
          <span className="todo-title-text" title={todo.title}>{todo.title}</span>
        </button>

        <div className="todo-row-actions">
          <div className="todo-status-wrap" ref={statusWrapRef}>
            <button
              ref={statusButtonRef}
              type="button"
              className={`todo-status-btn ${todo.done ? "is-done" : `is-${currentStatus}`}`}
              aria-haspopup="menu"
              aria-expanded={statusMenuOpen}
              aria-busy={savingStatus}
              disabled={savingStatus}
              aria-label={todo.done ? "任务已完成，点击可恢复未完成" : `执行状态：${TODO_STATUS_LABELS[currentStatus]}，点击切换`}
              onClick={event => {
                event.stopPropagation();
                setStatusMenuOpen(open => !open);
              }}
            >
              <span className="todo-status-dot" aria-hidden="true" />
              <span>{todo.done ? "已完成" : TODO_STATUS_LABELS[currentStatus]}</span>
            </button>
            {statusMenuOpen ? (
              <div className="todo-status-menu" role="menu" aria-label={`切换「${todo.title}」状态`}>
                {TODO_STATUSES.map(statusOption => {
                  const selected = !todo.done && statusOption === currentStatus;
                  const wasStatus = todo.done && statusOption === currentStatus;
                  return (
                    <button
                      key={statusOption}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={`todo-status-option is-${statusOption}${selected ? " is-selected" : ""}`}
                      onClick={event => {
                        event.stopPropagation();
                        selectStatus(statusOption);
                      }}
                    >
                      <span className="todo-status-dot" aria-hidden="true" />
                      <span>{TODO_STATUS_LABELS[statusOption]}</span>
                      <span className="todo-status-check" aria-hidden="true">{selected ? "✓" : wasStatus ? "原" : ""}</span>
                    </button>
                  );
                })}
                {!todo.done ? (
                  <>
                    <div className="todo-status-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      className="todo-status-option is-done"
                      onClick={event => {
                        event.stopPropagation();
                        selectStatus("done");
                      }}
                    >
                      <span className="todo-status-dot" aria-hidden="true" />
                      <span>已完成</span>
                      <span className="todo-status-check" aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`todo-add-progress${hasUnsavedDraft ? " has-draft" : ""}${writingProgress ? " is-active" : ""}`}
            ref={progressButtonRef}
            aria-label="记进度"
            title={hasUnsavedDraft ? "记进度（有未保存的草稿）" : "记进度"}
            aria-expanded={writingProgress}
            aria-controls={writingProgress ? progressFormId : undefined}
            aria-disabled={savingProgress}
            onClick={event => {
              event.stopPropagation();
              if (savingProgress) return;
              if (writingProgress) closeEditor(!draftText.trim());
              else onOpenProgress();
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" /></svg>
          </button>
        </div>
      </div>

      {metaParts.length ? (
        <p className="todo-meta">
          {metaParts.map(part => (
            <span key={part.key} className={part.className} title={part.key === "list" ? part.text : undefined}>{part.text}</span>
          ))}
        </p>
      ) : null}

      {latestEntry || writingProgress ? (
        <div className="todo-progress-thread">
          {latestEntry ? (
            <ul className="todo-progress-list" aria-label="进度记录">
              {renderEntry(latestEntry)}
            </ul>
          ) : null}
          {olderEntries.length ? (
            <>
              <button
                type="button"
                className="todo-progress-more"
                aria-expanded={showOlder}
                aria-controls={olderListId}
                onClick={() => setShowOlder(value => !value)}
              >
                <span className={`todo-caret${showOlder ? " is-open" : ""}`} aria-hidden="true">▸</span>
                {olderEntries.length} 条更早记录
              </button>
              {showOlder ? (
                <ul className="todo-progress-list is-older" id={olderListId} aria-label="更早的进度记录">
                  {olderEntries.map(renderEntry)}
                </ul>
              ) : null}
            </>
          ) : null}

          {writingProgress ? (
            <form className="todo-progress-editor" id={progressFormId} onSubmit={handleSubmitProgress}>
              <textarea
                ref={progressTextareaRef}
                rows={2}
                value={draftText}
                maxLength={TODO_PROGRESS_MAX}
                disabled={savingProgress}
                placeholder="记录新的任务进度……（Enter 保存，Shift+Enter 换行）"
                aria-label="进度内容"
                onChange={event => {
                  const nextText = event.target.value;
                  onChangeProgressDraft({ text: nextText, status: draftStatus });
                  event.currentTarget.style.height = "auto";
                  event.currentTarget.style.height = `${Math.min(160, Math.max(58, event.currentTarget.scrollHeight))}px`;
                }}
                onKeyDown={event => {
                  if (isImeComposing(event)) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeEditor(!draftText.trim());
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void saveProgress();
                  }
                }}
              />
              <div className="todo-progress-editor-foot">
                <label className="todo-progress-status-pick">
                  <span>状态</span>
                  <select
                    value={draftStatus}
                    disabled={savingProgress}
                    aria-label="进度保存时执行状态"
                    onChange={event => {
                      const raw = event.target.value;
                      onChangeProgressDraft({
                        text: draftText,
                        status: raw === "done" ? "done" : normalizeTodoStatus(raw),
                      });
                    }}
                  >
                    {TODO_STATUSES.map(statusOption => (
                      <option key={statusOption} value={statusOption}>{TODO_STATUS_LABELS[statusOption]}</option>
                    ))}
                    <option value="done">已完成</option>
                  </select>
                </label>
                <div className="todo-progress-editor-actions">
                  {draftText.trim() ? (
                    <button
                      type="button"
                      className="todo-inline-link"
                      disabled={savingProgress}
                      onClick={() => onChangeProgressDraft({ text: "", status: todo.done ? "done" : currentStatus })}
                    >
                      清空
                    </button>
                  ) : null}
                  <Button
                    type="button"
                    variant="quiet"
                    size="sm"
                    disabled={savingProgress}
                    onClick={() => closeEditor(true)}
                  >
                    取消
                  </Button>
                  <Button type="submit" size="sm" disabled={!draftText.trim() || savingProgress}>
                    {savingProgress ? "保存中…" : "保存进度"}
                  </Button>
                </div>
              </div>
              {progressError ? <p className="todo-progress-error" role="alert">{progressError}</p> : null}
            </form>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <TodoDetail todo={todo} today={today} lists={lists} onPatch={onPatch} onDelete={onDelete} />
      ) : null}
    </li>
  );
}

/** 展开的详情：标题、备注在失焦时保存；状态、优先级、日期、清单、子任务改动立即保存 */
function TodoDetail({
  todo,
  today,
  lists,
  onPatch,
  onDelete,
}: {
  todo: Todo;
  today: string;
  lists: string[];
  onPatch: (input: TodoInput, feedback?: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [list, setList] = useState(todo.list);
  const [subtask, setSubtask] = useState("");
  const listId = `todo-detail-lists-${todo.id}`;
  const currentStatus = normalizeTodoStatus(todo.status);

  const commitTitle = () => {
    const text = title.trim();
    if (!text) setTitle(todo.title);
    else if (text !== todo.title) void onPatch({ title: text });
  };
  const addSubtask = (event: FormEvent) => {
    event.preventDefault();
    const text = subtask.trim();
    if (!text || todo.subtasks.length >= TODO_SUBTASK_MAX) return;
    void onPatch({ subtasks: [...todo.subtasks, { id: newSubtaskId(), title: text, done: false }] });
    setSubtask("");
  };

  return (
    <div className="todo-detail">
      <label className="todo-field">
        <span>标题</span>
        <input
          value={title}
          maxLength={TODO_TITLE_MAX}
          onChange={event => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={event => { if (event.key === "Enter" && !isImeComposing(event)) (event.target as HTMLInputElement).blur(); }}
        />
      </label>
      <div className="todo-detail-grid">
        <label className="todo-field">
          <span>状态</span>
          <select
            value={todo.done ? "done" : currentStatus}
            onChange={event => {
              const raw = event.target.value;
              if (raw === "done") {
                if (!todo.done) void onPatch({ done: true }, "已完成待办");
                return;
              }
              const nextStatus = normalizeTodoStatus(raw);
              if (todo.done) {
                const input: TodoInput = nextStatus === currentStatus ? { done: false } : { done: false, status: nextStatus };
                void onPatch(input, `已恢复为「${TODO_STATUS_LABELS[nextStatus]}」`);
              } else if (nextStatus !== currentStatus) {
                void onPatch({ status: nextStatus }, `状态已更新为「${TODO_STATUS_LABELS[nextStatus]}」`);
              }
            }}
          >
            {TODO_STATUSES.map(statusOption => (
              <option key={statusOption} value={statusOption}>{TODO_STATUS_LABELS[statusOption]}</option>
            ))}
            <option value="done">已完成</option>
          </select>
        </label>
        <label className="todo-field">
          <span>优先级</span>
          <select value={todo.priority || 2} onChange={event => void onPatch({ priority: Number(event.target.value) as TodoPriority })}>
            {PRIORITY_OPTIONS.map(p => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
          </select>
        </label>
        <div className="todo-field">
          <label className="todo-field">
            <span>截止日期</span>
            <input type="date" value={todo.due_date} onChange={event => void onPatch({ due_date: event.target.value })} />
          </label>
          <span className="todo-date-shortcuts">
            <button type="button" onClick={() => void onPatch({ due_date: today })}>今天</button>
            <button type="button" onClick={() => void onPatch({ due_date: localDate(1) })}>明天</button>
            <button type="button" disabled={!todo.due_date} onClick={() => void onPatch({ due_date: "" })}>清除日期</button>
          </span>
        </div>
        <label className="todo-field">
          <span>清单</span>
          <input
            value={list}
            maxLength={TODO_LIST_MAX}
            list={listId}
            placeholder={UNLISTED}
            onChange={event => setList(event.target.value)}
            onBlur={() => { if (list.trim() !== todo.list) void onPatch({ list: list.trim() }); }}
          />
          <datalist id={listId}>{lists.map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <label className="todo-field todo-field-check">
          <input
            type="checkbox"
            checked={todo.my_day === today}
            onChange={event => void onPatch({ my_day: event.target.checked ? today : "" })}
          />
          <span>加入今天</span>
        </label>
      </div>

      <div className="todo-subtasks">
        <span className="todo-field-label">子任务{todo.subtasks.length ? ` · ${todo.subtasks.filter(s => s.done).length}/${todo.subtasks.length}` : ""}</span>
        {todo.subtasks.length ? (
          <ul>
            {todo.subtasks.map(sub => (
              <li key={sub.id} className={sub.done ? "is-done" : ""}>
                <input
                  type="checkbox"
                  checked={sub.done}
                  aria-label={`完成子任务「${sub.title}」`}
                  onChange={event => void onPatch({
                    subtasks: todo.subtasks.map(item => (item.id === sub.id ? { ...item, done: event.target.checked } : item)),
                  })}
                />
                <input
                  className="todo-subtask-title"
                  aria-label={`子任务标题「${sub.title}」`}
                  defaultValue={sub.title}
                  key={`${sub.id}:${sub.title}`}
                  maxLength={TODO_TITLE_MAX}
                  onBlur={event => {
                    const nextTitle = event.target.value.trim();
                    if (!nextTitle) event.target.value = sub.title;
                    else if (nextTitle !== sub.title) {
                      void onPatch({ subtasks: todo.subtasks.map(item => (item.id === sub.id ? { ...item, title: nextTitle } : item)) });
                    }
                  }}
                  onKeyDown={event => { if (event.key === "Enter" && !isImeComposing(event)) event.currentTarget.blur(); }}
                />
                <button
                  type="button"
                  className="todo-icon is-danger"
                  aria-label={`删除子任务「${sub.title}」`}
                  onClick={() => void onPatch({ subtasks: todo.subtasks.filter(item => item.id !== sub.id) })}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="todo-subtask-add" onSubmit={addSubtask}>
          <input
            disabled={todo.subtasks.length >= TODO_SUBTASK_MAX}
            value={subtask}
            maxLength={TODO_TITLE_MAX}
            onChange={event => setSubtask(event.target.value)}
            placeholder={todo.subtasks.length >= TODO_SUBTASK_MAX ? `最多 ${TODO_SUBTASK_MAX} 个子任务` : "添加子任务，回车保存"}
            aria-label="添加子任务"
          />
        </form>
      </div>

      <label className="todo-field">
        <span>备注</span>
        <textarea
          rows={3}
          value={note}
          maxLength={TODO_NOTE_MAX}
          placeholder="补充说明、链接、会议记录……"
          onChange={event => setNote(event.target.value)}
          onBlur={() => { if (note !== todo.note) void onPatch({ note }); }}
        />
      </label>
      <div className="todo-detail-foot">
        <span>
          创建于 {new Date(todo.created_at * 1000).toLocaleString("zh-CN", { hour12: false })}
          {todo.done && todo.done_at ? ` · 完成于 ${new Date(todo.done_at * 1000).toLocaleString("zh-CN", { hour12: false })}` : ""}
        </span>
        <button type="button" className="todo-detail-delete" onClick={onDelete}>删除待办</button>
      </div>
    </div>
  );
}
