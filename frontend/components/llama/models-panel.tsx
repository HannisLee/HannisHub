"use client";

import { useEffect, useMemo, useState } from "react";
import { API_PATHS, apiFetch } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { ModelFile, ModelRepository } from "../../lib/types";
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader } from "../ui/primitives";

export function ModelsPanel() {
  const [models, setModels] = useState<ModelFile[]>([]);
  const [repositories, setRepositories] = useState<ModelRepository[]>([]);
  const [modelDir, setModelDir] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [modelData, repositoryData] = await Promise.all([
        apiFetch<{ models: ModelFile[]; model_dir: string }>(`${API_PATHS.llama}/models`),
        apiFetch<{ repositories: ModelRepository[] }>(`${API_PATHS.llama}/model-repositories`),
      ]);
      setModels(modelData.models || []);
      setModelDir(modelData.model_dir || "");
      setRepositories(repositoryData.repositories || []);
      setError("");
    } catch (value) { setError(errorMessage(value)); } finally { setLoading(false); }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? models.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(normalized)) : models;
  }, [models, query]);

  return (
    <>
      <PageHeader kicker="模型管理 / Models" title="模型与仓库" description="浏览本机 GGUF 文件和从 Hugging Face 全量下载的模型仓库。" actions={<a className="button button-primary button-md" href="/llama/downloads">下载模型</a>} />
      {error ? <ErrorState message={error} /> : null}
      <div className="subtle-path"><span>当前模型目录</span><code>{modelDir || "尚未设置"}</code></div>
      {loading ? <LoadingState /> : <div className="stack-grid">
        <Card>
          <CardHeader title={`GGUF 模型 · ${models.length}`} description="递归扫描模型目录中的 .gguf 文件。" actions={<><input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称或路径" /><button className="button button-secondary button-sm" type="button" onClick={() => void load()}>刷新</button></>} />
          {filteredModels.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th>路径</th></tr></thead><tbody>{filteredModels.map(model => <tr key={model.path}><td><strong>{model.name}</strong></td><td>{formatBytes(model.size)}</td><td>{formatDate(model.modified)}</td><td><code className="path-cell">{model.path}</code></td></tr>)}</tbody></table></div> : <EmptyState title="没有找到 GGUF 模型" detail={query ? "尝试换一个搜索词。" : "设置模型目录后，模型会出现在这里。"} />}
        </Card>
        <Card>
          <CardHeader title={`全量仓库 · ${repositories.length}`} description="保留仓库结构的下载目录，可用于 vLLM 等服务。" />
          {repositories.length ? <div className="repository-grid">{repositories.map(repo => <article className="repository-card" key={repo.path}><div className="repository-title"><strong>{repo.display_name}</strong><Badge tone={repo.has_model_files ? "success" : "neutral"}>{repo.has_model_files ? "含模型文件" : "目录"}</Badge></div><code>{repo.path}</code><div className="repository-meta"><span>{repo.has_config ? "有 config.json" : "无 config.json"}</span><span>{formatDate(repo.modified)}</span></div></article>)}</div> : <EmptyState title="没有全量仓库" detail="在下载页留空文件名即可下载整个仓库。" />}
        </Card>
      </div>}
    </>
  );
}
