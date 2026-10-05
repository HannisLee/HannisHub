"use client";

import { useEffect, useRef, useState } from "react";
import { API_PATHS, encodePath } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import { readLocalAudio } from "../../lib/prompt-audio";
import type { LocalRecording } from "../../lib/prompt-audio";
import { Button } from "../ui/primitives";

function timeLabel(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function RecordingPlayer({ id, local, archived, converted }: { id: string; local?: LocalRecording; archived: boolean; converted: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [source, setSource] = useState("");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const localId = local?.id;
  const mime = local?.mime_type;

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      // 收起详情时停止播放并取消音频加载，避免隐藏后继续发声。
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    if (archived) {
      // 服务端音频仅在展开详情后加载，收起条目不会批量加载历史录音。
      const timer = window.setTimeout(() => setSource(`${API_PATHS.prompts}/recordings/${encodePath(id)}/audio${converted ? "?converted=true" : ""}`), 0);
      return () => window.clearTimeout(timer);
    }
    if (localId && mime) void readLocalAudio({ id: localId, mime_type: mime }).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(blob); setSource(objectUrl); }
    }).catch(value => { if (active) setError(errorMessage(value)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, archived, converted, localId, mime]);

  async function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      setError("");
      if (audio.paused) await audio.play();
      else audio.pause();
    } catch (value) { setError(errorMessage(value)); }
  }

  return <div className="prompt-audio-player">
    <audio ref={audioRef} src={source || undefined} preload="metadata" hidden
      onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
      onError={() => setError("音频暂时无法播放，请重试或下载音频。")} />
    <Button size="sm" variant="secondary" className="prompt-audio-action prompt-audio-play" disabled={!source} aria-label={playing ? "暂停录音" : "播放录音"} onClick={() => void toggle()}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {playing ? <><path d="M9 5v14M15 5v14" /></> : <path d="m8 5 11 7-11 7V5Z" />}
      </svg>
    </Button>
    <span className="prompt-audio-time">{timeLabel(position)}</span>
    <input type="range" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration || 0)} disabled={!duration} aria-label="录音播放进度"
      onChange={event => { if (audioRef.current) { const time = Number(event.target.value); audioRef.current.currentTime = time; setPosition(time); } }} />
    <span className="prompt-audio-time">{timeLabel(duration)}</span>
    {error ? <small className="prompt-audio-play-error" role="alert">{error}</small> : null}
  </div>;
}
