import Link from "next/link";

export default function NotFound() {
  return <main className="not-found"><p className="eyebrow">404 / HannisHub</p><h1>页面不存在</h1><p>这个工作区路径还没有对应的模块。</p><Link className="button button-primary button-md" href="/">回到总览</Link></main>;
}
