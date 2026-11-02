"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type { CustomService, ManagedProcess } from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, LoadingState, PageHeader } from "../ui/primitives";

type OcrHealth = { ready: boolean; model?: string; error?: string };

export function OcrPanel() {
  const [service, setService] = useState<CustomService | null>(null);
  const [process, setProcess] = useState<ManagedProcess | null>(null);
  const [health, setHealth] = useState<OcrHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [frameHeight, setFrameHeight] = useState(1200);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    try {
      const [registered, running] = await Promise.all([
        apiFetch<{ services: CustomService[] }>(`${API_PATHS.llama}/custom-services`),
        apiFetch<{ processes: ManagedProcess[] }>(`${API_PATHS.llama}/managed-processes`),
      ]);
      // 当前工作台使用小米官方服务接口，不将其他 OCR 服务误判为兼容。
      const chosen = registered.services.find(item => item.id === "xiaomi_ocr_0");
      const current = chosen ? running.processes.find(item => item.service_id === chosen.id && item.running !== false && item.port) : undefined;
      setService(chosen || null);
      setProcess(current || null);
      if (current) {
        try {
          setHealth(await apiFetch<OcrHealth>(`/llama-manager/llama-process/${current.pid}/api/health`));
        } catch {
          setHealth(null);
        }
      } else setHealth(null);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow || event.data?.type !== "hannishub-ocr-height") return;
      const height = Number(event.data.height);
      if (Number.isFinite(height) && height > 0) setFrameHeight(Math.max(720, Math.min(height + 8, 10000)));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function startService() {
    if (!service) return;
    setStarting(true);
    setError("");
    try {
      await apiFetch(`${API_PATHS.llama}/start`, { method: "POST", body: jsonBody({ service_id: service.id }) });
      await load();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setStarting(false);
    }
  }

  return <>
    <PageHeader kicker="模型管理 / OCR" title="OCR识别" description="解析文档、提取字段并对图片提问，支持图片与 PDF。" />
    {error ? <ErrorState message={error} /> : null}
    <div className="stack-grid">
      <Card>
        <CardHeader title="OCR 服务" description="使用已注册的小米 OCR 服务与本地模型。" />
        {loading ? <LoadingState /> : <div className="asr-service">
          <Badge tone={health?.ready ? "success" : "warning"}>{health?.ready ? "可用" : process ? "启动中" : "未运行"}</Badge>
          <strong>{service?.name || "未注册小米 OCR 服务"}</strong>
          {process ? <span>PID {process.pid}{health?.error ? ` · ${health.error}` : ""}</span> : service ? <span>默认注册服务 · GPU {service.gpu_indexes?.length ? service.gpu_indexes.join(", ") : "全部"}</span> : <a href="/llama/models">前往推理服务注册</a>}
          {!process && service ? <Button onClick={() => void startService()} disabled={starting}>{starting ? "启动中…" : "默认启动"}</Button> : null}
          {process && !health?.ready ? <Button size="sm" variant="secondary" onClick={() => void load()}>刷新状态</Button> : null}
        </div>}
      </Card>
      {process && health?.ready ? <iframe
        ref={frameRef}
        className="ocr-workspace-frame"
        title="小米 OCR 文档工作台"
        src={`/llama-manager/llama-process/${process.pid}/?embedded=1`}
        style={{ height: frameHeight }}
      /> : null}
    </div>
  </>;
}
