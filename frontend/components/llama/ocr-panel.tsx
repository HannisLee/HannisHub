"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_PATHS, apiFetch, encodePath, jsonBody, uploadBinary } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { CustomService, ManagedProcess, OcrRecord, OcrTask } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, ProgressBar } from "../ui/primitives";
import { OcrResultView } from "./ocr-result";

type OcrHealth = { ready: boolean; model?: string; error?: string };
type ResultView = "pretty" | "raw" | "json";

const SUPPORTED_FORMATS = ["PNG", "JPG", "JPEG", "WEBP", "BMP", "PDF"];
const ACCEPT = "image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp,.pdf,application/pdf";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const TASKS: { id: OcrTask; label: string; mark: string }[] = [
  { id: "document", label: "文档解析", mark: "▤" },
  { id: "kie", label: "字段提取", mark: "⌘" },
  { id: "vqa", label: "图像问答", mark: "?" },
];
const TASK_LABELS: Record<OcrTask, string> = { document: "文档解析", kie: "字段提取", vqa: "图像问答" };
const STATUS_LABELS: Record<OcrRecord["status"], string> = { queued: "排队中", running: "识别中", completed: "已完成", error: "失败" };

function extensionOf(name: string): string {
  return name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
}

function statusTone(status: OcrRecord["status"]): "success" | "error" | "warning" {
  return status === "completed" ? "success" : status === "error" ? "error" : "warning";
}

export function OcrPanel() {
  const [service, setService] = useState<CustomService | null>(null);
  const [process, setProcess] = useState<ManagedProcess | null>(null);
  const [health, setHealth] = useState<OcrHealth | null>(null);
  const [starting, setStarting] = useState(false);
  const [task, setTask] = useState<OcrTask>("document");
  const [fields, setFields] = useState("");
  const [question, setQuestion] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingUrl, setPendingUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [records, setRecords] = useState<OcrRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [resultText, setResultText] = useState<{ id: string; text: string } | null>(null);
  const [view, setView] = useState<ResultView>("pretty");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = records.find(record => record.id === selectedId) || null;
  const ready = Boolean(process && health?.ready);

  const loadService = useCallback(async () => {
    try {
      const [registered, running] = await Promise.all([
        apiFetch<{ services: CustomService[] }>(`${API_PATHS.llama}/custom-services`),
        apiFetch<{ processes: ManagedProcess[] }>(`${API_PATHS.llama}/managed-processes`),
      ]);
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
    } catch {
      setHealth(null);
    }
  }, []);

  const loadRecords = useCallback(async () => {
    try {
      const data = await apiFetch<{ records: OcrRecord[] }>(`${API_PATHS.ocr}/records`);
      setRecords(data.records || []);
      setRecordsLoaded(true);
    } catch (value) {
      setError(errorMessage(value));
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { void loadService(); void loadRecords(); }, 0);
    const serviceTimer = window.setInterval(() => void loadService(), 10000);
    return () => { window.clearTimeout(initial); window.clearInterval(serviceTimer); };
  }, [loadService, loadRecords]);

  // 有排队或识别中的记录时每 2 秒刷新一次进度。
  const hasActive = records.some(record => record.status === "queued" || record.status === "running");
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void loadRecords(), 2000);
    return () => window.clearInterval(timer);
  }, [hasActive, loadRecords]);

  // 选中记录完成后自动读取结果。
  const selectedStatus = selected?.status;
  useEffect(() => {
    if (!selectedId || selectedStatus !== "completed" || resultText?.id === selectedId) return;
    let cancelled = false;
    apiFetch<{ text: string }>(`${API_PATHS.ocr}/records/${encodePath(selectedId)}/text`)
      .then(data => { if (!cancelled) setResultText({ id: selectedId, text: data.text }); })
      .catch(value => { if (!cancelled) setError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [selectedId, selectedStatus, resultText?.id]);

  useEffect(() => () => { if (pendingUrl) URL.revokeObjectURL(pendingUrl); }, [pendingUrl]);

  function chooseFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!SUPPORTED_FORMATS.includes(extensionOf(file.name).toUpperCase())) {
      setError(`不支持该格式，请上传 ${SUPPORTED_FORMATS.join(" / ")} 文件`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("单个文件不能超过 50 MB");
      return;
    }
    setError("");
    setNotice(files && files.length > 1 ? "一次只解析一个文件，已选择第一个" : "");
    setPendingFile(file);
    setPendingUrl(URL.createObjectURL(file));
    setSelectedId("");
  }

  async function startParse() {
    if (!pendingFile || uploadProgress !== null) return;
    if (task === "vqa" && !question.trim()) { setError("请输入关于图像内容的问题"); return; }
    setError("");
    setNotice("");
    setUploadProgress(0);
    try {
      const params = new URLSearchParams({ task, fields: task === "kie" ? fields : "", question: task === "vqa" ? question : "" });
      const data = await uploadBinary<{ record: OcrRecord }>(`${API_PATHS.ocr}/records?${params}`, pendingFile, {
        "Content-Type": pendingFile.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(pendingFile.name),
      }, setUploadProgress);
      setRecords(current => [data.record, ...current.filter(item => item.id !== data.record.id)]);
      setSelectedId(data.record.id);
      setPendingFile(null);
      setPendingUrl("");
      setView("pretty");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setUploadProgress(null);
    }
  }

  function selectRecord(record: OcrRecord) {
    setSelectedId(record.id);
    setPendingFile(null);
    setPendingUrl("");
    setView("pretty");
    setTask(record.task);
    setFields(record.fields || "");
    setQuestion(record.question || "");
    window.requestAnimationFrame(() => document.querySelector(".ocr-stage")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  /** 清除左栏文件与当前查看的记录，回到拖入上传状态。 */
  function clearSource() {
    setPendingFile(null);
    setPendingUrl("");
    setSelectedId("");
    setNotice("");
  }

  async function startService() {
    if (!service) return;
    setStarting(true);
    try {
      await apiFetch(`${API_PATHS.llama}/start`, { method: "POST", body: jsonBody({ service_id: service.id }) });
      await loadService();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setStarting(false);
    }
  }

  async function renameRecord(record: OcrRecord) {
    const name = window.prompt("请输入新的记录名称", record.name || record.filename);
    if (!name?.trim()) return;
    try {
      await apiFetch(`${API_PATHS.ocr}/records/${encodePath(record.id)}`, { method: "PATCH", body: jsonBody({ name }) });
      await loadRecords();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  async function deleteRecord(record: OcrRecord) {
    if (!window.confirm(`确定删除「${record.name}」的识别记录吗？原始文件与结果会一并删除。`)) return;
    try {
      await apiFetch(`${API_PATHS.ocr}/records/${encodePath(record.id)}`, { method: "DELETE" });
      if (selectedId === record.id) { setSelectedId(""); setResultText(null); }
      await loadRecords();
    } catch (value) {
      setError(errorMessage(value));
    }
  }

  const currentText = selected && resultText?.id === selected.id ? resultText.text : "";
  const jsonText = useMemo(() => selected ? JSON.stringify({ record: selected, content: currentText }, null, 2) : "", [selected, currentText]);

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(view === "json" ? jsonText : currentText);
      setNotice("已复制识别结果");
    } catch {
      setError("复制失败，请手动选择文本复制");
    }
  }

  function downloadResult() {
    if (!selected) return;
    const isJson = view === "json";
    const blob = new Blob([isJson ? jsonText : currentText], { type: isJson ? "application/json" : "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(selected.name || "ocr").replace(/\.[^.]+$/, "")}.${isJson ? "json" : "md"}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  const sourceUrl = pendingUrl || (selected ? `${API_PATHS.ocr}/records/${encodePath(selected.id)}/source` : "");
  const sourceIsPdf = pendingFile ? extensionOf(pendingFile.name) === "pdf" : selected?.kind === "pdf";
  const sourceName = pendingFile?.name || selected?.name || "";
  const isPdfSelected = sourceIsPdf && Boolean(sourceUrl);

  const serviceBadge = <div className="ocr-service-state">
    <Badge tone={ready ? "success" : "warning"}>{ready ? "OCR 可用" : process ? "OCR 启动中" : "OCR 未运行"}</Badge>
    {!process && service ? <Button size="sm" onClick={() => void startService()} disabled={starting}>{starting ? "启动中…" : "启动服务"}</Button> : null}
    {!service ? <a href="/llama/models">前往注册 OCR 服务</a> : null}
  </div>;

  return <>
    <PageHeader kicker="模型管理 / OCR" title="OCR识别" description="解析文档、提取字段并对图片提问，支持图片与 PDF；识别记录按账号独立保存。" actions={serviceBadge} />
    {error ? <ErrorState message={error} /> : null}
    {notice ? <div className="inline-message"><Badge tone="info">提示</Badge>{notice}</div> : null}
    <input ref={inputRef} className="visually-hidden" type="file" accept={ACCEPT} onChange={event => { chooseFile(event.target.files); event.target.value = ""; }} />
    <div className="stack-grid">
      <Card className="ocr-workspace">
        <div className="ocr-tools">
          <div className="segmented" role="tablist" aria-label="选择任务">
            {TASKS.map(item => <button key={item.id} type="button" role="tab" aria-selected={task === item.id} onClick={() => setTask(item.id)}><span aria-hidden="true">{item.mark}</span> {item.label}</button>)}
          </div>
          {isPdfSelected && task !== "document" ? <span className="ocr-task-hint">PDF 会先逐页解析为 Markdown，再由「设置 · AI 能力」中当前启用的模型{task === "kie" ? "提取字段" : "回答问题"}</span> : null}
          <div className="ocr-run-actions">
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>↑ 上传文件</Button>
            <Button onClick={() => void startParse()} disabled={!pendingFile || uploadProgress !== null || !ready} title={!ready ? "OCR 服务未就绪" : undefined}>{uploadProgress !== null ? `上传中 ${uploadProgress}%` : "开始解析 ↗"}</Button>
          </div>
        </div>
        {task === "kie" ? <label className="ocr-task-input"><span>想提取哪些字段？<small>逗号分隔，留空提取主要信息</small></span><input value={fields} onChange={event => setFields(event.target.value)} placeholder="例如：日期、商户、总额、税额" maxLength={500} /></label> : null}
        {task === "vqa" ? <label className="ocr-task-input"><span>关于这张图，你想了解什么？</span><input value={question} onChange={event => setQuestion(event.target.value)} placeholder="例如：文档中的总金额是多少？" maxLength={2000} /></label> : null}

        <section className="ocr-stage">
          <div className="ocr-pane">
            <div className="ocr-pane-head">
              <span className="ocr-pane-title"><span className="ocr-step">01</span> 原始文档{sourceName ? <Badge>{sourceIsPdf ? "PDF" : "IMAGE"}</Badge> : null}</span>
              {sourceUrl ? <div className="row-actions">
                <Button size="sm" variant="quiet" onClick={() => inputRef.current?.click()} disabled={uploadProgress !== null}>更换文件</Button>
                <Button size="sm" variant="secondary" onClick={clearSource} disabled={uploadProgress !== null}>清除</Button>
              </div> : null}
            </div>
            <div
              className={`ocr-source${sourceUrl ? " has-file" : ""}${dragging ? " is-dragover" : ""}`}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files); }}
            >
              {sourceUrl ? sourceIsPdf
                ? <iframe title={`${sourceName} 预览`} src={sourceUrl} />
                : <button className="ocr-source-image" type="button" onClick={() => void startParse()} disabled={!pendingFile || !ready} title={pendingFile ? "点击开始解析" : sourceName}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- 本地预览与受保护接口图片无需 Next 图片优化 */}
                  <img src={sourceUrl} alt={sourceName} />
                </button>
                : <div className="upload-drop ocr-drop" role="button" tabIndex={0} onClick={() => inputRef.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}>
                  <span className="upload-mark">↑</span>
                  <strong>拖入文档，或点击选择文件</strong>
                  <div className="ocr-format-tags" aria-label="支持的格式">{SUPPORTED_FORMATS.map(format => <span key={format}>{format}</span>)}</div>
                  <small>单个文件不超过 50 MB；PDF 仅支持文档解析，按页识别后合并。</small>
                </div>}
            </div>
            <div className="ocr-pane-foot">
              <span title={sourceName}>{sourceName || "选择文件"}</span>
              <span>{pendingFile ? `${formatBytes(pendingFile.size)} · ${ready ? "准备就绪，点击开始解析" : "等待 OCR 服务就绪"}` : selected ? `${formatBytes(selected.size)} · ${TASK_LABELS[selected.task]}` : "准备就绪"}</span>
            </div>
          </div>

          <div className="ocr-pane">
            <div className="ocr-pane-head">
              <span className="ocr-pane-title"><span className="ocr-step">02</span> 识别结果{selected ? <Badge tone={statusTone(selected.status)}>{STATUS_LABELS[selected.status]}</Badge> : null}</span>
              <div className="row-actions">
                <Button size="sm" variant="secondary" onClick={() => void copyResult()} disabled={!currentText}>复制</Button>
                <Button size="sm" variant="secondary" onClick={downloadResult} disabled={!currentText}>下载 ↓</Button>
              </div>
            </div>
            <div className="ocr-result-toolbar">
              <div className="segmented" role="tablist" aria-label="结果视图">
                {([["pretty", "预览"], ["raw", "原文"], ["json", "JSON"]] as [ResultView, string][]).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>{label}</button>)}
              </div>
              <span>Markdown · LaTeX · 表格</span>
            </div>
            <div className="ocr-result-body">
              {!selected ? <div className="ocr-result-empty"><h2>信息，跃然纸上</h2><p>选择一份文档，点击「开始解析」，在这里查看可复制、可下载的结果。</p><div className="ocr-format-tags"><span>文字</span><span>表格</span><span>公式</span></div></div>
                : selected.status === "error" ? <div className="ocr-result-empty"><Badge tone="error">识别失败</Badge><p>{selected.error || "未知错误"}</p></div>
                : selected.status !== "completed" ? <div className="ocr-result-empty"><p>{selected.progress_detail || "正在识别…"}</p><ProgressBar value={selected.progress || 0} /></div>
                : !currentText ? <div className="ocr-result-empty"><p>正在读取结果…</p></div>
                : view === "pretty" ? <OcrResultView text={currentText} />
                : <pre className="ocr-code">{view === "json" ? jsonText : currentText}</pre>}
            </div>
            <div className="ocr-pane-foot">
              <span>{selected?.warning || (selected?.status === "completed" ? `${(selected.chars || 0).toLocaleString()} 字符` : "选择文件，或从下方记录中查看")}</span>
              <span>{selected?.latency_ms ? `${(selected.latency_ms / 1000).toFixed(1)} s` : ""}{selected?.pages ? ` · ${selected.pages} 页` : ""}</span>
            </div>
          </div>
        </section>
      </Card>

      <Card>
        <CardHeader title={`识别记录 · ${records.length}`} description="仅显示当前账号的记录，原始文件与结果保存在本机。" />
        {records.length ? <div className="stack-list">{records.map(record => (
          <article className={`history-row ocr-record${record.id === selectedId ? " is-selected" : ""}`} key={record.id}>
            <div className="history-main">
              <div className="history-title"><strong title={record.name}>{record.name}</strong><Badge tone={statusTone(record.status)}>{STATUS_LABELS[record.status]}</Badge></div>
              <span>{formatDate(record.created_at)} · {TASK_LABELS[record.task]}{record.pipeline === "pdf_text" ? "（先解析后文本处理）" : ""} · {record.kind === "pdf" ? "PDF" : "图片"} · {formatBytes(record.size)}{record.status === "completed" ? ` · ${(record.chars || 0).toLocaleString()} 字符` : record.status !== "error" ? ` · ${record.progress_detail || ""}` : ""}</span>
              {record.task === "vqa" && record.question ? <small>问题：{record.question}</small> : null}
              {record.task === "kie" && record.fields ? <small>字段：{record.fields}</small> : null}
              {record.status === "queued" || record.status === "running" ? <ProgressBar value={record.progress || 0} /> : null}
              {record.error ? <small className="error-text">{record.error}</small> : null}
            </div>
            <div className="row-actions">
              <Button size="sm" variant="quiet" onClick={() => selectRecord(record)}>查看</Button>
              <a className="button button-quiet button-sm" href={`${API_PATHS.ocr}/records/${encodePath(record.id)}/source`} target="_blank" rel="noreferrer">原文件</a>
              <Button size="sm" variant="quiet" onClick={() => void renameRecord(record)}>重命名</Button>
              <Button size="sm" variant="danger" onClick={() => void deleteRecord(record)} disabled={record.status === "queued" || record.status === "running"}>删除</Button>
            </div>
          </article>
        ))}</div> : <EmptyState title={recordsLoaded ? "还没有识别记录" : "正在读取记录…"} detail="上传第一份文档并开始解析后，结果会保存在这里。" />}
      </Card>
    </div>
  </>;
}
