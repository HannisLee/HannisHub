"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { API_PATHS, apiFetch, encodePath, uploadBinary } from "../../lib/api";
import { errorMessage, formatDate } from "../../lib/format";
import { appendAudioChunk, audioExtension, createLocalRecording, downloadAudio, listLocalRecordings, patchLocalRecording, readLocalAudio } from "../../lib/prompt-audio";
import type { LocalRecording, ServerRecording } from "../../lib/prompt-audio";
import { Button, Card, CardHeader, EmptyState, ErrorState } from "../ui/primitives";

const STATUS = { queued: "服务器已归档，等待处理", processing: "服务器转码 / 外部 ASR 转写中", waiting_config: "已归档，等待 ASR 配置", failed: "处理失败，可重试", done: "已归档并完成转写" };

function AudioPlayback({ item }: { item: LocalRecording }) {
  const [url, setUrl] = useState("");
  const { id, mime_type } = item;
  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void readLocalAudio({ id, mime_type }).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(() => {});
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, mime_type]);
  return url ? <audio controls preload="metadata" src={url} /> : null;
}

export function VoiceInput({ disabled, onText, onRecordingChange, archiveTarget }: { disabled: boolean; onText: (text: string) => void; onRecordingChange: (recording: boolean) => void; archiveTarget: HTMLElement | null }) {
  const [local, setLocal] = useState<LocalRecording[]>([]);
  const [remote, setRemote] = useState<ServerRecording[]>([]);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<Record<string, string>>({});
  const [emergency, setEmergency] = useState<{ blob: Blob; id: string } | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const syncRef = useRef(false);
  const nextAttemptRef = useRef<Record<string, { at: number; count: number }>>({});
  const textRef = useRef(onText);
  const recordingChangeRef = useRef(onRecordingChange);
  const aliveRef = useRef(true);
  const disabledRef = useRef(disabled);
  useEffect(() => { textRef.current = onText; recordingChangeRef.current = onRecordingChange; disabledRef.current = disabled; }, [onText, onRecordingChange, disabled]);

  const sync = useCallback(async () => {
    if (syncRef.current) return;
    syncRef.current = true;
    try {
      const locals = await listLocalRecordings();
      if (!aliveRef.current) return;
      setLocal(locals.sort((a, b) => b.created_at.localeCompare(a.created_at)));
      // 已持久化但未正常停止的录音必须由用户主动恢复，避免上传另一个标签页正在录的片段。
      for (const item of locals) {
        if (!item.ready || item.uploaded || !navigator.onLine || Date.now() < (nextAttemptRef.current[item.id]?.at || 0)) continue;
        try {
          const blob = await readLocalAudio(item);
          if (!blob.size || blob.size !== item.size) throw Error("本地音频不完整，请先下载检查");
          setUploads(current => ({ ...current, [item.id]: "上传中 0%" }));
          await uploadBinary<ServerRecording>(`${API_PATHS.prompts}/recordings/${encodePath(item.id)}`, blob, { "Content-Type": item.mime_type }, percent => {
            if (aliveRef.current) setUploads(current => ({ ...current, [item.id]: percent === 100 ? "服务器写入归档中…" : `上传中 ${percent}%` }));
          }, 300_000);
          await patchLocalRecording(item.id, { uploaded: true });
          setUploads(current => ({ ...current, [item.id]: "服务器已确认归档" }));
          delete nextAttemptRef.current[item.id];
        } catch (value) {
          const count = (nextAttemptRef.current[item.id]?.count || 0) + 1;
          nextAttemptRef.current[item.id] = { count, at: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(count, 6)) };
          setUploads(current => ({ ...current, [item.id]: `${errorMessage(value)}；本地已保留，稍后自动重试` }));
        }
      }
      const result = await apiFetch<{ recordings: ServerRecording[] }>(`${API_PATHS.prompts}/recordings`);
      if (!aliveRef.current) return;
      setRemote(result.recordings);
      const latest = await listLocalRecordings();
      for (const item of latest) {
        const server = result.recordings.find(server => server.id === item.id);
        if (server?.status === "done" && !item.applied && !disabledRef.current) {
          textRef.current(server.text);
          await patchLocalRecording(item.id, { applied: true });
          setNotice("语音转写已追加到提示词原文，本地与服务器音频均保留");
        }
      }
      setLocal((await listLocalRecordings()).sort((a, b) => b.created_at.localeCompare(a.created_at)));
      setError("");
    } catch (value) {
      if (aliveRef.current) setError(errorMessage(value));
    } finally { syncRef.current = false; }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const timer = window.setInterval(() => void sync(), 10_000);
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

  async function start() {
    if (starting || recorderRef.current?.state === "recording") return;
    setStarting(true);
    recordingChangeRef.current(true);
    setError("");
    setNotice("");
    let stream: MediaStream | null = null;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw Error("浏览器录音需要 HTTPS 或 localhost，请通过安全地址访问提示词页面");
      }
      await listLocalRecordings();
      // 请求浏览器尽量保留此站点的数据；即使未获准，也继续正常保存并提示实际状态。
      const persistent = await navigator.storage?.persist?.().catch(() => false);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!aliveRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const preferred = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find(mime => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      const id = `rec_${crypto.randomUUID()}`;
      await createLocalRecording({ id, created_at: new Date().toISOString(), mime_type: recorder.mimeType || preferred || "audio/webm", size: 0, chunks: 0, ready: false, uploaded: false, applied: false });
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
        setNotice("录音已停止，正在确认本地保存…");
        void writes.then(async () => {
          if (storageError) throw Error(storageError);
          await patchLocalRecording(id, { ready: true });
          setNotice("整段录音已保存到本地，将自动上传归档");
          if (aliveRef.current) void sync();
        }).catch(value => {
          setEmergency({ id, blob: new Blob(memoryChunks, { type: recorder.mimeType }) });
          setError(`本地存储失败：${errorMessage(value)}。请下载完整录音备份，再导入上传。`);
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
      setNotice(`开始录音 · 每秒保存本地分片${persistent ? " · 已启用持久存储" : " · 建议保留下载备份"}`);
      if ("speechSynthesis" in window) {
        const speech = new SpeechSynthesisUtterance("开始录音");
        speech.lang = "zh-CN";
        window.speechSynthesis.speak(speech);
      }
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

  async function importAudio(file: File) {
    try {
      if (!file.size || file.size > 512 * 1024 * 1024) throw Error("录音文件不能为空，最大 512 MB");
      const id = `rec_${crypto.randomUUID()}`;
      const extension = file.name.split(".").pop()?.toLowerCase();
      const mime = ({ webm: "audio/webm", m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav" }[extension || ""] || file.type.split(";")[0]);
      if (!["audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav"].includes(mime)) throw Error("请导入 WebM、M4A、MP3、OGG 或 WAV 录音");
      await createLocalRecording({ id, created_at: new Date().toISOString(), mime_type: mime, size: 0, chunks: 0, ready: false, uploaded: false, applied: false });
      await appendAudioChunk(id, file);
      await patchLocalRecording(id, { ready: true });
      void sync();
    } catch (value) { setError(errorMessage(value)); }
  }

  const allIds = [...new Set([...local.map(item => item.id), ...remote.map(item => item.id)])];
  return <div className="prompt-voice-input">
    <div className="row-actions">
      <Button size="sm" variant={recording ? "danger" : "secondary"} disabled={starting || (!recording && (disabled || !!emergency))}
        onClick={() => recording ? recorderRef.current?.stop() : void start()}>
        {starting ? "正在保存 / 准备…" : recording ? `停止录音 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "语音输入"}
      </Button>
      <label className="prompt-audio-import">导入录音<input type="file" accept="audio/*,.webm,.m4a,.mp3,.ogg,.wav" disabled={recording || starting || disabled} onChange={event => {
        const file = event.target.files?.[0]; if (file) void importAudio(file); event.target.value = "";
      }} /></label>
      <span className="muted" role="status">{notice || "停止录音后自动上传；断网时保留本地音频"}</span>
    </div>
    {error ? <ErrorState message={error} /> : null}
    {emergency ? <div className="row-actions"><Button size="sm" onClick={() => downloadAudio(emergency.blob, `${emergency.id}.${audioExtension(emergency.blob.type)}`)}>下载完整录音备份</Button><Button size="sm" variant="quiet" onClick={() => { setEmergency(null); setError(""); }}>备份完成，继续录音</Button><span className="muted">完整录音暂在内存中，请先下载，避免刷新页面。</span></div> : null}
    {archiveTarget ? createPortal(<Card className="prompt-settings-card prompt-audio-history">
      <CardHeader title={`语音归档 · ${allIds.length}`} description="本地与服务器录音，支持试听、下载和转写重试。" />
      {allIds.length ? <>
      <p className="muted">本地录音保存在当前浏览器与站点中，上传成功也不会删除。清理站点数据会删除本地副本，请按需下载备份。</p>
      <div className="prompt-audio-list">{allIds.map(id => {
        const item = local.find(item => item.id === id);
        const server = remote.find(item => item.id === id);
        const active = activeIdRef.current === id;
        const date = item?.created_at || server?.created_at || "";
        return <div className="prompt-audio-item" key={id}>
          <div className="prompt-audio-meta"><strong>{formatDate(date)}</strong><span>{((item?.size || server?.size || 0) / 1024 / 1024).toFixed(2)} MB · {item ? "有本地副本" : "仅服务器副本"}</span></div>
          <p role="status">{active ? "正在录音并保存本地分片" : item && !item.ready ? "录音未正常结束或正在其他标签页录制，可恢复已保存部分" : server ? STATUS[server.status] : uploads[id] || "本地已保存，等待上传"}</p>
          {server?.error ? <p className="muted">{server.error}</p> : null}
          <div className="row-actions">
            {item && !active ? <Button size="sm" variant="quiet" onClick={() => void readLocalAudio(item).then(blob => downloadAudio(blob, `${id}.${audioExtension(item.mime_type)}`)).catch(value => setError(errorMessage(value)))}>下载本地原音频</Button> : null}
            {server ? <a href={`${API_PATHS.prompts}/recordings/${encodePath(id)}/audio`}>下载服务器原音频</a> : null}
            {server && ["done", "waiting_config"].includes(server.status) ? <a href={`${API_PATHS.prompts}/recordings/${encodePath(id)}/audio?converted=true`}>下载转码归档</a> : null}
            {!active && item && !item.ready ? <Button size="sm" variant="secondary" onClick={() => void retry(id, undefined, true)}>恢复已保存音频并上传</Button> : null}
            {!active && (!server || ["failed", "waiting_config"].includes(server.status)) && item?.ready !== false ? <Button size="sm" variant="secondary" onClick={() => void retry(id, server)}>重试</Button> : null}
            {server?.text ? <Button size="sm" variant="quiet" disabled={disabled} onClick={() => textRef.current(server.text)}>追加转写到提示词</Button> : null}
          </div>
          {!active && item?.size ? <AudioPlayback item={item} /> : server ? <audio controls preload="none" src={`${API_PATHS.prompts}/recordings/${encodePath(id)}/audio`} /> : null}
          {server?.text ? <details><summary>查看转写文本</summary><pre>{server.text}</pre></details> : null}
        </div>;
      })}</div>
      </> : <EmptyState title="暂无语音归档" detail="点击语音输入录音，或导入已有录音。" />}
    </Card>, archiveTarget) : null}
  </div>;
}
