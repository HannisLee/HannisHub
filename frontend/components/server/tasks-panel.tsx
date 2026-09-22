"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import type { Connection, RemoteTask } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

interface TaskForm {
  id: string;
  name: string;
  connection_id: string;
  execution_mode: "codex" | "terminal";
  project_dir: string;
  executor: string;
  model: string;
  reasoning_effort: string;
  prompt_source: "direct" | "file";
  prompt: string;
  prompt_file: string;
  output_file: string;
  command: string;
  log_file: string;
  schedule_type: "once" | "immediate";
  run_time: string;
  run_date: string;
  enabled: boolean;
}

function today(): string { return new Date().toISOString().slice(0, 10); }
const emptyForm: TaskForm = { id: "", name: "", connection_id: "", execution_mode: "codex", project_dir: "", executor: "codex", model: "", reasoning_effort: "high", prompt_source: "direct", prompt: "", prompt_file: "", output_file: "", command: "", log_file: "", schedule_type: "once", run_time: "09:00", run_date: today(), enabled: true };

const scheduleLabels: Record<string, string> = { immediate: "立刻发射", once: "单次", daily: "每天", weekly: "每周" };

export function TasksPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tasks, setTasks] = useState<RemoteTask[]>([]);
  const [form, setForm] = useState<TaskForm>(emptyForm);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    try { const [connectionData, taskData] = await Promise.all([apiFetch<{ connections: Connection[] }>(`${API_PATHS.server}/connections`), apiFetch<{ tasks: RemoteTask[] }>(`${API_PATHS.server}/tasks`)]); setConnections(connectionData.connections || []); setTasks(taskData.tasks || []); setError(""); } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!form.connection_id && connections[0]) setForm(current => ({ ...current, connection_id: connections[0].id })); }, [connections, form.connection_id]);

  const selectedConnection = useMemo(() => connections.find(item => item.id === form.connection_id), [connections, form.connection_id]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save");
    try { const payload = { ...form, id: form.id || undefined, command: form.execution_mode === "terminal" ? form.command : "", log_file: form.execution_mode === "terminal" ? form.log_file : form.output_file, project_dir: form.execution_mode === "codex" ? form.project_dir : "", executor: form.execution_mode === "codex" ? form.executor : "", model: form.execution_mode === "codex" ? form.model : "", reasoning_effort: form.execution_mode === "codex" ? form.reasoning_effort : "", prompt_source: form.execution_mode === "codex" ? form.prompt_source : "", prompt: form.execution_mode === "codex" && form.prompt_source === "direct" ? form.prompt : "", prompt_file: form.execution_mode === "codex" && form.prompt_source === "file" ? form.prompt_file : "", output_file: form.execution_mode === "codex" ? form.output_file : "", run_time: form.schedule_type === "immediate" ? "" : form.run_time, run_date: form.schedule_type === "immediate" ? "" : form.run_date }; await apiFetch(`${API_PATHS.server}/tasks${form.id ? `/${encodePath(form.id)}` : ""}`, { method: form.id ? "PUT" : "POST", body: jsonBody(payload) }); setMessage(form.schedule_type === "immediate" && form.enabled ? "任务已保存并立即发送" : "任务已保存"); setForm({ ...emptyForm, connection_id: form.connection_id }); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); }
  }
  async function run(task: RemoteTask) { setBusy(`run-${task.id}`); try { await apiFetch(`${API_PATHS.server}/tasks/${encodePath(task.id)}/run`, { method: "POST" }); setMessage("任务已发送到远端后台"); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); } }
  async function remove(task: RemoteTask) { if (!window.confirm(`确定删除“${task.name}”吗？`)) return; try { await apiFetch(`${API_PATHS.server}/tasks/${encodePath(task.id)}`, { method: "DELETE" }); await load(); } catch (value) { setError(errorMessage(value)); } }
  async function showLog(task: RemoteTask) { try { const data = await apiFetch<{ logs: string }>(`${API_PATHS.server}/tasks/${encodePath(task.id)}/log`); setLogs(current => ({ ...current, [task.id]: data.logs || "日志文件为空" })); } catch (value) { setLogs(current => ({ ...current, [task.id]: `读取失败：${errorMessage(value)}` })); } }
  function edit(task: RemoteTask) { setForm({ ...emptyForm, ...task, id: task.id, schedule_type: task.schedule_type === "immediate" ? "immediate" : "once", run_date: task.run_date || today(), run_time: task.run_time || "09:00", enabled: task.enabled, prompt_source: task.prompt_source === "file" ? "file" : "direct", execution_mode: task.execution_mode === "terminal" ? "terminal" : "codex" }); window.scrollTo({ top: 0, behavior: "smooth" }); }

  return <>
    <PageHeader kicker="远程服务器 / Tasks" title="远程任务" description="在目标服务器的时区中安排 Codex CLI 或完整终端命令，并从远程日志读取结果。" actions={<Button variant="secondary" size="sm" onClick={() => void load()}>刷新任务</Button>} />
    {error ? <ErrorState message={error} /> : null}{message ? <div className="inline-message">{message}</div> : null}
    <Card><CardHeader title={form.id ? "编辑远程任务" : "新建远程任务"} description="立即发射会在保存后派发；单次任务按目标服务器时间执行。" />{form.id ? <button className="form-cancel" type="button" onClick={() => setForm(emptyForm)}>取消编辑</button> : null}<form className="form-grid" onSubmit={save}><div className="form-row"><Field label="任务名称"><input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：夜间训练检查" /></Field><Field label="目标服务器"><select required value={form.connection_id} onChange={event => setForm({ ...form, connection_id: event.target.value })}><option value="">请选择服务器</option>{connections.map(item => <option value={item.id} key={item.id}>{item.name} · {item.host}</option>)}</select></Field></div><Field label="执行方式"><select value={form.execution_mode} onChange={event => setForm({ ...form, execution_mode: event.target.value as TaskForm["execution_mode"] })}><option value="codex">Codex CLI 参数化</option><option value="terminal">完整终端命令</option></select></Field>{form.execution_mode === "codex" ? <><div className="form-row"><Field label="项目目录"><input required value={form.project_dir} onChange={event => setForm({ ...form, project_dir: event.target.value })} /></Field><Field label="执行端"><select value={form.executor} onChange={event => setForm({ ...form, executor: event.target.value })}><option value="codex">codex</option><option value="codexc">codexc</option></select></Field></div><div className="form-row"><Field label="模型"><input required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} /></Field><Field label="推理强度"><select value={form.reasoning_effort} onChange={event => setForm({ ...form, reasoning_effort: event.target.value })}><option value="xhigh">xhigh</option><option value="max">max</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option><option value="minimal">minimal</option></select></Field></div><Field label="提示词来源"><select value={form.prompt_source} onChange={event => setForm({ ...form, prompt_source: event.target.value as TaskForm["prompt_source"] })}><option value="direct">直接输入</option><option value="file">文件路径</option></select></Field>{form.prompt_source === "direct" ? <Field label="提示词"><textarea required rows={5} value={form.prompt} onChange={event => setForm({ ...form, prompt: event.target.value })} /></Field> : <Field label="提示词文件路径"><input required value={form.prompt_file} onChange={event => setForm({ ...form, prompt_file: event.target.value })} /></Field>}<Field label="输出日志路径" hint={selectedConnection ? `目标服务器时区：${selectedConnection.timezone || "测试后自动读取"}` : undefined}><input required value={form.output_file} onChange={event => setForm({ ...form, output_file: event.target.value })} /></Field></> : <><Field label="完整终端命令"><textarea required rows={7} value={form.command} onChange={event => setForm({ ...form, command: event.target.value })} placeholder="cd /opt/app && ./backup.sh" /></Field><Field label="远程日志文件路径" hint="可留空；填写后可在任务列表读取末尾 100 行"><input value={form.log_file} onChange={event => setForm({ ...form, log_file: event.target.value })} /></Field></>}<div className="form-row"><Field label="执行周期"><select value={form.schedule_type} onChange={event => setForm({ ...form, schedule_type: event.target.value as TaskForm["schedule_type"] })}><option value="once">单次</option><option value="immediate">立刻发射</option></select></Field>{form.schedule_type === "once" ? <Field label="执行时间（服务器时区）"><input type="time" required value={form.run_time} onChange={event => setForm({ ...form, run_time: event.target.value })} /></Field> : <div />}</div>{form.schedule_type === "once" ? <Field label="执行日期（服务器时区）"><input type="date" required value={form.run_date} onChange={event => setForm({ ...form, run_date: event.target.value })} /></Field> : null}<label className="check-choice"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />创建后启用任务</label><div className="form-actions"><Button type="submit" disabled={busy === "save"}>{busy === "save" ? "保存中…" : "保存任务"}</Button></div></form></Card>
    <Card><CardHeader title={`任务列表 · ${tasks.length}`} description="调度器每 15 秒检查一次。" />{loading ? <LoadingState /> : tasks.length ? <div className="stack-list">{tasks.map(task => <article className="task-row" key={task.id}><div className="task-main"><div className="task-title"><strong>{task.name}</strong><Badge tone={task.running ? "warning" : task.last_status === "success" ? "success" : task.last_status === "error" ? "error" : "neutral"}>{task.running ? "执行中" : task.enabled ? scheduleLabels[task.schedule_type] || task.schedule_type : "已停用"}</Badge></div><span>{task.connection_name || task.connection_id} · {task.timezone || "UTC"} · {task.execution_mode === "codex" ? `${task.executor || "codex"} / ${task.model || ""}` : "完整终端命令"}</span><code>{task.command}</code><small className="muted-line">下次：{formatDate(task.next_run_at)} · 上次：{formatDate(task.last_run_at)}</small>{task.last_message ? <small className="muted-line">{task.last_message}</small> : null}{logs[task.id] !== undefined ? <pre className="text-preview">{logs[task.id]}</pre> : null}</div><div className="row-actions"><Button size="sm" onClick={() => void run(task)} disabled={task.running || busy === `run-${task.id}`}>立即发送</Button><Button size="sm" variant="quiet" onClick={() => void showLog(task)} disabled={!task.log_file}>读取日志</Button><Button size="sm" variant="quiet" onClick={() => edit(task)} disabled={Boolean(task.running)}>编辑</Button><Button size="sm" variant="danger" onClick={() => void remove(task)} disabled={Boolean(task.running)}>删除</Button></div></article>)}</div> : <EmptyState title="还没有远程任务" detail="创建一个 Codex 或终端任务开始使用调度器。" />}</Card>
  </>;
}
