"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch } from "../../lib/api";
import { clampPercent, errorMessage, formatMemMb } from "../../lib/format";
import type { GpuResponse, GpuStatus } from "../../lib/types";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, ProgressBar } from "../ui/primitives";

function GpuHistory({ gpu }: { gpu: GpuStatus }) {
  const points = (gpu.history || []).slice(-72);
  if (points.length < 2) return <p className="gpu-history-empty">积累两条采样记录后显示利用率历史。</p>;
  const coordinates = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 52 - (clampPercent(point.gpu_util) / 100) * 48;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return <div className="gpu-history"><div><span>利用率历史</span><small>最近 {points.length} 条采样</small></div><svg viewBox="0 0 100 56" role="img" aria-label={`GPU ${gpu.index} 利用率历史`} preserveAspectRatio="none"><path d="M0 4H100M0 28H100M0 52H100" /><polyline points={coordinates} /></svg></div>;
}

function GpuCard({ gpu }: { gpu: GpuStatus }) {
  const util = clampPercent(gpu.gpu_util);
  const memory = gpu.total_mem ? clampPercent((Number(gpu.used_mem || 0) / Number(gpu.total_mem)) * 100) : 0;
  return <article className="gpu-card"><div className="gpu-card-head"><div><span className="eyebrow eyebrow-small">GPU {gpu.index}</span><h3>{gpu.name || "未知设备"}</h3></div><span className="gpu-util">{util.toFixed(0)}%</span></div><div className="gpu-meter-label"><span>利用率</span><b>{util.toFixed(0)}%</b></div><ProgressBar value={util} /><div className="gpu-meter-label"><span>显存</span><b>{formatMemMb(gpu.used_mem)} / {formatMemMb(gpu.total_mem)}</b></div><ProgressBar value={memory} tone="warning" /><GpuHistory gpu={gpu} /><div className="gpu-meta"><span>温度 {gpu.temperature ?? "—"}°C</span><span>{gpu.process_count || 0} 个进程</span></div></article>;
}

export function GpuPanel() {
  const [data, setData] = useState<GpuResponse | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try { setData(await apiFetch<GpuResponse>(`${API_PATHS.llama}/gpus`)); setError(""); } catch (value) { setError(errorMessage(value)); }
  }

  useEffect(() => {
    const firstLoad = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5000);
    return () => { window.clearTimeout(firstLoad); window.clearInterval(timer); };
  }, []);

  return <>
    <PageHeader kicker="模型管理 / GPU" title="GPU 监控" description="每 5 秒读取本机 GPU 利用率、显存、温度和受管进程归属。" actions={<button className="button button-secondary button-sm" type="button" onClick={() => void load()}>立即刷新</button>} />
    {error ? <ErrorState message={error} /> : null}
    {!data ? <LoadingState /> : data.gpus?.length ? <><div className="gpu-grid">{data.gpus.map(gpu => <GpuCard gpu={gpu} key={gpu.index} />)}</div><Card><CardHeader title="GPU 进程" description="展示模型管理模块启动的进程及其显存占用。" />{data.managed_processes?.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>GPU</th><th>PID</th><th>进程</th><th>显存</th><th>模型</th><th>端口</th></tr></thead><tbody>{data.managed_processes.map(process => <tr key={process.pid}><td>{process.gpu_indexes?.length ? process.gpu_indexes.join(", ") : "—"}</td><td>{process.pid}</td><td><strong>{process.display_name || process.model_name || "受管服务"}</strong><small className="table-subline">{process.service_category || "llm"}</small></td><td>{formatMemMb((data.gpus || []).find(gpu => gpu.processes?.some(item => item.pid === process.pid))?.processes?.find(item => item.pid === process.pid)?.used_mem)}</td><td>{process.model_name || process.model || "—"}</td><td>{process.port || "—"}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无受管进程" detail="进程启动并占用 GPU 后会出现在这里。" />}</Card></> : <Card><EmptyState title="没有 GPU 数据" detail={data.error || "nvidia-smi 不可用或当前没有可见设备。"} /><div className="card-footer-note"><Badge tone="info">历史数据</Badge>如果配置过历史采样，可以在模型设置中调整保留时长。</div></Card>}
  </>;
}
