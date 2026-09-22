"use client";

import { useEffect, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import type { Connection } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

interface ConnectionForm {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password: string;
  private_key_path: string;
  timezone: string;
}

const emptyForm: ConnectionForm = { id: "", name: "", host: "", port: 22, username: "", auth_type: "password", password: "", private_key_path: "", timezone: "" };

const authLabels: Record<string, string> = { password: "密码", key: "私钥", agent: "SSH Agent" };

function connectionToForm(item: Connection): ConnectionForm {
  return {
    id: item.id,
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    auth_type: item.auth_type,
    password: "",
    private_key_path: item.private_key_path || "",
    timezone: item.timezone || "",
  };
}

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    try { const data = await apiFetch<{ connections: Connection[] }>(`${API_PATHS.server}/connections`); setConnections(data.connections || []); setError(""); } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("save");
    try { await apiFetch(`${API_PATHS.server}/connections${form.id ? `/${encodePath(form.id)}` : ""}`, { method: form.id ? "PUT" : "POST", body: jsonBody({ ...form, id: form.id || undefined }) }); setMessage("服务器连接已保存"); setForm(emptyForm); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); }
  }
  async function test(id: string) { setBusy(`test-${id}`); try { const data = await apiFetch<{ connection: Connection; time: { server_time: string; timezone: string } }>(`${API_PATHS.server}/connections/${encodePath(id)}/test`, { method: "POST" }); setMessage(`${data.connection.name}：${data.time.server_time}（${data.time.timezone}）`); await load(); } catch (value) { setError(errorMessage(value)); await load(); } finally { setBusy(""); } }
  async function readTime(id: string) { setBusy(`time-${id}`); try { const data = await apiFetch<{ time: { server_time: string; timezone: string } }>(`${API_PATHS.server}/connections/${encodePath(id)}/time`); setMessage(`远端时间：${data.time.server_time}（${data.time.timezone}）`); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); } }
  async function installKey(item: Connection) { if (!window.confirm(`将使用“${item.name}”当前保存的密码安装公钥，继续吗？`)) return; setBusy(`key-${item.id}`); try { await apiFetch(`${API_PATHS.server}/connections/${encodePath(item.id)}/install-key`, { method: "POST" }); setMessage("公钥已安装，连接已切换为免密"); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); } }
  async function remove(item: Connection) { if (!window.confirm(`确定删除“${item.name}”吗？`)) return; setBusy(`delete-${item.id}`); try { await apiFetch(`${API_PATHS.server}/connections/${encodePath(item.id)}`, { method: "DELETE" }); setMessage("服务器连接已删除"); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); } }

  return <>
    <PageHeader kicker="远程服务器 / Connections" title="服务器连接" description="保存可信的 SSH 入口，读取远端时间，并为远程任务提供目标服务器。" actions={<Button variant="secondary" size="sm" onClick={() => void load()}>刷新</Button>} />
    {error ? <ErrorState message={error} /> : null}{message ? <div className="inline-message">{message}</div> : null}
    <div className="two-column-grid">
      <Card><CardHeader title={form.id ? "编辑连接" : "添加服务器连接"} description="密码、私钥和 SSH Agent 三种认证方式均可使用。" />{form.id ? <button className="form-cancel" type="button" onClick={() => setForm(emptyForm)}>取消编辑</button> : null}<form className="form-grid" onSubmit={save}><Field label="名称"><input required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：生产 GPU 服务器" /></Field><div className="form-row"><Field label="地址 / 主机名"><input required value={form.host} onChange={event => setForm({ ...form, host: event.target.value })} placeholder="10.10.2.X" /></Field><Field label="SSH 端口"><input type="number" min="1" max="65535" value={form.port} onChange={event => setForm({ ...form, port: Number(event.target.value) })} /></Field></div><Field label="用户名"><input required value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} /></Field><Field label="认证方式"><select value={form.auth_type} onChange={event => setForm({ ...form, auth_type: event.target.value })}><option value="password">密码</option><option value="key">私钥文件</option><option value="agent">SSH Agent</option></select></Field>{form.auth_type === "password" ? <Field label="密码" hint={form.id ? "编辑时留空表示保持不变" : undefined}><input type="password" autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></Field> : null}{form.auth_type === "key" ? <Field label="私钥路径" hint="可留空使用默认私钥"><input value={form.private_key_path} onChange={event => setForm({ ...form, private_key_path: event.target.value })} placeholder="~/.ssh/id_ed25519" /></Field> : null}<Field label="服务器时区" hint="留空则测试连接时自动读取"><input value={form.timezone} onChange={event => setForm({ ...form, timezone: event.target.value })} placeholder="Asia/Tokyo" /></Field><div className="form-actions"><Button type="submit" disabled={busy === "save"}>{busy === "save" ? "保存中…" : "保存连接"}</Button></div></form></Card>
      <Card><CardHeader title={`已保存连接 · ${connections.length}`} description="测试成功后会缓存远端时间和时区。" />{loading ? <LoadingState /> : connections.length ? <div className="stack-list">{connections.map(item => <article className="connection-row" key={item.id}><div className="connection-main"><div className="connection-title"><strong>{item.name}</strong>{item.last_test_ok === true ? <Badge tone="success">已连接</Badge> : item.last_test_ok === false ? <Badge tone="error">测试失败</Badge> : <Badge>未测试</Badge>}</div><code>{item.username}@{item.host}:{item.port}</code><span>{item.server_time || "尚未读取远端时间"} · {item.timezone || "UTC"} · {authLabels[item.auth_type] || item.auth_type}</span>{item.last_test_message ? <small className="error-text">{item.last_test_message}</small> : null}</div><div className="row-actions"><Button size="sm" variant="secondary" onClick={() => void test(item.id)} disabled={busy === `test-${item.id}`}>测试</Button><Button size="sm" variant="quiet" onClick={() => void readTime(item.id)} disabled={busy === `time-${item.id}`}>读取时间</Button>{item.auth_type === "password" && !item.key_installed ? <Button size="sm" variant="quiet" onClick={() => void installKey(item)} disabled={busy === `key-${item.id}`}>添加公钥</Button> : item.key_installed ? <Badge tone="success">公钥免密</Badge> : null}<Button size="sm" variant="quiet" onClick={() => setForm(connectionToForm(item))}>编辑</Button><Button size="sm" variant="danger" onClick={() => void remove(item)}>删除</Button></div><small className="muted-line">最后测试：{formatDate(item.last_test_at)}</small></article>)}</div> : <EmptyState title="还没有服务器连接" detail="添加第一个 SSH 入口后，远程任务可以使用它。" />}</Card>
    </div>
  </>;
}
