"use client";

/** 聊天窗口通用头像：聊天室、私聊与「我的房间」的头像设置共用。
 *  头像为空时显示名字首字（默认头像），也可以是一个 emoji，或上传后压缩的 data URL 图片。 */

/** 头像边长（像素），与后端 120 KB 上限匹配 */
export const AVATAR_SIZE = 96;

/** 预设 emoji 头像 */
export const PRESET_AVATARS = ["🐱", "🐶", "🦊", "🐼", "🐸", "🐧", "🦄", "🐙", "🐳", "🌵", "🍀", "🌙"];

/** 把用户选择的图片居中裁剪并压缩成 96×96 的 JPEG data URL */
export function resizeAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const context = canvas.getContext("2d");
      URL.revokeObjectURL(url);
      if (!context) {
        reject(new Error("浏览器不支持图片处理"));
        return;
      }
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取该图片"));
    };
    image.src = url;
  });
}

export function Avatar({ nickname, avatar, size = "md" }: { nickname: string; avatar?: string; size?: "sm" | "md" | "lg" }) {
  const className = `chat-avatar chat-avatar-${size}`;
  if (avatar?.startsWith("data:")) {
    // eslint-disable-next-line @next/next/no-img-element -- data URL 头像无需经过图片优化
    return <img className={className} src={avatar} alt="" />;
  }
  return <span className={className} aria-hidden="true">{avatar || (Array.from(nickname.trim())[0] ?? "?").toUpperCase()}</span>;
}

/** 聊天消息时间：当天只显示时分，否则带上月日 */
export function formatChatTime(seconds: number): string {
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
