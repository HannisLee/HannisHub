import { DocumentTitle } from "../components/layout/document-title";

export default function NotFound() {
  return (
    <main className="not-found">
      <DocumentTitle title="页面不存在" />
      <p className="eyebrow">404 / HannisHub</p>
      <h1>页面不存在</h1>
      <p>这个工作区路径还没有对应的模块。</p>
      {/* 由 Hub 按当前登录账号重定向首页。 */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="button button-primary button-md" href="/">返回首页</a>
    </main>
  );
}
