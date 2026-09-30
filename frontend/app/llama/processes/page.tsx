import { AppShell } from "../../../components/layout/app-shell";
import { InferencePanel } from "../../../components/llama/inference-panel";

export default function ProcessesPage() {
  // 兼容旧链接：受管进程已合并到推理服务页面。
  return <AppShell><InferencePanel /></AppShell>;
}
