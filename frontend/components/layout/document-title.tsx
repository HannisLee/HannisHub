"use client";

import { useEffect } from "react";

const SITE_NAME = "HannisHub";

/** 把当前模块名写入浏览器标签标题，例如「点云预览 · HannisHub」 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    document.title = title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`;
  }, [title]);
  return null;
}

export { SITE_NAME as SITE_TITLE };
