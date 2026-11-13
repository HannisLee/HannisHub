"use client";

import { createContext, useContext } from "react";

/** 外壳向页面提供的登录信息：immersive 为 true 时页面整页显示，没有侧栏与顶栏，需要自行提供退出入口 */
export interface ShellInfo {
  username: string;
  admin: boolean;
  immersive: boolean;
  logout: () => Promise<void>;
}

export const ShellContext = createContext<ShellInfo | null>(null);

export function useShell(): ShellInfo | null {
  return useContext(ShellContext);
}
