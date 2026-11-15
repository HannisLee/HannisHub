"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { FileConnection } from "../../lib/types";
import { Icon } from "../ui/icon";
import { Badge, Button } from "../ui/primitives";

interface ConnectionForm {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "key" | "password";
  password: string;
  private_key_path: string;
}

const emptyForm: ConnectionForm = {
  name: "",
  host: "",
  port: 22,
  username: "",
  auth_type: "key",
  password: "",
  private_key_path: "",
};

interface FileConnectionBarProps {
  connections: FileConnection[];
  activeConnectionId: string;
  onSelectConnection: (id: string) => void;
  commonDirectories: string[];
  onSelectCommonDirectory?: (directory: string) => void;
  onRefreshConnections: () => Promise<void>;
  onSaveCommonDirectories?: (directories: string[]) => Promise<void>;
}

export function FileConnectionBar({
  connections,
  activeConnectionId,
  onSelectConnection,
  commonDirectories,
  onSelectCommonDirectory,
  onRefreshConnections,
  onSaveCommonDirectories,
}: FileConnectionBarProps) {
  const [commonOpen, setCommonOpen] = useState(false);
  const [editingCommon, setEditingCommon] = useState(false);
  const [commonText, setCommonText] = useState("");
  const [commonSaving, setCommonSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");

  const [manageOpen, setManageOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [manageMessage, setManageMessage] = useState("");
  const [manageError, setManageError] = useState("");

  const commonRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭常用目录下拉
  useEffect(() => {
    if (!commonOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (commonRef.current && !commonRef.current.contains(event.target as Node)) {
        setCommonOpen(false);
        setEditingCommon(false);
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [commonOpen]);

  function startEditCommon() {
    setCommonText(commonDirectories.map(dir => (dir ? `~/${dir}` : "~")).join("\n"));
    setEditingCommon(true);
  }

  async function handleSaveCommon() {
    if (!onSaveCommonDirectories) return;
    setCommonSaving(true);
    try {
      const dirs = commonText
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean);
      await onSaveCommonDirectories(dirs);
      setEditingCommon(false);
      setCommonOpen(false);
    } catch {
      // 错误由外部处理
    } finally {
      setCommonSaving(false);
    }
  }

  async function handleCreateConnection(event: FormEvent) {
    event.preventDefault();
    setCreateSaving(true);
    setCreateError("");
    try {
      const res = await apiFetch<{ ok: boolean; connection: { id: string } }>(`${API_PATHS.server}/connections`, {
        method: "POST",
        body: jsonBody({
          name: form.name.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim(),
          auth_type: form.auth_type,
          password: form.password,
          private_key_path: form.private_key_path.trim(),
        }),
      });
      setForm(emptyForm);
      setCreateOpen(false);
      await onRefreshConnections();
      if (res.connection?.id) {
        onSelectConnection(res.connection.id);
      }
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreateSaving(false);
    }
  }

  async function handleTestConnection(id: string) {
    setBusyAction(`test-${id}`);
    setManageMessage("");
    setManageError("");
    try {
      const data = await apiFetch<{ connection: { name: string }; time: { server_time: string; timezone: string } }>(
        `${API_PATHS.server}/connections/${encodePath(id)}/test`,
        { method: "POST" }
      );
      setManageMessage(`${data.connection.name}：连接成功，时间 ${data.time.server_time}（${data.time.timezone}）`);
      await onRefreshConnections();
    } catch (err) {
      setManageError(errorMessage(err));
    } finally {
      setBusyAction("");
    }
  }

  async function handleDeleteConnection(id: string, name: string) {
    if (!window.confirm(`确定要删除连接「${name}」吗？`)) return;
    setBusyAction(`del-${id}`);
    setManageMessage("");
    setManageError("");
    try {
      await apiFetch(`${API_PATHS.server}/connections/${encodePath(id)}`, { method: "DELETE" });
      setManageMessage(`已删除连接「${name}」`);
      if (activeConnectionId === id) {
        onSelectConnection("local");
      }
      await onRefreshConnections();
    } catch (err) {
      setManageError(errorMessage(err));
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div className="file-conn-bar">
      <div className="file-conn-list" role="tablist" aria-label="文件服务器连接">
        {connections.map(conn => {
          const isActive = conn.id === activeConnectionId;
          const isLocal = conn.id === "local";
          return (
            <button
              key={conn.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`file-conn-chip${isActive ? " is-active" : ""}${isLocal ? " is-local" : ""}`}
              onClick={() => onSelectConnection(conn.id)}
              title={isLocal ? "本机目录浏览" : `${conn.name} (${conn.username}@${conn.host}:${conn.port || 22})`}
            >
              <span className={`file-conn-dot${isActive ? " is-active" : ""}`} />
              <span className="file-conn-chip-label">{conn.name}</span>
              {!isLocal && conn.last_test_ok === false ? (
                <span className="file-conn-chip-warn" title="上次测试失败">!</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="file-conn-actions">
        {/* 常用目录下拉 */}
        <div className="file-conn-dropdown-wrap" ref={commonRef}>
          <button
            type="button"
            className={`file-conn-action-btn${commonOpen ? " is-open" : ""}`}
            onClick={() => {
              setCommonOpen(!commonOpen);
              setEditingCommon(false);
            }}
            title="常用目录"
          >
            <Icon name="files" style={{ width: 13, height: 13 }} />
            <span>常用目录</span>
            <Icon name="chevronDown" style={{ width: 10, height: 10 }} />
          </button>

          {commonOpen ? (
            <div className="file-conn-dropdown-menu">
              <div className="file-conn-dropdown-head">
                <strong>常用目录</strong>
                <Button
                  variant="quiet"
                  size="sm"
                  type="button"
                  onClick={() => (editingCommon ? setEditingCommon(false) : startEditCommon())}
                >
                  {editingCommon ? "查看列表" : "编辑目录"}
                </Button>
              </div>

              {editingCommon ? (
                <div className="file-conn-dropdown-edit">
                  <p className="file-conn-dropdown-hint">每行一个目录（如 <code>~/reproduce</code> 或相对路径）：</p>
                  <textarea
                    rows={6}
                    value={commonText}
                    onChange={e => setCommonText(e.target.value)}
                    placeholder={"~\n~/reproduce\n~/code"}
                    className="file-conn-textarea"
                  />
                  <div className="file-conn-dropdown-foot">
                    <Button variant="quiet" size="sm" onClick={() => setEditingCommon(false)}>
                      取消
                    </Button>
                    <Button size="sm" onClick={() => void handleSaveCommon()} disabled={commonSaving}>
                      {commonSaving ? "保存中…" : "保存"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="file-conn-dropdown-items">
                  {commonDirectories.length ? (
                    commonDirectories.map((dir, idx) => {
                      const display = dir ? `~/${dir}` : "~ (用户根目录)";
                      return (
                        <button
                          key={idx}
                          type="button"
                          className="file-conn-dropdown-item"
                          onClick={() => {
                            setCommonOpen(false);
                            onSelectCommonDirectory?.(dir);
                          }}
                        >
                          <span className="file-conn-item-icon">📁</span>
                          <span className="file-conn-item-text">{display}</span>
                        </button>
                      );
                    })
                  ) : (
                    <div className="file-conn-dropdown-empty">
                      <span>暂未添加常用目录。</span>
                      <Button variant="quiet" size="sm" onClick={startEditCommon}>
                        点击添加
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* 新建连接 */}
        <button
          type="button"
          className="file-conn-action-btn is-highlight"
          onClick={() => {
            setForm(emptyForm);
            setCreateError("");
            setCreateOpen(true);
          }}
          title="新建 SSH 服务器连接"
        >
          <Icon name="plus" style={{ width: 12, height: 12 }} />
          <span>新建连接</span>
        </button>

        {/* 管理连接 */}
        <button
          type="button"
          className="file-conn-action-btn"
          onClick={() => {
            setManageMessage("");
            setManageError("");
            setManageOpen(true);
          }}
          title="管理已保存连接"
        >
          <span>管理</span>
        </button>
      </div>

      {/* 新建连接弹窗 */}
      {createOpen ? (
        <div className="file-conn-modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="file-conn-modal" onClick={e => e.stopPropagation()}>
            <div className="file-conn-modal-head">
              <div>
                <p className="file-conn-modal-kicker">SSH Connection</p>
                <h3>新建集群服务器连接</h3>
              </div>
              <button
                type="button"
                className="file-conn-modal-close"
                onClick={() => setCreateOpen(false)}
                aria-label="关闭"
              >
                <Icon name="close" style={{ width: 14, height: 14 }} />
              </button>
            </div>

            <form onSubmit={handleCreateConnection} className="file-conn-form">
              <label className="field">
                <span className="field-label">连接显示名称</span>
                <input
                  required
                  autoFocus
                  placeholder="如：38-ushas 或 节点-A"
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
              </label>

              <div className="file-conn-form-row">
                <label className="field" style={{ flex: "1 1 200px" }}>
                  <span className="field-label">服务器 IP / 主机名</span>
                  <input
                    required
                    placeholder="如 10.10.2.38"
                    value={form.host}
                    onChange={e => setForm({ ...form, host: e.target.value })}
                  />
                </label>
                <label className="field" style={{ flex: "0 0 80px" }}>
                  <span className="field-label">端口</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={e => setForm({ ...form, port: Number(e.target.value) || 22 })}
                  />
                </label>
              </div>

              <label className="field">
                <span className="field-label">登录用户名</span>
                <input
                  required
                  placeholder="集群账号，如 han.li"
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value })}
                />
              </label>

              <label className="field">
                <span className="field-label">认证方式</span>
                <select
                  value={form.auth_type}
                  onChange={e => setForm({ ...form, auth_type: e.target.value as "key" | "password" })}
                >
                  <option value="key">私钥免密认证 (默认)</option>
                  <option value="password">密码认证</option>
                </select>
              </label>

              {form.auth_type === "password" ? (
                <label className="field">
                  <span className="field-label">SSH 登录密码</span>
                  <input
                    type="password"
                    required
                    placeholder="输入服务器密码"
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                  />
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">私钥文件路径（可选）</span>
                  <input
                    placeholder="留空则自动匹配系统或管理私钥，如 ~/.ssh/id_ed25519"
                    value={form.private_key_path}
                    onChange={e => setForm({ ...form, private_key_path: e.target.value })}
                  />
                </label>
              )}

              {createError ? <p className="file-conn-form-error">{createError}</p> : null}

              <div className="file-conn-modal-actions">
                <Button variant="quiet" type="button" onClick={() => setCreateOpen(false)}>
                  取消
                </Button>
                <Button type="submit" disabled={createSaving}>
                  {createSaving ? "连接测试并保存中…" : "保存并连接"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* 管理连接弹窗 */}
      {manageOpen ? (
        <div className="file-conn-modal-backdrop" onClick={() => setManageOpen(false)}>
          <div className="file-conn-modal is-wide" onClick={e => e.stopPropagation()}>
            <div className="file-conn-modal-head">
              <div>
                <p className="file-conn-modal-kicker">Connections Manager</p>
                <h3>管理已保存的服务器连接</h3>
              </div>
              <button
                type="button"
                className="file-conn-modal-close"
                onClick={() => setManageOpen(false)}
                aria-label="关闭"
              >
                <Icon name="close" style={{ width: 14, height: 14 }} />
              </button>
            </div>

            {manageMessage ? <div className="inline-message">{manageMessage}</div> : null}
            {manageError ? <div className="inline-message error-text">{manageError}</div> : null}

            <div className="file-conn-manage-list">
              {connections.filter(c => c.id !== "local").length ? (
                connections
                  .filter(c => c.id !== "local")
                  .map(conn => (
                    <div key={conn.id} className="file-conn-manage-item">
                      <div className="file-conn-manage-info">
                        <div className="file-conn-manage-title">
                          <strong>{conn.name}</strong>
                          {conn.last_test_ok === true ? (
                            <Badge tone="success">已连接</Badge>
                          ) : conn.last_test_ok === false ? (
                            <Badge tone="error">连接失败</Badge>
                          ) : (
                            <Badge>未测试</Badge>
                          )}
                        </div>
                        <code>
                          {conn.username}@{conn.host}:{conn.port || 22}
                        </code>
                      </div>
                      <div className="file-conn-manage-actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyAction === `test-${conn.id}`}
                          onClick={() => void handleTestConnection(conn.id)}
                        >
                          {busyAction === `test-${conn.id}` ? "测试中…" : "测试"}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busyAction === `del-${conn.id}`}
                          onClick={() => void handleDeleteConnection(conn.id, conn.name)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  ))
              ) : (
                <p className="file-conn-dropdown-empty">暂无远程 SSH 连接，可点击上方「+ 新建连接」添加。</p>
              )}
            </div>

            <div className="file-conn-modal-actions">
              <Button variant="quiet" onClick={() => setManageOpen(false)}>
                关闭
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
