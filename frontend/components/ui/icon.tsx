import type { ReactNode, SVGProps } from "react";

export type IconName = "overview" | "models" | "processes" | "gpu" | "downloads" | "asr" | "settings" | "connections" | "tasks" | "prompts" | "files" | "pointcloud";

const paths: Record<IconName, ReactNode> = {
  overview: <><path d="M3 11.5 12 4l9 7.5v8.25a.75.75 0 0 1-.75.75H15v-5.25H9v5.25H3.75a.75.75 0 0 1-.75-.75Z" /></>,
  models: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h4" /></>,
  processes: <><path d="M5 4v16M5 12h6M11 12l3-3M11 12l3 3M15 7h4v12h-4" /></>,
  gpu: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4M9 9h6v6H9z" /></>,
  downloads: <><path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16" /></>,
  asr: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.68 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7.02 15a1.7 1.7 0 0 0-1.56-1.03h-.08v-3h.08A1.7 1.7 0 0 0 7.02 9.94 1.7 1.7 0 0 0 6.68 8.06L6.62 8 8.74 5.88l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.08h3v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19.8 8l-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.08v3h-.08A1.7 1.7 0 0 0 19.4 15Z" /></>,
  connections: <><path d="M9.5 14.5 7 17a3 3 0 0 1-4.24-4.24l3-3A3 3 0 0 1 10 9.5M14.5 9.5 17 7a3 3 0 0 1 4.24 4.24l-3 3A3 3 0 0 1 14 14.5M8.5 15.5l7-7" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5M8 17h8" /></>,
  prompts: <><path d="M5 4.5h14v12H9l-4 3v-15Z" /><path d="M8 8h8M8 12h5" /></>,
  files: <><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h3.2l1.8 2h8A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z" /><path d="M8 12h8M8 16h5" /></>,
  pointcloud: <><circle cx="6" cy="8" r="1.5" /><circle cx="12" cy="5" r="1.5" /><circle cx="18" cy="9" r="1.5" /><circle cx="9" cy="16" r="1.5" /><circle cx="16" cy="18" r="1.5" /><path d="m7.25 8.75 3.5-2.5m2.5.25 3.5 1.75m-8.5 6.5 1.5-5m2.5 7 3.5-6" /></>,
};

export function Icon({ name, title, ...props }: SVGProps<SVGSVGElement> & { name: IconName; title?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...props}>{title ? <title>{title}</title> : null}{paths[name]}</svg>;
}
