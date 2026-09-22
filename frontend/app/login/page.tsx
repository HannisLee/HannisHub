"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiFetch } from "../../lib/api";

interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  username?: string | null;
}

interface AuthResponse {
  ok: boolean;
  username: string;
}

function nextPath(): string {
  const value = new URLSearchParams(window.location.search).get("next");
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<AuthStatus>("/api/auth/status")
      .then(value => {
        setStatus(value);
        if (value.authenticated) router.replace(nextPath());
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : "无法读取登录状态"));
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!status) return;
    if (!status.configured && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      await apiFetch<AuthResponse>(status.configured ? "/api/auth/login" : "/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      router.replace(nextPath());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试");
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-lockup login-brand">
          <Link href="/" className="brand-mark" aria-label="返回 HannisHub 首页">HH</Link>
          <div><strong>HannisHub</strong><span>本地管理工作台</span></div>
        </div>
        <p className="eyebrow">Private workspace</p>
        <h1 id="login-title">{status?.configured ? "欢迎回来" : "初始化管理员账号"}</h1>
        <p className="login-description">{status?.configured ? "登录后管理本机模型、GPU、远程服务器与提示词。" : "第一次使用时创建一个本地管理员账号。"}</p>
        {error ? <div className="error-state" role="alert"><strong>无法继续</strong><span>{error}</span></div> : null}
        {!status && !error ? <div className="login-loading"><span className="loading-line" />正在检查工作区…</div> : null}
        {status ? <form className="form-grid login-form" onSubmit={submit}>
          <label className="field"><span className="field-label">用户名</span><input required minLength={3} maxLength={64} value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label>
          <label className="field"><span className="field-label">密码</span><input required minLength={8} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={status.configured ? "current-password" : "new-password"} /></label>
          {!status.configured ? <label className="field"><span className="field-label">确认密码</span><input required minLength={8} type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label> : null}
          <button className="button button-primary button-lg" type="submit" disabled={busy}>{busy ? "处理中…" : status.configured ? "登录 HannisHub" : "创建管理员账号"}</button>
        </form> : null}
        <p className="login-footer">服务地址：FastAPI · 8081</p>
      </section>
    </main>
  );
}
