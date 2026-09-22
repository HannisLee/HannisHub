"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch } from "../../lib/api";
import type { Connection, GpuResponse, ManagedProcess, RemoteTask, ServiceSummary } from "../../lib/types";
import { formatDate, formatMemMb, errorMessage } from "../../lib/format";
import { Card, CardHeader, EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, Badge } from "../ui/primitives";
import { Icon, type IconName } from "../ui/icon";

interface OverviewData {
  services: ServiceSummary[];
  processes: ManagedProcess[];
  gpus: GpuResponse;
  connections: Connection[];
  tasks: RemoteTask[];
  promptCount: number;
  loadedAt: number;
}

export function OverviewDashboard() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      apiFetch<{ services: ServiceSummary[] }>("/api/services"),
      apiFetch<{ processes: ManagedProcess[] }>(`${API_PATHS.llama}/managed-processes`),
      apiFetch<GpuResponse>(`${API_PATHS.llama}/gpus`),
      apiFetch<{ connections: Connection[] }>(`${API_PATHS.server}/connections`),
      apiFetch<{ tasks: RemoteTask[] }>(`${API_PATHS.server}/tasks`),
      apiFetch<{ prompts: unknown[] }>(`${API_PATHS.prompts}/prompts`),
    ]).then(([services, processes, gpus, connections, tasks, prompts]) => {
      if (!active) return;
      setData({
        services: services.services || [],
        processes: processes.processes || [],
        gpus,
        connections: connections.connections || [],
        tasks: tasks.tasks || [],
        promptCount: prompts.prompts?.length || 0,
        loadedAt: Date.now(),
      });
    }).catch(errorValue => { if (active) setError(errorMessage(errorValue)); });
    return () => { active = false; };
  }, []);

  if (error) return <><PageHeader kicker="HannisHub / Overview" title="总览" description="读取工作台状态时遇到问题。" /><ErrorState message={error} /></>;
  if (!data) return <><PageHeader kicker="HannisHub / Overview" title="总览" description="本机模型、远程服务器和提示词工作区的共同入口。" /><LoadingState /></>;

  const runningProcesses = data.processes.filter(item => item.running !== false);
  const onlineGpus = data.gpus.gpus?.length || 0;
  const activeTasks = data.tasks.filter(task => task.running).length;

  return (
    <>
      <PageHeader kicker="HannisHub / Overview" title="把运行中的世界放在一张桌面上" description="查看本机 GPU、受管服务、远程任务与提示词资产的当前状态。" />
      <div className="metric-grid">
        <MetricCard label="受管进程" value={runningProcesses.length} detail="当前运行中的服务" href="/llama/processes" />
        <MetricCard label="GPU" value={onlineGpus} detail={data.gpus.error || "已发现的设备"} href="/llama/gpu" />
        <MetricCard label="服务器连接" value={data.connections.length} detail="已保存的远程入口" href="/server/connections" />
        <MetricCard label="提示词" value={data.promptCount} detail="已归档的工作内容" href="/prompts" />
      </div>
      <div className="overview-grid">
        <Card>
          <CardHeader title="正在运行" description="受管进程和远程任务的即时快照。" actions={<a className="text-link" href="/llama/processes">查看全部 →</a>} />
          {runningProcesses.length ? <div className="compact-list">{runningProcesses.slice(0, 5).map(process => <div className="compact-row" key={process.pid}><div><strong>{process.display_name || process.model_name || `PID ${process.pid}`}</strong><span>PID {process.pid}{process.port ? ` · 端口 ${process.port}` : ""}</span></div><Badge tone="success">运行中</Badge></div>)}</div> : <EmptyState title="当前没有受管进程" detail="从模型管理页启动一个已注册服务。" />}
          {activeTasks ? <div className="overview-note"><span className="status-dot status-dot-warning" />{activeTasks} 个远程任务正在派发</div> : null}
        </Card>
        <Card>
          <CardHeader title="资源一览" description="GPU 状态和远程服务器连接。" actions={<a className="text-link" href="/llama/gpu">打开监控 →</a>} />
          {data.gpus.gpus?.length ? <div className="resource-list">{data.gpus.gpus.slice(0, 4).map(gpu => <div className="resource-row" key={gpu.index}><div><strong>GPU {gpu.index}</strong><span>{gpu.name || "未知设备"}</span></div><div className="resource-value"><b>{gpu.gpu_util ?? 0}%</b><span>{formatMemMb(gpu.used_mem)} / {formatMemMb(gpu.total_mem)}</span></div></div>)}</div> : <EmptyState title="没有 GPU 数据" detail={data.gpus.error || "nvidia-smi 当前没有返回设备。"} />}
        </Card>
        <Card className="overview-wide">
          <CardHeader title="服务入口" description="从一个统一的工作台进入各个操作模块。" />
          <div className="service-grid">{data.services.map(service => {
            const icon: IconName = service.id === "server" ? "connections" : service.id === "prompt" ? "prompts" : service.id === "point-clouds" ? "pointcloud" : "models";
            const href = service.id === "server" ? "/server/connections" : service.id === "prompt" ? "/prompts" : service.id === "point-clouds" ? "/point-clouds" : "/llama/models";
            return <a href={href} className="service-card" key={service.id}><span className="service-icon"><Icon name={icon} /></span><span><strong>{service.name}</strong><small>{service.description}</small></span><b>→</b></a>;
          })}</div>
          <p className="last-updated">本地时间 {formatDate(data.loadedAt)}</p>
        </Card>
      </div>
    </>
  );
}
