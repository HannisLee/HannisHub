"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import { useShell } from "../layout/shell-context";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState } from "../ui/primitives";

type ProxyConfig = {
  enabled: boolean;
  tls_enabled: boolean;
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  username: string;
  password: string;
  public_host: string;
  public_port: number;
};

type ProxyStatus = {
  config: ProxyConfig;
  running: boolean;
  bound_port: number | null;
  started_at: string | null;
  last_error: string | null;
  tls_ready: boolean;
  tls_san: string;
  active_connections: number;
  total_connections: number;
  auth_failures: number;
  bytes_up: number;
  bytes_down: number;
};

export function ProxySettingsPanel() {
  const shell = useShell();
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  // 表单草稿状态
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [host, setHost] = useState<"127.0.0.1" | "0.0.0.0">("127.0.0.1");
  const [port, setPort] = useState("18088");
  const [username, setUsername] = useState("hannishub");
  const [password, setPassword] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [publicPort, setPublicPort] = useState("");

  const syncForm = useCallback((cfg: ProxyConfig) => {
    setTlsEnabled(Boolean(cfg.tls_enabled));
    setHost(cfg.host);
    setPort(String(cfg.port));
    setUsername(cfg.username);
    setPassword(cfg.password);
    setPublicHost(cfg.public_host || "");
    setPublicPort(cfg.public_port ? String(cfg.public_port) : "");
  }, []);

  const refreshStatus = useCallback(async (syncInputs: boolean) => {
    try {
      const data = await apiFetch<ProxyStatus>(API_PATHS.httpProxy);
      setStatus(data);
      setLoadError("");
      if (syncInputs) syncForm(data.config);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [syncForm]);

  useEffect(() => {
    if (!shell?.admin) return;
    void refreshStatus(true);
    const timer = window.setInterval(() => {
      void refreshStatus(false);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [shell?.admin, refreshStatus]);

  if (!shell?.admin) return null;

  async function toggleEnabled(nextEnabled: boolean) {
    setBusy(true);
    setSaveError("");
    setNotice("");
    try {
      const data = await apiFetch<ProxyStatus>(API_PATHS.httpProxy, {
        method: "PUT",
        body: jsonBody({ enabled: nextEnabled }),
      });
      setStatus(data);
      syncForm(data.config);
      setNotice(nextEnabled ? "代理服务已启动。" : "代理服务已停用。");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaveError("");
    setNotice("");
    const parsedPort = Number(port);
    const parsedPublicPort = publicPort.trim() === "" ? 0 : Number(publicPort);
    try {
      const data = await apiFetch<ProxyStatus>(API_PATHS.httpProxy, {
        method: "PUT",
        body: jsonBody({
          tls_enabled: tlsEnabled,
          host,
          port: Number.isFinite(parsedPort) ? parsedPort : 0,
          username: username.trim(),
          password: password.trim(),
          public_host: publicHost.trim(),
          public_port: Number.isFinite(parsedPublicPort) ? parsedPublicPort : -1,
        }),
      });
      setStatus(data);
      syncForm(data.config);
      setNotice(data.running ? "代理配置已保存并立即生效。" : "代理配置已保存。");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function rotatePassword() {
    setBusy(true);
    setSaveError("");
    setNotice("");
    try {
      const data = await apiFetch<ProxyStatus>(`${API_PATHS.httpProxy}/rotate-password`, { method: "POST" });
      setStatus(data);
      syncForm(data.config);
      setShowPassword(true);
      setNotice("已生成新的随机密码并立即生效，请同步更新浏览器插件中的密码。");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyField(label: string, value: string) {
    if (!value) return;
    const ok = await copyToClipboard(value);
    setNotice(ok ? `已复制${label}。` : `复制${label}失败，请手动选中复制。`);
  }

  const cfg = status?.config;
  const isHttpsProxy = Boolean(cfg?.tls_enabled);
  const protocolLabel = isHttpsProxy ? "HTTPS" : "HTTP";
  const effectiveHost = cfg?.public_host || "<你的 FRP 外网域名或 IP>";
  const effectivePort = cfg?.public_port ? String(cfg.public_port) : String(cfg?.port ?? 18088);
  const proxyUrl = cfg
    ? `${isHttpsProxy ? "https" : "http"}://${cfg.username}:${cfg.password}@${effectiveHost}:${effectivePort}`
    : "";

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">代理服务</h1>
          <p className="page-description">轻量 HTTP / HTTPS 正向代理（Basic 认证），配合 FRP TCP 映射可在外网让本地浏览器走本机网络出口。</p>
        </div>
      </header>

      {loading ? <LoadingState label="正在读取代理服务状态…" /> : null}
      {loadError ? <ErrorState message={loadError} /> : null}

      {status && cfg ? (
        <div className="stack-grid">
          <Card>
            <CardHeader
              title="运行状态"
              description={status.running
                ? `正在以 ${protocolLabel} 模式监听 ${cfg.host}:${status.bound_port ?? cfg.port}，启动于 ${formatDate(status.started_at)}。`
                : "当前未监听端口；开启后会立即在后台拉起代理服务，关闭后立即断开。"}
              titleActions={
                <Badge tone={status.running ? "success" : status.last_error ? "error" : "neutral"}>
                  {status.running ? `运行中 · ${protocolLabel}` : status.last_error ? "启动失败" : "已停用"}
                </Badge>
              }
              actions={
                <Button
                  type="button"
                  variant={cfg.enabled ? "secondary" : "primary"}
                  disabled={busy}
                  onClick={() => void toggleEnabled(!cfg.enabled)}
                >
                  {cfg.enabled ? "停用代理" : "启用代理"}
                </Button>
              }
            />

            {status.last_error ? (
              <p role="alert" className="card-footer-note" style={{ color: "var(--status-error, #e5534b)" }}>
                {status.last_error}
              </p>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                gap: 12,
                marginTop: 12,
              }}
            >
              <div>
                <div className="field-hint">活跃连接</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{status.active_connections}</div>
              </div>
              <div>
                <div className="field-hint">累计连接</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{status.total_connections}</div>
              </div>
              <div>
                <div className="field-hint">上行 / 下行流量</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  {formatBytes(status.bytes_up)} / {formatBytes(status.bytes_down)}
                </div>
              </div>
              <div>
                <div className="field-hint">认证失败次数</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{status.auth_failures}</div>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="服务配置"
              description="强制启用用户名与密码认证，并自动阻止代理访问本机回环地址（127.0.0.1 / localhost）。"
            />
            <form onSubmit={saveConfig} style={{ display: "grid", gap: 14 }}>
              <label className="check-choice">
                <input
                  type="checkbox"
                  role="switch"
                  checked={tlsEnabled}
                  disabled={busy}
                  onChange={event => setTlsEnabled(event.currentTarget.checked)}
                />
                启用 TLS 加密（HTTPS 代理，跨境外网推荐开启以防止明文代理被 ERR_CONNECTION_RESET 拦截）
              </label>

              {(tlsEnabled || status.tls_ready) ? (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 10,
                    padding: 12,
                    borderRadius: 8,
                    background: "var(--surface-2, rgba(255,255,255,0.03))",
                    border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))",
                  }}
                >
                  <div className="field-hint">
                    <div>自签 TLS 证书覆盖：{status.tls_san || (publicHost.trim() ? `保存后自动为 ${publicHost.trim()} 签发` : "请先填写下方外网映射地址并保存")}</div>
                    <div>首次使用 HTTPS 代理时，需在 Windows 双击安装一次根证书到「受信任的根证书颁发机构」。</div>
                  </div>
                  <a
                    href={`${API_PATHS.httpProxy}/ca-cert`}
                    download="hannishub-proxy-ca.crt"
                    className="button button-secondary button-sm"
                    style={{ textDecoration: "none" }}
                  >
                    下载根证书 (.crt)
                  </a>
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <Field label="监听地址" hint="配合本机 natfrp/FRP 隧道建议选 127.0.0.1；局域网设备直连选 0.0.0.0">
                  <select
                    value={host}
                    onChange={event => setHost(event.target.value as "127.0.0.1" | "0.0.0.0")}
                    disabled={busy}
                  >
                    <option value="127.0.0.1">仅本机 127.0.0.1（推荐）</option>
                    <option value="0.0.0.0">所有网卡 0.0.0.0（允许局域网直连）</option>
                  </select>
                </Field>
                <Field label="监听端口" hint="范围 1024–65535（避开 8081 / 18082 / 18083）">
                  <input
                    type="number"
                    min={1024}
                    max={65535}
                    value={port}
                    onChange={event => setPort(event.target.value)}
                    disabled={busy}
                    required
                  />
                </Field>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <Field label="代理用户名" hint="不能包含冒号或空格">
                  <input
                    type="text"
                    value={username}
                    onChange={event => setUsername(event.target.value)}
                    disabled={busy}
                    required
                  />
                </Field>
                <Field label="代理密码" hint="至少 8 位随机字符，外网映射请务必使用强密码">
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                      disabled={busy}
                      required
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <Button type="button" variant="secondary" size="sm" onClick={() => setShowPassword(v => !v)}>
                      {showPassword ? "隐藏" : "显示"}
                    </Button>
                  </div>
                </Field>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <Field label="外网映射地址（可选备注 / TLS 证书域名）" hint="填写 natfrp / FRP 分配的外网域名或 IP；开启 TLS 时会自动为该地址签发证书">
                  <input
                    type="text"
                    placeholder="例如 frp-cup.com"
                    value={publicHost}
                    onChange={event => setPublicHost(event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field label="外网映射端口（可选备注）" hint="填写 FRP 分配的远程端口，留空则显示本地端口">
                  <input
                    type="number"
                    min={0}
                    max={65535}
                    placeholder="例如 31675"
                    value={publicPort}
                    onChange={event => setPublicPort(event.target.value)}
                    disabled={busy}
                  />
                </Field>
              </div>

              <div className="row-actions">
                <Button type="submit" disabled={busy}>保存配置</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void rotatePassword()}>
                  重置随机密码
                </Button>
              </div>

              {saveError ? <p role="alert" className="card-footer-note" style={{ color: "var(--status-error, #e5534b)" }}>{saveError}</p> : null}
              {notice ? <p role="status" className="card-footer-note">{notice}</p> : null}
            </form>
          </Card>

          <Card>
            <CardHeader
              title="Windows 浏览器插件（ZeroOmega）配置指引"
              description="Chrome / Edge 均支持 ZeroOmega（原 SwitchyOmega 的 MV3 继任版），无需修改系统全局代理。"
            />

            <div style={{ display: "grid", gap: 14, fontSize: 14, lineHeight: 1.65 }}>
              <div>
                <strong>第 1 步：创建 FRP TCP 隧道（natfrp / SakuraFrp）</strong>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  在你的 FRP 控制台新建一条 <code>TCP</code> 隧道，本地地址填 <code>127.0.0.1</code>，本地端口填 <code>{cfg.port}</code>。
                  创建完成后，把分配的外网域名/IP 和远程端口填到上方「外网映射地址/端口」并保存。
                </p>
              </div>

              {isHttpsProxy ? (
                <div>
                  <strong>第 2 步：在 Windows 安装根证书（仅需一次）</strong>
                  <p className="field-hint" style={{ marginTop: 4 }}>
                    点击上方「下载根证书 (.crt)」得到 <code>hannishub-proxy-ca.crt</code> → 双击打开 → 点「安装证书」→ 选「当前用户」→ 选「将所有的证书都放入下列存储」→ 点「浏览」选 <strong>受信任的根证书颁发机构</strong> → 确定完成。安装后重启浏览器生效。
                  </p>
                </div>
              ) : null}

              <div>
                <strong>第 {isHttpsProxy ? 3 : 2} 步：在 ZeroOmega 新建情景模式并填入参数</strong>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  安装 <strong>ZeroOmega</strong> 后打开选项 → 点「+ 新建情景模式」→ 类型选「代理服务器」→ 代理协议选 <strong>{protocolLabel}</strong>，依次填入：
                </p>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    marginTop: 8,
                    padding: 12,
                    borderRadius: 8,
                    background: "var(--surface-2, rgba(255,255,255,0.03))",
                    border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>代理协议：<code>{protocolLabel}</code></span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>代理服务器：<code>{effectiveHost}</code></span>
                    {cfg.public_host ? (
                      <Button type="button" variant="quiet" size="sm" onClick={() => void copyField("服务器地址", cfg.public_host)}>复制</Button>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>代理端口：<code>{effectivePort}</code></span>
                    <Button type="button" variant="quiet" size="sm" onClick={() => void copyField("端口", effectivePort)}>复制</Button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>用户名（点右侧小锁图标填写）：<code>{cfg.username}</code></span>
                    <Button type="button" variant="quiet" size="sm" onClick={() => void copyField("用户名", cfg.username)}>复制</Button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>密码：<code>{showPassword ? cfg.password : "••••••••••••"}</code></span>
                    <Button type="button" variant="quiet" size="sm" onClick={() => void copyField("密码", cfg.password)}>复制</Button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingTop: 4 }}>
                    <span className="field-hint">完整代理 URI（可用于 curl / 命令行测试）</span>
                    <Button type="button" variant="secondary" size="sm" onClick={() => void copyField("代理 URI", proxyUrl)}>复制代理 URI</Button>
                  </div>
                </div>
              </div>

              <div>
                <strong>第 {isHttpsProxy ? 4 : 3} 步：应用选项并切换</strong>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  点击左侧「应用选项」保存；平时点浏览器右上角 ZeroOmega 图标即可一键切换走这台机器或恢复直连，也可以用「自动切换模式」只让指定域名走代理。
                </p>
              </div>

              <div>
                <strong>备选：若外网只通 Cloudflare Tunnel</strong>
                <p className="field-hint" style={{ marginTop: 4 }}>
                  Cloudflare Tunnel 不支持浏览器直接当正向代理使用。如果你在 CF Tunnel 里为 <code>tcp://127.0.0.1:{cfg.port}</code> 暴露了主机名，
                  可在 Windows 命令行运行 <code>cloudflared access tcp --hostname 你的域名 --url 127.0.0.1:{cfg.port}</code>，再把 ZeroOmega 的服务器填为 <code>127.0.0.1</code>、端口 <code>{cfg.port}</code> 即可。
                </p>
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
