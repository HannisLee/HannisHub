"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_PATHS, ApiError, apiFetch, encodePath, uploadBinary } from "../../lib/api";
import { errorMessage, formatBytes, formatDate, truncate } from "../../lib/format";
import { appendAudioChunk, audioExtension, createLocalRecording, deleteLocalRecording, downloadAudio, listLocalRecordings, patchLocalRecording, readLocalAudio } from "../../lib/prompt-audio";
import type { LocalRecording, ServerRecording, VoiceInsertMode } from "../../lib/prompt-audio";
import { Button, Card, CardHeader, EmptyState, ErrorState } from "../ui/primitives";
import { RecordingPlayer } from "./recording-player";

const STATUS = { queued: "服务器已归档，等待处理", processing: "服务器转码 / 外部 ASR 转写中", waiting_config: "已归档，等待 ASR 配置", failed: "处理失败，可重试", done: "已归档并完成转写" };

export function VoiceInput({ disabled, onText, onRestore, onRecordingChange, onStatusChange, archiveTarget, feedbackTarget }: { disabled: boolean; onText: (text: string, insertMode: VoiceInsertMode) => void; onRestore: (text: string) => void; onRecordingChange: (recording: boolean) => void; onStatusChange: (status: string) => void; archiveTarget: HTMLElement | null; feedbackTarget: HTMLElement | null }) {
  const [local, setLocal] = useState<LocalRecording[]>([]);
  const [remote, setRemote] = useState<ServerRecording[]>([]);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [transferError, setTransferError] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [emergency, setEmergency] = useState<{ blob: Blob; id: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [insertMode, setInsertMode] = useState<VoiceInsertMode>("replace");
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const deletingRef = useRef(new Set<string>());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const syncRef = useRef(false);
  const nextAttemptRef = useRef<Record<string, { at: number; count: number }>>({});
  const textRef = useRef(onText);
  const recordingChangeRef = useRef(onRecordingChange);
  const aliveRef = useRef(true);
  const disabledRef = useRef(disabled);
  useEffect(() => { textRef.current = onText; recordingChangeRef.current = onRecordingChange; disabledRef.current = disabled; }, [onText, onRecordingChange, disabled]);

  useEffect(() => {
    onStatusChange(starting ? "正在准备 / 保存录音…" : recording ? `正在录音 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : transcribing ? "语音处理中…" : "");
  }, [starting, recording, seconds, transcribing, onStatusChange]);

  const sync = useCallback(async () => {
    if (syncRef.current) return;
    syncRef.current = true;
    let syncError = "";
    try {
      const locals = await listLocalRecordings();
      if (!aliveRef.current) return;
      setLocal(locals.filter(item => !deletingRef.current.has(item.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      // 已持久化但未正常停止的录音必须由用户主动恢复，避免上传另一个标签页正在录的片段。
      for (const item of locals) {
        if (deletingRef.current.has(item.id) || !item.ready || item.uploaded || !navigator.onLine || Date.now() < (nextAttemptRef.current[item.id]?.at || 0)) continue;
        try {
          const blob = await readLocalAudio(item);
          if (deletingRef.current.has(item.id)) continue;
          if (!blob.size || blob.size !== item.size) throw Error("本地音频不完整，请先下载检查");
          setUploads(current => ({ ...current, [item.id]: "上传中 0%" }));
          await uploadBinary<ServerRecording>(`${API_PATHS.prompts}/recordings/${encodePath(item.id)}`, blob, { "Content-Type": item.mime_type }, percent => {
            if (aliveRef.current) setUploads(current => ({ ...current, [item.id]: percent === 100 ? "服务器写入归档中…" : `上传中 ${percent}%` }));
          }, 300_000);
          if (deletingRef.current.has(item.id)) continue;
          await patchLocalRecording(item.id, { uploaded: true });
          setUploads(current => ({ ...current, [item.id]: "服务器已确认归档" }));
          delete nextAttemptRef.current[item.id];
        } catch (value) {
          if (value instanceof ApiError && value.status === 410) {
            deletingRef.current.add(item.id);
            await deleteLocalRecording(item.id);
            if (pendingIdRef.current === item.id) { pendingIdRef.current = null; setTranscribing(false); }
            continue;
          }
          if (deletingRef.current.has(item.id)) continue;
          syncError = `${errorMessage(value)}；录音已保存在本地，将自动重试上传`;
          if (pendingIdRef.current === item.id) { setTranscribing(false); pendingIdRef.current = null; }
          const count = (nextAttemptRef.current[item.id]?.count || 0) + 1;
          nextAttemptRef.current[item.id] = { count, at: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(count, 6)) };
          setUploads(current => ({ ...current, [item.id]: `${errorMessage(value)}；本地已保留，稍后自动重试` }));
        }
      }
      const result = await apiFetch<{ recordings: ServerRecording[]; deleted_recordings?: string[] }>(`${API_PATHS.prompts}/recordings`);
      if (!aliveRef.current) return;
      for (const id of result.deleted_recordings || []) {
        if (locals.some(item => item.id === id)) await deleteLocalRecording(id);
        deletingRef.current.add(id);
        if (pendingIdRef.current === id) { pendingIdRef.current = null; setTranscribing(false); }
      }
      setRemote(result.recordings.filter(item => !deletingRef.current.has(item.id)));
      const latest = (await listLocalRecordings()).sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const item of latest) {
        if (deletingRef.current.has(item.id)) continue;
        const server = result.recordings.find(server => server.id === item.id);
        if (server?.status === "done" && !item.applied && !disabledRef.current) {
          textRef.current(server.text, item.insert_mode || "replace");
          await patchLocalRecording(item.id, { applied: true });
        }
        if (pendingIdRef.current === item.id && server && ["done", "failed", "waiting_config"].includes(server.status)) {
          setTranscribing(false);
          pendingIdRef.current = null;
        }
      }
      const newest = latest.at(-1);
      const failed = newest && !newest.applied ? result.recordings.find(server => server.id === newest.id && ["failed", "waiting_config"].includes(server.status)) : undefined;
      if (failed) syncError = `语音转写失败：${failed.error || "外部 ASR 未返回有效文本"}。原音频已保留，可在语音归档中重试。`;
      setLocal((await listLocalRecordings()).filter(item => !deletingRef.current.has(item.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setTransferError(syncError);
    } catch (value) {
      if (aliveRef.current) setTransferError(errorMessage(value));
    } finally { syncRef.current = false; }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const timer = window.setInterval(() => void sync(), 2000);
    const immediate = window.setTimeout(() => void sync(), 0);
    const online = () => { nextAttemptRef.current = {}; void sync(); };
    const unload = (event: BeforeUnloadEvent) => {
      if (recorderRef.current?.state === "recording") { event.preventDefault(); }
    };
    window.addEventListener("online", online);
    window.addEventListener("hannishub:asr-settings", online);
    window.addEventListener("beforeunload", unload);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      window.clearTimeout(immediate);
      window.removeEventListener("online", online);
      window.removeEventListener("hannishub:asr-settings", online);
      window.removeEventListener("beforeunload", unload);
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorder?.stream.getTracks().forEach(track => track.stop());
    };
  }, [sync]);

  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  async function start(nextMode: VoiceInsertMode) {
    if (starting || recorderRef.current?.state === "recording") return;
    setStarting(true);
    setInsertMode(nextMode);
    recordingChangeRef.current(true);
    setError("");
    setTransferError("");
    let stream: MediaStream | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw Error("浏览器录音需要 HTTPS 或 localhost，请通过安全地址访问提示词页面");
      }
      await listLocalRecordings();
      // 请求浏览器尽量保留此站点的数据，未获准也继续本地保存。
      await navigator.storage?.persist?.().catch(() => false);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(mime => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      const id = `rec_${crypto.randomUUID()}`;
      await createLocalRecording({ id, created_at: new Date().toISOString(), mime_type: recorder.mimeType || preferred || "audio/webm", size: 0, chunks: 0, ready: false, uploaded: false, applied: false, insert_mode: nextMode });
      recorderRef.current = recorder;
      activeIdRef.current = id;
      const memoryChunks: Blob[] = [];
      let writes = Promise.resolve();
      let storageError = "";
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        memoryChunks.push(event.data);
        writes = writes.then(() => appendAudioChunk(id, event.data)).catch(value => {
          storageError = errorMessage(value);
          if (recorder.state === "recording") recorder.stop();
        });
      };
      recorder.onerror = () => { setError("录音设备出现异常，已保存的音频仍保留"); };
      recorder.onstop = () => {
        stream?.getTracks().forEach(track => track.stop());
        setRecording(false);
        setStarting(true);
        setTranscribing(true);
        pendingIdRef.current = id;
        void writes.then(async () => {
          if (storageError) throw Error(storageError);
          await patchLocalRecording(id, { ready: true });
          if (aliveRef.current) void sync();
        }).catch(value => {
          setEmergency({ id, blob: new Blob(memoryChunks, { type: recorder.mimeType }) });
          setError(`本地存储失败：${errorMessage(value)}。请下载完整录音备份。`);
          setTranscribing(false);
          pendingIdRef.current = null;
        }).finally(() => {
          activeIdRef.current = null;
          recorderRef.current = null;
          setStarting(false);
          recordingChangeRef.current(false);
        });
      };
      recorder.start(1000);
      setSeconds(0);
      setRecording(true);
    } catch (value) {
      stream?.getTracks().forEach(track => track.stop());
      setError(errorMessage(value));
      recordingChangeRef.current(false);
      recorderRef.current = null;
      activeIdRef.current = null;
    } finally { setStarting(false); }
  }

  async function retry(id: string, server?: ServerRecording, interrupted = false) {
    try {
      setError("");
      if (interrupted) await patchLocalRecording(id, { ready: true, interrupted: true });
      if (server) await apiFetch(`${API_PATHS.prompts}/recordings/${encodePath(id)}/retry`, { method: "POST" });
      delete nextAttemptRef.current[id];
      void sync();
    } catch (value) { setError(errorMessage(value)); }
  }

  async function remove(id: string) {
    if (deletingRef.current.has(id)) return;
    deletingRef.current.add(id);
    setDeleting(current => new Set(current).add(id));
    setError("");
    try {
      await apiFetch(`${API_PATHS.prompts}/recordings/${encodePath(id)}`, { method: "DELETE" });
      await deleteLocalRecording(id);
      delete nextAttemptRef.current[id];
      if (pendingIdRef.current === id) { pendingIdRef.current = null; setTranscribing(false); }
      setLocal(current => current.filter(item => item.id !== id));
      setRemote(current => current.filter(item => item.id !== id));
      setTransferError("");
    } catch (value) {
      deletingRef.current.delete(id);
      setError(`删除录音失败：${errorMessage(value)}`);
    } finally {
      setDeleting(current => { const next = new Set(current); next.delete(id); return next; });
    }
  }

  const allIds = [...new Set([...local.map(item => item.id), ...remote.map(item => item.id)])].sort((a, b) => {
    const date = (id: string) => local.find(item => item.id === id)?.created_at || remote.find(item => item.id === id)?.created_at || "";
    return date(b).localeCompare(date(a));
  });
  return <>
      <span className="prompt-voice-actions">{(["replace", "append"] as const).map(nextMode => <Button key={nextMode} size="sm" variant={recording && insertMode === nextMode ? "danger" : "secondary"} className={recording && insertMode === nextMode ? "" : "prompt-audio-action"} disabled={starting || transcribing || (recording ? insertMode !== nextMode : disabled || !!emergency)}
        onClick={() => recording ? recorderRef.current?.stop() : void start(nextMode)}>
        {recording && insertMode === nextMode ? "停止录音" : nextMode === "append" ? "增量语音" : "语音输入"}
      </Button>)}</span>
    {feedbackTarget ? createPortal(<>
      {error || transferError ? <ErrorState message={error || transferError} /> : null}
      {emergency ? <div className="row-actions"><Button size="sm" onClick={() => downloadAudio(emergency.blob, `${emergency.id}.${audioExtension(emergency.blob.type)}`)}>下载完整录音备份</Button><Button size="sm" variant="quiet" onClick={() => { setEmergency(null); setError(""); }}>备份完成，继续录音</Button><span className="muted">完整录音暂在内存中，请先下载，避免刷新页面。</span></div> : null}
    </>, feedbackTarget) : null}
    {archiveTarget ? createPortal(<Card className="prompt-settings-card prompt-audio-history">
      <CardHeader title={`语音归档 · ${allIds.length}`} />
      {allIds.length ?
      <div className="prompt-audio-list">{allIds.map(id => {
        const item = local.find(item => item.id === id);
        const server = remote.find(item => item.id === id);
        const active = activeIdRef.current === id;
        const date = item?.created_at || server?.created_at || "";
        const status = active ? "正在录音" : item && !item.ready ? "录音未完成" : server ? STATUS[server.status] : uploads[id] || "等待上传";
        const title = server?.text ? truncate(server.text.split(/\r?\n/).find(line => line.trim()) || server.text, 100) : status;
        return <details className="prompt-item prompt-audio-item" key={id} onToggle={event => {
          const open = event.currentTarget.open;
          setExpanded(previous => { const next = new Set(previous); if (open) next.add(id); else next.delete(id); return next; });
        }}>
          <summary>
            <span className="prompt-item-copy">
              <small className="prompt-item-meta" title={formatDate(date)}>{formatDate(date)}</small>
              <strong className="prompt-item-title">{title}</strong>
            </span>
            <span className="prompt-audio-actions" onClick={event => event.stopPropagation()}>
              {server ? <a className="button button-secondary button-sm prompt-audio-action" href={`${API_PATHS.prompts}/recordings/${encodePath(id)}/audio`} download>下载音频</a> : <Button size="sm" variant="secondary" className="prompt-audio-action" disabled>下载音频</Button>}
              <Button size="sm" variant="secondary" className="prompt-audio-action" disabled={disabled || !server?.text} onClick={() => { if (server?.text) onRestore(server.text); }}>恢复</Button>
              <Button size="sm" variant="secondary" className="prompt-audio-action" disabled={active || deleting.has(id) || server?.status === "processing"} aria-busy={deleting.has(id)} title={server?.status === "processing" ? "转写完成后可删除" : "删除此录音的本地副本和服务器归档"} onClick={() => void remove(id)}>删除</Button>
            </span>
            <span className="prompt-item-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div className="prompt-item-body">
            {server?.text ? <pre>{server.text}</pre> : <p className="muted" role="status">{status}</p>}
            {server?.error ? <p className="prompt-audio-error">{server.error}</p> : null}
            {!active && expanded.has(id) && (server || item?.size) ? <RecordingPlayer id={id} local={item} archived={!!server} converted={!!server && ["done", "waiting_config"].includes(server.status)} /> : null}
            <div className="prompt-audio-detail-meta">
              <span>{formatBytes(item?.size || server?.size)} · {item ? "本地副本已保留" : "服务器已归档"}</span>
              {!active && item && !item.ready ? <Button size="sm" variant="secondary" className="prompt-audio-action" onClick={() => void retry(id, undefined, true)}>继续上传</Button> : null}
              {!active && (!server || ["failed", "waiting_config"].includes(server.status)) && item?.ready !== false ? <Button size="sm" variant="secondary" className="prompt-audio-action" onClick={() => void retry(id, server)}>重试</Button> : null}
            </div>
          </div>
        </details>;
      })}</div>
      : <EmptyState title="暂无语音归档" detail="点击当前提示词右侧的语音输入按钮开始录音。" />}
    </Card>, archiveTarget) : null}
  </>;
}
