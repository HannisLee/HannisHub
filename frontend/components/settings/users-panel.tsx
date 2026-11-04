"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import type { HubUser } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState } from "../ui/primitives";

const MIN_PASSWORD = 8;

/** 用户管理：所有用户权限相同，可新增用户、重置他人密码、删除用户与修改自己的密码 */
export function UsersPanel() {
  const [users, setUsers] = useState<HubUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [newUser, setNewUser] = useState({ username: "", password: "" });
  const [resetTarget, setResetTarget] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [deleteTarget, setDeleteTarget] = useState("");
  const [ownPassword, setOwnPassword] = useState({ current: "", next: "", confirm: "" });

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ users: HubUser[] }>(API_PATHS.users);
      setUsers(data.users);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 在异步回调中加载，避免在 effect 体内同步 setState
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(key: string, action: () => Promise<void>, success: string) {
    setBusy(key);
    setNotice("");
    try {
      await action();
      setNotice(success);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy("");
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    const username = newUser.username.trim();
    await run("create", async () => {
      await apiFetch(API_PATHS.users, { method: "POST", body: jsonBody({ username, password: newUser.password }) });
      setNewUser({ username: "", password: "" });
      await load();
    }, `已添加用户 ${username}`);
  }

  async function submitReset(username: string) {
    await run(`reset-${username}`, async () => {
      await apiFetch(`${API_PATHS.users}/${encodePath(username)}/password`, { method: "POST", body: jsonBody({ password: resetPassword }) });
      setResetTarget("");
      setResetPassword("");
    }, `已重置 ${username} 的密码，该用户需要重新登录`);
  }

  async function submitDelete(username: string) {
    await run(`delete-${username}`, async () => {
      await apiFetch(`${API_PATHS.users}/${encodePath(username)}`, { method: "DELETE" });
      setDeleteTarget("");
      await load();
    }, `已删除用户 ${username}`);
  }

  async function changeOwnPassword(event: FormEvent) {
    event.preventDefault();
    if (ownPassword.next !== ownPassword.confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    await run("own", async () => {
      await apiFetch("/api/auth/password", {
        method: "POST",
        body: jsonBody({ current_password: ownPassword.current, new_password: ownPassword.next }),
      });
      setOwnPassword({ current: "", next: "", confirm: "" });
    }, "密码已修改，其他设备上的登录已失效");
  }

  return (
    <div className="stack-grid">
      {error ? <ErrorState message={error} /> : null}
      {notice ? <p className="inline-message">{notice}</p> : null}

      <Card>
        <CardHeader title={`用户 · ${users.length}`} description="所有用户权限相同，都可以访问全部功能并管理其他用户。重置密码或删除后，该用户已有的登录会立即失效。" />
        {loading ? <LoadingState /> : (
          <div className="stack-list">
            {users.map(user => (
              <article className="user-row" key={user.username}>
                <div className="user-row-main">
                  <div className="connection-title">
                    <strong>{user.username}</strong>
                    {user.is_self ? <Badge tone="info">当前账号</Badge> : null}
                  </div>
                  <span className="muted-line">创建于 {formatDate(user.created_at)}</span>
                </div>
                <div className="row-actions">
                  {resetTarget === user.username ? (
                    <form className="inline-form" onSubmit={event => { event.preventDefault(); void submitReset(user.username); }}>
                      <input
                        type="password"
                        autoComplete="new-password"
                        placeholder={`新密码（至少 ${MIN_PASSWORD} 位）`}
                        value={resetPassword}
                        onChange={event => setResetPassword(event.target.value)}
                        minLength={MIN_PASSWORD}
                        required
                        autoFocus
                      />
                      <Button size="sm" type="submit" disabled={busy === `reset-${user.username}`}>确认重置</Button>
                      <Button size="sm" variant="quiet" type="button" onClick={() => { setResetTarget(""); setResetPassword(""); }}>取消</Button>
                    </form>
                  ) : deleteTarget === user.username ? (
                    <>
                      <span className="muted-line">确认删除 {user.username}？</span>
                      <Button size="sm" variant="danger" onClick={() => void submitDelete(user.username)} disabled={busy === `delete-${user.username}`}>删除</Button>
                      <Button size="sm" variant="quiet" onClick={() => setDeleteTarget("")}>取消</Button>
                    </>
                  ) : user.is_self ? (
                    <span className="muted-line">在右侧修改自己的密码</span>
                  ) : (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => { setResetTarget(user.username); setResetPassword(""); setDeleteTarget(""); }}>重置密码</Button>
                      <Button size="sm" variant="quiet" onClick={() => { setDeleteTarget(user.username); setResetTarget(""); }}>删除</Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>

      <div className="two-column-grid">
        <Card>
          <CardHeader title="添加用户" description={`用户名 3-64 位且不含空格，密码至少 ${MIN_PASSWORD} 位。`} />
          <form className="stack-form" onSubmit={event => void createUser(event)}>
            <Field label="用户名">
              <input value={newUser.username} onChange={event => setNewUser({ ...newUser, username: event.target.value })} autoComplete="off" minLength={3} maxLength={64} required />
            </Field>
            <Field label="初始密码">
              <input type="password" autoComplete="new-password" value={newUser.password} onChange={event => setNewUser({ ...newUser, password: event.target.value })} minLength={MIN_PASSWORD} required />
            </Field>
            <div className="form-actions">
              <Button type="submit" disabled={busy === "create"}>{busy === "create" ? "添加中…" : "添加用户"}</Button>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title="修改我的密码" description="修改后当前页面保持登录，其他设备需要用新密码重新登录。" />
          <form className="stack-form" onSubmit={event => void changeOwnPassword(event)}>
            <Field label="当前密码">
              <input type="password" autoComplete="current-password" value={ownPassword.current} onChange={event => setOwnPassword({ ...ownPassword, current: event.target.value })} required />
            </Field>
            <Field label="新密码">
              <input type="password" autoComplete="new-password" value={ownPassword.next} onChange={event => setOwnPassword({ ...ownPassword, next: event.target.value })} minLength={MIN_PASSWORD} required />
            </Field>
            <Field label="确认新密码">
              <input type="password" autoComplete="new-password" value={ownPassword.confirm} onChange={event => setOwnPassword({ ...ownPassword, confirm: event.target.value })} minLength={MIN_PASSWORD} required />
            </Field>
            <div className="form-actions">
              <Button type="submit" disabled={busy === "own"}>{busy === "own" ? "保存中…" : "修改密码"}</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
