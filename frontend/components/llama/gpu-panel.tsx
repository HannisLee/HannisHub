"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { clampPercent, errorMessage, formatMemMb } from "../../lib/format";
import type { GpuProcess, GpuResponse, GpuStatus } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, ProgressBar } from "../ui/primitives";

const GPU_COLORS = [
  "var(--color-brand)",
  "#7BA05B",
  "#6E8CC4",
  "#C08B5C",
  "#8E7BA8",
  "#5CA8A0",
];

function formatChartTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", { hour12: false, minute: "2-digit" });
}

function GpuOverviewChart({ gpus }: { gpus: GpuStatus[] }) {
  const histories = gpus.map((gpu, index) => ({
    index,
    gpu,
    points: (gpu.history || []).filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.gpu_util)),
  })).filter(item => item.points.length);
  if (!histories.length) return <EmptyState title="还没有历史采样" detail="GPU 监控每 5 秒自动采样，积累数据后显示趋势图。" />;

  const timestamps = histories.flatMap(item => item.points.map(point => point.timestamp));
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  const timeRange = Math.max(maxTime - minTime, 1);
  const width = 1000;
  const height = 320;
  const padding = { top: 20, right: 18, bottom: 36, left: 48 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (timestamp: number) => padding.left + ((timestamp - minTime) / timeRange) * plotWidth;
  const y = (value: number) => padding.top + plotHeight - (clampPercent(value) / 100) * plotHeight;

  return (
    <div className="gpu-overview-chart">
      <div className="gpu-chart-legend">
        {histories.map(item => {
          const latestMemory = item.points.at(-1);
          const memoryPercent = latestMemory?.total_mem
            ? clampPercent((Number(latestMemory.used_mem || 0) / Number(latestMemory.total_mem)) * 100)
            : null;
          return (
            <span key={item.gpu.index}>
              <i style={{ background: GPU_COLORS[item.index % GPU_COLORS.length] }} />
              GPU {item.gpu.index}
              <small>
                利用率 {clampPercent(item.points.at(-1)?.gpu_util).toFixed(0)}%
                {memoryPercent === null ? "" : ` · 显存 ${memoryPercent.toFixed(0)}%`}
              </small>
            </span>
          );
        })}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="GPU 利用率与显存占比历史趋势">
        {[0, 25, 50, 75, 100].map(value => (
          <g key={value}>
            <line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} />
            <text x={padding.left - 10} y={y(value) + 4}>{value}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
          const timestamp = minTime + timeRange * ratio;
          return <text key={ratio} x={x(timestamp)} y={height - 12}>{formatChartTime(timestamp)}</text>;
        })}
        {histories.map(item => {
          const color = GPU_COLORS[item.index % GPU_COLORS.length];
          const points = item.points.length === 1
            ? [item.points[0], { ...item.points[0], timestamp: item.points[0].timestamp + 1 }]
            : item.points;
          const coordinates = points.map(point => `${x(point.timestamp).toFixed(1)},${y(point.gpu_util).toFixed(1)}`).join(" ");
          const memorySource = item.points.filter(point => (
            Number.isFinite(Number(point.used_mem)) &&
            Number.isFinite(Number(point.total_mem)) &&
            Number(point.total_mem) > 0
          ));
          const memoryPoints = memorySource.length === 1
            ? [memorySource[0], { ...memorySource[0], timestamp: memorySource[0].timestamp + 1 }]
            : memorySource;
          const memoryCoordinates = memoryPoints.map(point => (
            `${x(point.timestamp).toFixed(1)},${y((Number(point.used_mem) / Number(point.total_mem)) * 100).toFixed(1)}`
          )).join(" ");
          return (
            <g key={item.gpu.index}>
              <polyline points={coordinates} style={{ stroke: color }} />
              {memoryCoordinates ? <polyline className="is-memory" points={memoryCoordinates} style={{ stroke: color }} /> : null}
              <circle cx={x(points.at(-1)!.timestamp)} cy={y(points.at(-1)!.gpu_util)} r="4" style={{ fill: color }} />
            </g>
          );
        })}
      </svg>
      <div className="gpu-chart-meta">
        <span>纵轴：0–100%；实线为 GPU 利用率，虚线为显存占比</span>
        <span>采样窗口：{formatChartTime(minTime)} – {formatChartTime(maxTime)}</span>
      </div>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuStatus }) {
  const util = clampPercent(gpu.gpu_util);
  const memory = gpu.total_mem ? clampPercent((Number(gpu.used_mem || 0) / Number(gpu.total_mem)) * 100) : 0;
  return (
    <article className="gpu-card">
      <div className="gpu-card-head">
        <div><span className="eyebrow eyebrow-small">GPU {gpu.index}</span><h3>{gpu.name || "未知设备"}</h3></div>
        <span className="gpu-util">{util.toFixed(0)}%</span>
      </div>
      <div className="gpu-meter-label"><span>利用率</span><b>{util.toFixed(0)}%</b></div>
      <ProgressBar value={util} />
      <div className="gpu-meter-label"><span>显存</span><b>{formatMemMb(gpu.used_mem)} / {formatMemMb(gpu.total_mem)}</b></div>
      <ProgressBar value={memory} tone="warning" />
      <div className="gpu-meta"><span>温度 {gpu.temperature ?? "—"}°C</span><span>{gpu.process_count || 0} 个进程</span><span>{gpu.users?.length ? gpu.users.join(", ") : "无用户"}</span></div>
    </article>
  );
}

export function GpuPanel() {
  const [data, setData] = useState<GpuResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stoppingPid, setStoppingPid] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<GpuResponse>(`${API_PATHS.llama}/gpus`));
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [load]);

  const gpuProcesses = useMemo<GpuProcess[]>(() => {
    if (data?.gpu_processes?.length) return data.gpu_processes;
    return (data?.gpus || []).flatMap(gpu => (gpu.processes || []).map(process => ({ ...process, gpu_index: gpu.index })));
  }, [data]);

  async function stopProcess(process: GpuProcess) {
    if (!window.confirm(`确定停止 GPU ${process.gpu_index ?? "?"} 上的进程 ${process.pid} 吗？`)) return;
    setStoppingPid(process.pid);
    try {
      await apiFetch(`${API_PATHS.llama}/gpu-processes/stop`, { method: "POST", body: jsonBody({ pid: process.pid }) });
      await load();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setStoppingPid(null);
    }
  }

  return (
    <>
      <PageHeader
        kicker="模型管理 / GPU"
        title="GPU 监控"
        description="全宽趋势图、设备状态和本机 GPU 进程；页面每 5 秒自动刷新。"
        actions={<Button variant="secondary" size="sm" onClick={() => void load()}>立即刷新</Button>}
      />
      {error ? <ErrorState message={error} /> : null}
      {!data ? loading ? <LoadingState /> : null : data.gpus?.length ? (
        <div className="stack-grid">
          <Card>
            <CardHeader title="GPU 利用率趋势" description="汇总每张 GPU 的历史采样，图表随浏览器宽度铺满页面。" />
            <GpuOverviewChart gpus={data.gpus} />
          </Card>
          <div className="gpu-grid">{data.gpus.map(gpu => <GpuCard gpu={gpu} key={gpu.index} />)}</div>
          <Card>
            <CardHeader
              title={`GPU 进程 · ${gpuProcesses.length}`}
              description="显示本机全部 GPU 进程；桌面图形进程（Xorg / GNOME Shell 等）受保护，不进入停止列表。"
            />
            {gpuProcesses.length ? (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>GPU</th><th>PID</th><th>类型</th><th>进程</th><th>用户</th><th>显存</th><th>来源</th><th>操作</th></tr></thead>
                  <tbody>{gpuProcesses.map(process => (
                    <tr key={`${process.gpu_index}-${process.pid}-${process.gpu_pid}`}>
                      <td>{process.gpu_index ?? "—"}</td>
                      <td>{process.pid}{process.gpu_pid && process.gpu_pid !== process.pid ? <small className="table-subline">GPU PID {process.gpu_pid}</small> : null}</td>
                      <td>{process.process_type === "G" ? "图形" : "计算"}</td>
                      <td><strong>{process.display_name || process.process_name || "未知进程"}</strong><small className="table-subline">{process.command || process.model_name || ""}</small></td>
                      <td>{process.username || "—"}</td>
                      <td>{formatMemMb(process.used_mem)}</td>
                      <td><Badge tone={process.managed ? "success" : "neutral"}>{process.managed ? "受管服务" : "本机进程"}</Badge></td>
                      <td><Button size="sm" variant="danger" onClick={() => void stopProcess(process)} disabled={stoppingPid === process.pid}>{stoppingPid === process.pid ? "停止中…" : "停止"}</Button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <EmptyState title="暂无 GPU 进程" detail="当前没有可管理的 GPU 计算进程。" />}
          </Card>
        </div>
      ) : (
        <Card><EmptyState title="没有 GPU 数据" detail={data.error || "nvidia-smi 不可用或当前没有可见设备。"} /><div className="card-footer-note"><Badge tone="info">历史数据</Badge>如果配置过历史采样，可以在模型设置中调整保留时长。</div></Card>
      )}
    </>
  );
}
