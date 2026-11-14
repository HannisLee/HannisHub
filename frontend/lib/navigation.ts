import type { IconName } from "../components/ui/icon";

export interface NavItem {
  href: string;
  label: string;
  /** 浏览器标签页标题，未设置时回退到 label */
  title?: string;
  icon: IconName;
  /** 仅管理员可见 */
  adminOnly?: boolean;
}

export interface NavGroup {
  /** 本地布局使用的稳定标识，排序与折叠状态都按它保存 */
  id: string;
  label: string;
  items: NavItem[];
}

export const navigation: NavGroup[] = [
  { id: "overview", label: "总览", items: [{ href: "/", label: "Overview", title: "总览", icon: "overview" }] },
  {
    id: "chatworld",
    label: "聊天大厅",
    items: [
      { href: "/chat-lobby", label: "聊天大厅", icon: "lobby" },
      { href: "/chat", label: "聊天室", icon: "chat" },
      { href: "/todo", label: "工位待办", icon: "tasks" },
    ],
  },
  { id: "prompts", label: "提示词", items: [{ href: "/prompts", label: "提示词", icon: "prompts" }] },
  {
    id: "models",
    label: "模型管理",
    items: [
      { href: "/llama/models", label: "推理服务", icon: "models" },
      { href: "/llama/gpu", label: "GPU 监控", icon: "gpu" },
      { href: "/llama/downloads", label: "模型下载", icon: "downloads" },
      { href: "/llama/asr", label: "ASR 转写", icon: "asr" },
      { href: "/llama/ocr", label: "OCR识别", icon: "documents" },
      { href: "/llama/settings", label: "模型设置", icon: "settings" },
    ],
  },
  // 远程服务器分组暂时从侧栏隐藏，页面与组件代码保留，取消注释即可恢复
  // {
  //   id: "server",
  //   label: "远程服务器",
  //   items: [
  //     { href: "/server/connections", label: "服务器连接", icon: "connections" },
  //     { href: "/server/tasks", label: "远程任务", icon: "tasks" },
  //   ],
  // },
  {
    id: "settings",
    label: "设置",
    items: [
      { href: "/settings", label: "AI 能力", icon: "settings" },
      { href: "/settings/users", label: "用户管理", icon: "users" },
      { href: "/files", label: "文件游览", icon: "files" },
      { href: "/files/server", label: "服务器文件", title: "服务器文件", icon: "downloads" },
      { href: "/files/documents", label: "文档查看", icon: "documents" },
      // 点云预览暂时从侧栏隐藏，页面与组件代码保留，取消注释即可恢复
      // { href: "/files/point-clouds", label: "点云预览", icon: "pointcloud" },
      { href: "/terminal", label: "终端", icon: "terminal", adminOnly: true },
    ],
  },
];

/** 取导航项对应的浏览器标签标题，未显式设置时使用导航标签 */
export function navTitle(item: NavItem): string {
  return item.title ?? item.label;
}

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/files") return pathname === "/files";
  if (href === "/settings") return pathname === "/settings" || pathname === "/settings/";
  if (href === "/files/point-clouds" && pathname === "/point-clouds") return true;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 管理员账号：可访问全部页面 */
export function isAdmin(username: string | null | undefined): boolean {
  return username === "lihan";
}

/** 普通账号登录后的默认页面，也是访问受限页面时的跳转目标 */
export const REGULAR_HOME = "/chat-lobby";

/** 普通用户只能使用聊天大厅、聊天室、ASR、OCR 和工位待办页面。 */
export function canVisitPage(username: string | null | undefined, pathname: string): boolean {
  return isAdmin(username)
    || [REGULAR_HOME, "/chat", "/llama/asr", "/llama/ocr", "/todo"].some(path => pathname === path || pathname === `${path}/`);
}
