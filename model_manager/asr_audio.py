"""本机与外部 ASR 共用的音频探测、静音分析和切片工具。"""

import math
import re
import subprocess
from pathlib import Path
from typing import Callable, Optional

ASR_MAX_CHUNK_SECONDS = 600
ASR_MIN_CHUNK_SECONDS = 15


def run_audio_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    """运行音频处理命令，并把常见失败转换为便于展示的信息。"""
    try:
        return subprocess.run(command, text=True, capture_output=True, check=True)
    except FileNotFoundError as exc:
        tool = Path(str(exc.filename or "FFmpeg")).name
        raise RuntimeError(
            f"未找到音频处理工具 {tool}。请安装 FFmpeg（Ubuntu/Debian："
            "sudo apt-get install ffmpeg）后重试"
        ) from exc
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or exc.stdout or "音频处理失败").strip()
        raise RuntimeError(message[-1200:]) from exc


def run_ffmpeg_with_progress(
    command: list[str], total_duration: float, on_progress: Optional[Callable[[float], None]] = None,
) -> str:
    """运行 FFmpeg，并从 progress 输出中回传处理比例。"""
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError as exc:
        tool = Path(str(exc.filename or "ffmpeg")).name
        raise RuntimeError(
            f"未找到音频处理工具 {tool}。请安装 FFmpeg（Ubuntu/Debian："
            "sudo apt-get install ffmpeg）后重试"
        ) from exc

    try:
        output_lines: list[str] = []
        if process.stderr is not None:
            for line in process.stderr:
                output_lines.append(line)
                if on_progress is None:
                    continue
                match = re.match(r"out_time_(?:us|ms)=(\d+)", line.strip())
                if match and total_duration > 0:
                    elapsed = int(match.group(1)) / 1_000_000
                    on_progress(max(0.0, min(1.0, elapsed / total_duration)))
        return_code = process.wait()
        output = "".join(output_lines)
        if return_code != 0:
            raise RuntimeError((output or "音频处理失败").strip()[-1200:])
        return output
    finally:
        if process.stderr is not None:
            process.stderr.close()


def probe_duration(input_path: Path) -> float:
    """使用 ffprobe 获取音频时长。"""
    try:
        result = run_audio_command([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(input_path),
        ])
    except RuntimeError as exc:
        detail = str(exc)
        # DASH 的独立 .m4s 媒体片段通常没有 moov 初始化信息，FFmpeg 无法仅凭
        # 一个分片还原音轨。这个情况与普通格式不支持不同，需要用户提供完整媒体。
        if input_path.suffix.lower() == ".m4s" and "moov atom not found" in detail.lower():
            raise RuntimeError(
                "这个 M4S 媒体片段缺少初始化信息，无法单独转码。请上传包含音轨信息的"
                "完整 MP4/M4A 文件，或先用对应的 MPD 与初始化段合并后再上传"
            ) from exc
        raise RuntimeError(
            "FFmpeg 无法识别或解码这个文件；可解码的媒体会自动切片后转写。"
            f"原始错误：{detail}"
        ) from exc
    try:
        duration = float(result.stdout.strip())
    except ValueError as exc:
        raise RuntimeError("无法读取音频时长") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError("音频时长无效")
    return duration


def speech_intervals(
    input_path: Path, total_duration: float, on_progress: Optional[Callable[[float], None]] = None,
) -> list[tuple[float, float]]:
    """通过静音检测取得语音段；检测失败时退回整段音频。"""
    try:
        output = run_ffmpeg_with_progress([
            "ffmpeg", "-hide_banner", "-nostats", "-progress", "pipe:2",
            "-vn", "-i", str(input_path), "-af", "silencedetect=noise=-35dB:d=0.6",
            "-f", "null", "-",
        ], total_duration, on_progress)
    except RuntimeError:
        return [(0.0, total_duration)]

    starts: list[float] = []
    ends: list[float] = []
    for line in output.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if start_match:
            starts.append(float(start_match.group(1)))
        elif end_match:
            ends.append(float(end_match.group(1)))

    intervals: list[tuple[float, float]] = []
    cursor = 0.0
    for index, silence_start in enumerate(starts):
        speech_end = max(cursor, min(silence_start, total_duration))
        if speech_end - cursor >= 0.3:
            intervals.append((cursor, speech_end))
        cursor = ends[index] if index < len(ends) else total_duration
    if total_duration - cursor >= 0.3:
        intervals.append((cursor, total_duration))
    return intervals or [(0.0, total_duration)]


def build_chunks(
    intervals: list[tuple[float, float]], total_duration: float,
    max_chunk_seconds: int = ASR_MAX_CHUNK_SECONDS,
) -> list[tuple[float, float]]:
    """按静音边界合并语音段，默认单片最长 10 分钟。"""
    chunks: list[tuple[float, float]] = []
    current_start: Optional[float] = None
    current_end: Optional[float] = None

    for start, end in intervals:
        while end - start > max_chunk_seconds:
            if current_start is not None and current_end is not None:
                chunks.append((current_start, current_end))
                current_start = current_end = None
            chunks.append((start, start + max_chunk_seconds))
            start += max_chunk_seconds
        if current_start is None:
            current_start, current_end = start, end
        elif end - current_start <= max_chunk_seconds:
            current_end = end
        else:
            chunks.append((current_start, current_end or start))
            current_start, current_end = start, end

    if current_start is not None and current_end is not None:
        chunks.append((current_start, min(current_end, total_duration)))
    return [(round(start, 3), round(end, 3)) for start, end in chunks if end > start]


def split_chunk(start: float, end: float, count: int) -> list[tuple[float, float]]:
    """将一个过大的时间段均分为多个连续片段。"""
    duration = end - start
    if count < 2 or duration <= 0:
        return [(start, end)]
    length = duration / count
    return [
        (round(start + length * index, 3), round(end if index == count - 1 else start + length * (index + 1), 3))
        for index in range(count)
    ]


def split_count_for_size(
    duration: float, file_size: int, target_chunk_bytes: int,
    min_chunk_seconds: int = ASR_MIN_CHUNK_SECONDS,
) -> int:
    """根据实际文件大小估算安全的二次切片数。"""
    by_size = math.ceil(file_size / target_chunk_bytes)
    by_duration = max(1, math.floor(duration / min_chunk_seconds))
    return min(max(2, by_size), by_duration)


def export_flac_chunk(input_path: Path, chunk_path: Path, start: float, end: float) -> int:
    """导出一个 FLAC 转写片段并返回其实际文件大小。"""
    run_audio_command([
        "ffmpeg", "-hide_banner", "-y", "-ss", f"{start:.3f}",
        "-t", f"{end - start:.3f}", "-i", str(input_path), "-vn",
        "-c:a", "flac", str(chunk_path),
    ])
    try:
        return chunk_path.stat().st_size
    except OSError as exc:
        raise RuntimeError("无法读取转写切片文件") from exc


def export_mp3_chunk(input_path: Path, chunk_path: Path, start: float, end: float) -> int:
    """导出外部 ASR 使用的 16 kHz 单声道 MP3 片段。"""
    run_audio_command([
        "ffmpeg", "-hide_banner", "-y", "-ss", f"{start:.3f}",
        "-t", f"{end - start:.3f}", "-i", str(input_path), "-vn",
        "-ac", "1", "-ar", "16000", "-codec:a", "libmp3lame", "-b:a", "64k", str(chunk_path),
    ])
    try:
        return chunk_path.stat().st_size
    except OSError as exc:
        raise RuntimeError("无法读取外部 ASR 切片文件") from exc
