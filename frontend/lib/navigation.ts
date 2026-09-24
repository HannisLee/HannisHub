import type { IconName } from "../components/ui/icon";

export interface NavItem {
  href: string;
  label: string;
  /** 浏览器标签页标题，未设置时回退到 label */
  title?: string;
  icon: IconName;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  { label: "总览", items: [{ href: "/", label: "Overview", title: "总览", icon: "overview" }] },
  {
    label: "模型管理",
    items: [
      { href: "/llama/models", label: "模型与仓库", icon: "models" },
      { href: "/llama/processes", label: "受管进程", icon: "processes" },
      { href: "/llama/gpu", label: "GPU 监控", icon: "gpu" },
      { href: "/llama/downloads", label: "模型下载", icon: "downloads" },
      { href: "/llama/asr", label: "ASR 转写", icon: "asr" },
      { href: "/llama/settings", label: "模型设置", icon: "settings" },
    ],
  },
  {
    label: "远程服务器",
    items: [
      { href: "/server/connections", label: "服务器连接", icon: "connections" },
      { href: "/server/tasks", label: "远程任务", icon: "tasks" },
    ],
  },
  {
    label: "文件管理",
    items: [
      { href: "/files", label: "文件游览", icon: "files" },
      { href: "/files/point-clouds", label: "点云预览", icon: "pointcloud" },
    ],
  },
  { label: "提示词", items: [{ href: "/prompts", label: "提示词工作区", title: "提示词", icon: "prompts" }] },
  { label: "设置", items: [{ href: "/settings", label: "AI 能力", icon: "settings" }] },
];

/** 取导航项对应的浏览器标签标题，未显式设置时使用导航标签 */
export function navTitle(item: NavItem): string {
  return item.title ?? item.label;
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/files") return pathname === "/files";
  if (href === "/files/point-clouds" && pathname === "/point-clouds") return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}
