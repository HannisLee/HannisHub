"use client";

import { useEffect } from "react";

const SITE_NAME = "HannisHub";

/** 把当前模块名写入浏览器标签标题，例如「点云预览 · HannisHub」；有未读聊天消息时加上「(3) 」前缀 */
export function DocumentTitle({ title, unread = 0 }: { title: string; unread?: number }) {
  useEffect(() => {
    const base = title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`;
    document.title = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base;
  }, [title, unread]);
  return null;
}

export { SITE_NAME as SITE_TITLE };
