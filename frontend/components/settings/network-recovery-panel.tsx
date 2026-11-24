"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { Button, Card, CardHeader } from "../ui/primitives";

type NetworkAction = { at: string; result: string; reason: string };
type NetworkRecovery = {
  enabled: boolean;
  monitor: {
    interface: string;
    authorized: boolean;
    checked_at: string;
    status: string;
    connectivity: string;
    address: string | null;
    gateway: string | null;
    outage_seconds: number;
    last_reconnect: NetworkAction | null;
    last_reboot: NetworkAction | null;
  } | null;
};

const localStatus: Record<string, string> = {
  online: "本地网络正常",
  no_carrier: "网卡无物理链路",
  missing_ipv4: "未获得 IPv4 地址",
  missing_route: "缺少默认路由",
  gateway_unreachable: "无法到达网关",
  unknown: "未能确认本地网络状态",
};

const externalStatus: Record<string, string> = {
  full: "外网正常",
  limited: "外网访问受限",
  portal: "外网需要认证",
  none: "外网不可用",
};

const actionResult: Record<string, string> = {
  requested: "已请求",
  success: "成功",
  failed: "执行失败",
  still_offline: "重连后仍未恢复",
};

function actionLabel(action: NetworkAction | null) {
  if (!action) return "无记录";
  const result = actionResult[action.result] ?? action.result;
  const reason = localStatus[action.reason];
  return `${new Date(action.at).toLocaleString()} · ${result}${reason ? ` · ${reason}` : ""}`;
}

export function NetworkRecoveryPanel() {
  const [state, setState] = useState<NetworkRecovery | null>(null);
  const [refreshing, setRefreshing] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    // 取消旧的轮询请求，避免其响应覆盖刚保存的设置。
    if (busy) return;
    async function refresh() {
      try {
        const result = await apiFetch<NetworkRecovery>(API_PATHS.networkRecovery, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setState(result);
          setRefreshing(Date.now());
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "读取设置失败");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [busy]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setSaveError("");
    try {
      setState(await apiFetch<NetworkRecovery>(API_PATHS.networkRecovery, {
        method: "PUT",
        body: jsonBody({ enabled }),
      }));
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存设置失败");
    } finally {
      setBusy(false);
    }
  }

  const monitor = state?.monitor;
  const stale = monitor && refreshing - Date.parse(monitor.checked_at) > 180_000;
  const recovering = monitor && monitor.authorized && state?.enabled && !stale;
  const outageMinutes = Math.floor((monitor?.outage_seconds ?? 0) / 60);

  return (
    <Card>
      <CardHeader title="本机网络恢复" description="持续断网 5 分钟后尝试重连网卡。确认本机持续断网满 5 小时后自动重启整台机器。" />
      {!state && !error && <p className="card-footer-note">正在读取巡检状态…</p>}
      {state && (
        <>
          <p role="status" className="card-footer-note">
            {recovering ? "自动恢复已启用" : stale ? "巡检状态已超过 3 分钟未更新" : !monitor ? "巡检尚未运行" : !monitor.authorized ? "巡检已运行，等待系统管理员授权" : "自动恢复已暂停"}
          </p>
          {monitor && (
            <dl>
              <dt>最近检查</dt>
              <dd>{new Date(monitor.checked_at).toLocaleString()} · {monitor.interface}</dd>
              <dt>网络状态</dt>
              <dd>{localStatus[monitor.status] ?? "未知"} · {externalStatus[monitor.connectivity] ?? "外网状态未知"}</dd>
              <dt>IPv4 地址 / 网关</dt>
              <dd>{monitor.address ?? "无"} / {monitor.gateway ?? "无"}</dd>
              {outageMinutes > 0 && <><dt>连续断网</dt><dd>{outageMinutes} 分钟</dd></>}
              <dt>上次重连</dt>
              <dd>{actionLabel(monitor.last_reconnect)}</dd>
              <dt>上次自动重启</dt>
              <dd>{actionLabel(monitor.last_reboot)}</dd>
            </dl>
          )}
          <Button onClick={() => void toggle(!state.enabled)} disabled={busy}>
            {busy ? "正在保存…" : state.enabled ? "暂停自动恢复" : "启用自动恢复"}
          </Button>
        </>
      )}
      {error && <p role="alert" className="card-footer-note">{error}</p>}
      {saveError && <p role="alert" className="card-footer-note">{saveError}</p>}
    </Card>
  );
}
