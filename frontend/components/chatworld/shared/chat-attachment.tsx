"use client";

import { useEffect } from "react";
import { uploadBinary } from "../../../lib/api";
import { formatBytes } from "../../../lib/format";
import type { ChatAttachment } from "../../../lib/types";
import { Icon } from "../../ui/icon";
import { Button } from "../../ui/primitives";

export const MAX_ATTACHMENT_MB = 50;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
/** 与后端一致：只有这些位图在页面内显示，其余按文件发送 */
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 读取本地图片尺寸，用于预留显示空间，避免图片加载后页面跳动 */
function readImageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** 按图片原始比例计算缩略图尺寸，最大 320×280 */
function thumbnailStyle(width?: number, height?: number) {
  if (!width || !height) return undefined;
  const scale = Math.min(1, 320 / width, 280 / height);
  return { width: Math.max(88, Math.round(width * scale)), aspectRatio: `${width} / ${height}` };
}

export async function uploadChatAttachment(
  path: string, file: File, previewUrl: string | undefined, onProgress: (percent: number) => void,
): Promise<ChatAttachment> {
  const headers: Record<string, string> = {
    "Content-Type": file.type || "application/octet-stream",
    "x-file-name": encodeURIComponent(file.name),
  };
  const size = previewUrl ? await readImageSize(previewUrl) : null;
  if (size) {
    headers["x-image-width"] = String(size.width);
    headers["x-image-height"] = String(size.height);
  }
  return uploadBinary<ChatAttachment>(path, file, headers, onProgress);
}

export type AttachmentDisplay = Pick<ChatAttachment, "name" | "size" | "kind" | "width" | "height"> & { id?: string; src?: string };
export type LightboxImage = { src: string; name: string; download?: string };

export function ChatAttachmentCard({ attachment, downloadHref, progress, onOpen }: {
  attachment: AttachmentDisplay;
  downloadHref?: string;
  progress?: number;
  onOpen: (image: LightboxImage) => void;
}) {
  const uploading = progress !== undefined;
  const download = downloadHref ? (
    <a className="chat-attachment-download" href={downloadHref} download={attachment.name} title="下载" aria-label={`下载 ${attachment.name}`}>
      <Icon name="download" />
    </a>
  ) : null;

  if (attachment.kind === "image" && attachment.src) {
    const src = attachment.src;
    return (
      <div className="chat-image" style={thumbnailStyle(attachment.width, attachment.height)}>
        <button type="button" className="chat-image-open" onClick={() => onOpen({ src, name: attachment.name, download: downloadHref })} aria-label={`查看 ${attachment.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 聊天附件为受保护的动态地址 */}
          <img src={src} alt={attachment.name} loading="lazy" />
        </button>
        {uploading ? <span className="chat-upload-overlay">{progress}%</span> : download}
      </div>
    );
  }
  return (
    <div className="chat-file">
      <span className="chat-file-icon"><Icon name="file" /></span>
      <span className="chat-file-info">
        <span className="chat-file-name" title={attachment.name}>{attachment.name}</span>
        <span className="chat-file-size">{uploading ? `上传中 ${progress}% · ` : ""}{formatBytes(attachment.size)}</span>
        {uploading ? <span className="chat-file-progress"><span style={{ width: `${progress}%` }} /></span> : null}
      </span>
      {download}
    </div>
  );
}

export function ChatLightbox({ lightbox, onClose }: { lightbox: LightboxImage; onClose: () => void }) {
  // 大图预览按 Esc 关闭
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="chat-lightbox" role="dialog" aria-label={lightbox.name} onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 聊天附件为受保护的动态地址 */}
      <img src={lightbox.src} alt={lightbox.name} onClick={event => event.stopPropagation()} />
      <div className="chat-lightbox-bar" onClick={event => event.stopPropagation()}>
        <span className="chat-lightbox-name">{lightbox.name}</span>
        {lightbox.download ? <a className="button button-secondary button-sm" href={lightbox.download} download={lightbox.name}>下载原图</a> : null}
        <Button size="sm" variant="quiet" onClick={onClose}>关闭</Button>
      </div>
    </div>
  );
}
