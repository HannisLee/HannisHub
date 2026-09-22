"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import type { CustomService, GpuResponse, ManagedProcess } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

interface ProcessFormState {
  id: string;
  name: string;
  category: string;
  command: string;
  gpus: number[];
}

const emptyForm: ProcessFormState = { id: "", name: "", category: "llm", command: "", gpus: [] };

export function ProcessesPanel() {
  const [processes, setProcesses] = useState<ManagedProcess[]>([]);
  const [services, setServices] = useState<CustomService[]>([]);
  const [gpus, setGpus] = useState<GpuResponse>({});
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [logs, setLogs] = useState("");
  const [form, setForm] = useState<ProcessFormState>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function load() {
    try {
      const [processData, serviceData, gpuData] = await Promise.all([
        apiFetch<{ processes: ManagedProcess[] }>(`${API_PATHS.llama}/managed-processes`),
        apiFetch<{ services: CustomService[] }>(`${API_PATHS.llama}/custom-services`),
        apiFetch<GpuResponse>(`${API_PATHS.llama}/gpus`),
      ]);
      setProcesses(processData.processes || []);
      setServices(serviceData.services || []);
      setGpus(gpuData);
      setError("");
    } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); }
  }

  const loadLogs = useCallback(async (pid: number) => {
    try { const data = await apiFetch<{ logs: string }>(`${API_PATHS.llama}/logs?pid=${encodeURIComponent(pid)}`); setLogs(data.logs || ""); } catch (value) { setLogs(`读取失败：${errorMessage(value)}`); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!selectedPid) return;
    const pid = selectedPid;
    const timer = window.setTimeout(() => void loadLogs(pid), 0);
    return () => window.clearTimeout(timer);
  }, [loadLogs, selectedPid]);

  const runningByService = useMemo(() => new Map(processes.filter(item => item.running !== false && item.service_id).map(item => [item.service_id, item])), [processes]);

  async function processAction(action: "start" | "stop" | "restart", pid?: number, serviceId?: string) {
    const key = `${action}-${pid || serviceId || "all"}`;
    setBusy(key);
    try {
      await apiFetch(`${API_PATHS.llama}/${action}`, { method: "POST", body: jsonBody(pid ? { pid } : { service_id: serviceId }) });
      setMessage(action === "start" ? "服务已启动" : action === "stop" ? "服务已停止" : "服务已重启");
      await load();
    } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); }
  }

  function editService(service: CustomService) {
    setForm({ id: service.id, name: service.name || "", category: service.service_category || "llm", command: service.command || "", gpus: service.gpu_indexes || [] });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("save");
    try {
      await apiFetch(`${API_PATHS.llama}/custom-services`, { method: "POST", body: jsonBody({ id: form.id || undefined, name: form.name, service_category: form.category, command: form.command, gpu_indexes: form.gpus }) });
      setForm(emptyForm); setMessage("服务注册已保存"); await load();
    } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); }
  }

  async function deleteService(id: string) {
    if (!window.confirm("确定删除这个已注册服务吗？")) return;
    setBusy(`delete-${id}`);
    try { await apiFetch(`${API_PATHS.llama}/custom-services/${encodePath(id)}`, { method: "DELETE" }); setMessage("服务注册已删除"); await load(); } catch (value) { setError(errorMessage(value)); } finally { setBusy(""); }
  }

  function toggleGpu(index: number) {
    setForm(current => ({ ...current, gpus: current.gpus.includes(index) ? current.gpus.filter(item => item !== index) : [...current.gpus, index].sort((a, b) => a - b) }));
  }

  return (
    <>
      <PageHeader kicker="模型管理 / Processes" title="受管进程" description="注册、启动、停止和查看本机模型服务；所有启动命令都会进入受管进程记录。" actions={<Button variant="secondary" size="sm" onClick={() => void load()}>刷新状态</Button>} />
      {error ? <ErrorState message={error} /> : null}
      {message ? <div className="inline-message">{message}</div> : null}
      <div className="two-column-grid">
        <Card>
          <CardHeader title="注册服务" description="支持 llama.cpp、vLLM 和 ASR 等完整启动命令。" />
          <form className="form-grid" onSubmit={saveService}>
            <Field label="服务名" hint="留空时由后端根据命令推断。"><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：Qwen ASR" /></Field>
            <Field label="服务类型"><select value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}><option value="llm">标准 LLM</option><option value="asr">ASR</option></select></Field>
            <Field label="启动命令" className="field-wide" hint="命令中的 --port 会被用于打开服务入口。"><textarea value={form.command} onChange={event => setForm({ ...form, command: event.target.value })} rows={5} placeholder="python -m vllm.entrypoints.openai.api_server --model /path/to/model --port 8085" required /></Field>
            <div className="field field-wide"><span className="field-label">GPU 选择</span><div className="choice-row">{gpus.gpus?.length ? gpus.gpus.map(gpu => <label className="check-choice" key={gpu.index}><input type="checkbox" checked={form.gpus.includes(gpu.index)} onChange={() => toggleGpu(gpu.index)} />GPU {gpu.index}</label>) : <span className="field-hint">自动使用全部可见 GPU</span>}</div></div>
            <div className="form-actions field-wide"><Button type="submit" disabled={busy === "save"}>{busy === "save" ? "保存中…" : form.id ? "更新服务" : "保存服务"}</Button>{form.id ? <Button type="button" variant="quiet" onClick={() => setForm(emptyForm)}>取消编辑</Button> : null}</div>
          </form>
        </Card>
        <Card>
          <CardHeader title={`已注册服务 · ${services.length}`} description="启动后的进程会出现在下方运行列表。" />
          {loading ? <LoadingState /> : services.length ? <div className="stack-list">{services.map(service => { const running = runningByService.get(service.id); return <article className="service-row" key={service.id}><div className="service-row-main"><div className="service-row-title"><strong>{service.name}</strong><Badge tone={service.service_category === "asr" ? "warning" : "info"}>{service.service_category === "asr" ? "ASR" : "LLM"}</Badge></div><code>{service.command}</code><span className="muted-line">{service.gpu_indexes?.length ? `GPU ${service.gpu_indexes.join(", ")}` : "全部 GPU"}{running ? ` · PID ${running.pid}` : ""}</span></div><div className="row-actions">{running ? <><Button size="sm" variant="danger" onClick={() => void processAction("stop", running.pid)} disabled={busy === `stop-${running.pid}`}>停止</Button><Button size="sm" variant="secondary" onClick={() => void processAction("restart", running.pid)} disabled={busy === `restart-${running.pid}`}>重启</Button></> : <Button size="sm" onClick={() => void processAction("start", undefined, service.id)} disabled={busy === `start-${service.id}`}>启动</Button>}<Button size="sm" variant="quiet" onClick={() => editService(service)}>编辑</Button><Button size="sm" variant="quiet" onClick={() => void deleteService(service.id)} disabled={busy === `delete-${service.id}`}>删除</Button></div></article>; })}</div> : <EmptyState title="还没有注册服务" detail="用左侧表单添加一个可运行的命令。" />}
        </Card>
      </div>
      <Card>
        <CardHeader title="当前进程与日志" description="选择一个受管进程查看最近日志；日志按进程独立保存。" actions={<select className="select-compact" value={selectedPid || ""} onChange={event => setSelectedPid(event.target.value ? Number(event.target.value) : null)}><option value="">选择进程</option>{processes.filter(item => item.running !== false).map(item => <option value={item.pid} key={item.pid}>{item.display_name || item.model_name || `PID ${item.pid}`} · {item.pid}</option>)}</select>} />
        {loading ? <LoadingState /> : processes.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>服务</th><th>PID</th><th>端口</th><th>GPU</th><th>启动时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{processes.map(process => <tr key={process.pid}><td><strong>{process.display_name || process.model_name || "未命名服务"}</strong><small className="table-subline">{process.service_category || "llm"}</small></td><td>{process.pid}</td><td>{process.port || "—"}</td><td>{process.gpu_indexes?.length ? process.gpu_indexes.join(", ") : "全部"}</td><td>{formatDate(process.started_at)}</td><td><Badge tone={process.running === false ? "neutral" : "success"}>{process.running === false ? "已停止" : "运行中"}</Badge></td><td><div className="row-actions">{process.running !== false ? <><Button size="sm" variant="quiet" onClick={() => { setSelectedPid(process.pid); void loadLogs(process.pid); }}>日志</Button><Button size="sm" variant="danger" onClick={() => void processAction("stop", process.pid)}>停止</Button></> : null}{process.port ? <a className="button button-quiet button-sm" href={process.service_category === "asr" ? "/llama/asr" : `${API_PATHS.llama.replace("/api", "")}/chat/${process.pid}`} target={process.service_category === "asr" ? undefined : "_blank"} rel={process.service_category === "asr" ? undefined : "noreferrer"}>{process.service_category === "asr" ? "转写" : "聊天"}</a> : null}</div></td></tr>)}</tbody></table></div> : <EmptyState title="没有运行记录" detail="启动一个服务后，进程状态会显示在这里。" />}
        {selectedPid ? <pre className="log-viewer">{logs || "暂无日志"}</pre> : null}
      </Card>
    </>
  );
}
