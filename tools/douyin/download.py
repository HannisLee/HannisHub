"""把一条抖音公开视频保存为可转写的本地媒体。"""

import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx

TOOL_DIR = Path(__file__).resolve().parent
TOOL_PYTHON = TOOL_DIR / ".venv/bin/python"
SHORT_HOST = "v.douyin.com"
VIDEO_HOSTS = {"douyin.com", "www.douyin.com", "iesdouyin.com", "www.iesdouyin.com", "jingxuan.douyin.com"}
VIDEO_ID = re.compile(r"[0-9]{15,22}")
VIDEO_PATH = re.compile(r"/(?:(?:share|m)/)?video/([0-9]{15,22})/?")
SHORT_PATH = re.compile(r"/[A-Za-z0-9_-]{2,64}/?")


def parse_share_text(text: str) -> tuple[str, str | None]:
    """提取首个支持的链接，去掉分享跟踪参数。"""
    for candidate in re.findall(r'https://[^\s<>"，。！？；）]+', text):
        try:
            url = urlsplit(candidate.rstrip(".,;!)]"))
            if url.netloc == SHORT_HOST and SHORT_PATH.fullmatch(url.path):
                return f"https://{SHORT_HOST}{url.path}", None
            if url.netloc not in VIDEO_HOSTS:
                continue
            match = VIDEO_PATH.fullmatch(url.path)
            video_id = match[1] if match else parse_qs(url.query).get("modal_id", [""])[0]
            if VIDEO_ID.fullmatch(video_id):
                return f"https://www.douyin.com/video/{video_id}", video_id
        except ValueError:
            continue
    raise ValueError("请粘贴中国版抖音的单条视频链接或完整分享文案")


def resolve_video_id(source_url: str) -> str:
    """从短链首跳读取作品 ID，只向抖音短链域名发起请求。"""
    source_url, video_id = parse_share_text(source_url)
    if video_id:
        return video_id
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.head(source_url)
            if not response.is_redirect:
                with client.stream("GET", source_url) as response:
                    return _redirect_video_id(response)
    except httpx.HTTPError as exc:
        raise ValueError("暂时无法访问抖音短链接，请重试") from exc
    return _redirect_video_id(response)


def _redirect_video_id(response: httpx.Response) -> str:
    location = response.headers.get("location", "")
    if response.is_redirect and location:
        try:
            _, video_id = parse_share_text(location)
        except ValueError:
            pass
        if video_id:
            return video_id
    raise ValueError("抖音短链未指向可识别的视频，请尝试粘贴电脑版视频长链接")


def download_video(source_url: str, output_path: Path, max_bytes: int) -> dict:
    """在独立 Python 环境中运行下载器，并限制总耗时。"""
    if not TOOL_PYTHON.is_file():
        raise RuntimeError("抖音下载器尚未安装，请联系管理员")
    try:
        result = subprocess.run(
            [str(TOOL_PYTHON), str(Path(__file__).resolve()), source_url, str(output_path), str(max_bytes)],
            capture_output=True, text=True, timeout=240, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("抖音视频下载超时，请稍后重试") from exc
    try:
        payload = json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError("抖音下载器运行失败，请联系管理员") from exc
    if result.returncode:
        raise RuntimeError(payload["error"])
    return payload


def _fetch(source_url: str, output: Path, max_bytes: int) -> dict:
    # 延迟加载，Hub 进程不需要安装下载器的依赖。
    from dy_cli.engines.api_client import DouyinAPIClient, DouyinAPIError

    video_id = resolve_video_id(source_url)
    client = DouyinAPIClient(timeout=12)
    try:
        detail = client.get_video_detail(video_id)
        if str(detail.get("aweme_id") or detail.get("item_id") or "") != video_id:
            raise ValueError("抖音返回的作品与提交的链接不匹配")
        video = detail.get("video") or {}
        if not video or detail.get("images"):
            raise ValueError("该抖音作品未提供可下载的视频")
        # 优先下载作品自身的播放音轨。music 字段可能只是背景音乐。
        candidates = []
        for track in video.get("bit_rate_audio") or []:
            meta = track.get("audio_meta") or {}
            urls = meta.get("url_list") or {}
            candidates.append((meta.get("size"), [urls.get(key) for key in ("main_url", "backup_url", "fallback_url")]))
        for field in ("play_addr_265", "play_addr"):
            media = video.get(field) or {}
            candidates.append((media.get("data_size"), media.get("url_list") or []))
        for size, urls in candidates:
            if not urls or not isinstance(size, int) or not 0 < size <= max_bytes:
                continue
            if _download_ranges(client.client, urls, size, output) and _has_audio(output):
                break
        else:
            raise ValueError("未能下载包含可读取音轨的完整抖音媒体，请稍后重试")
    except (DouyinAPIError, httpx.HTTPError) as exc:
        raise ValueError("抖音未返回可下载的作品信息，请确认视频可公开播放") from exc
    finally:
        client.close()
    return {
        "title": str(detail.get("desc") or "").strip()[:160],
        "source_url": f"https://www.douyin.com/video/{video_id}",
    }


def _download_ranges(client: httpx.Client, urls: list, size: int, output: Path) -> bool:
    """按媒体元数据校验每个片段，遇到传输错误时切换到同一媒体的镜像。"""
    urls = [url for url in urls if isinstance(url, str) and url.startswith("https://")]
    chunk_size = 1024 * 1024
    with output.open("wb") as file:
        for start in range(0, size, chunk_size):
            end = min(start + chunk_size, size) - 1
            headers = {
                "Referer": "https://www.douyin.com/",
                "Accept-Encoding": "identity",
                "Range": f"bytes={start}-{end}",
            }
            for url in urls:
                try:
                    with client.stream("GET", url, headers=headers) as response:
                        if response.status_code != 206 or response.headers.get("content-range") != f"bytes {start}-{end}/{size}":
                            continue
                        block = response.read()
                        if len(block) == end - start + 1:
                            file.write(block)
                            break
                except httpx.HTTPError:
                    continue
            else:
                return False
    return True


def _has_audio(output: Path) -> bool:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
             "-of", "csv=p=0", str(output)],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("无法检查视频音轨，请确认 FFmpeg 可用") from exc
    return probe.returncode == 0 and probe.stdout.strip() == "audio"


if __name__ == "__main__":
    try:
        print(json.dumps(_fetch(sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])), ensure_ascii=False))
    except ValueError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
