"use client";

import { useEffect, useState } from "react";
import { API_PATHS, apiFetch, jsonBody } from "../../lib/api";
import { errorMessage } from "../../lib/format";
import type {
  AiConnectionConfig,
  AiConnectionTestResult,
  AiModelTestResult,
  AiSettings,
  AiUsageResponse,
  AiUsageSummary,
} from "../../lib/types";
import { Badge, Button, Card, CardHeader, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

const EMPTY_SETTINGS: AiSettings = {
  ai_configs: [],
  active_ai_config_id: "",
};

function localConfigId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueModels(models: string[]) {
  return Array.from(new Set(models.map(model => model.trim()).filter(Boolean)));
}

function formatUsageNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatUsagePercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
}

function formatUsageTime(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

export function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettings>(EMPTY_SETTINGS);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<string, string>>({});
  const [clearKeyIds, setClearKeyIds] = useState<Record<string, boolean>>({});
  const [customModels, setCustomModels] = useState("");
  const [status, setStatus] = useState("");
  const [modelStatus, setModelStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState("");
  const [discoveringModels, setDiscoveringModels] = useState("");
  const [testingModel, setTestingModel] = useState("");
  const [usageByConfig, setUsageByConfig] = useState<Record<string, AiUsageSummary>>({});
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState("");

  async function load() {
    try {
      const data = await apiFetch<AiSettings>(API_PATHS.aiSettings);
      setSettings(data);
      setSelectedConfigId(data.active_ai_config_id || data.ai_configs[0]?.id || "");
      setApiKeyDrafts({});
      setClearKeyIds({});
      setCustomModels("");
      setError("");
      void loadUsage();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const selectedConfig = settings.ai_configs.find(config => config.id === selectedConfigId) || settings.ai_configs[0] || null;

  function updateConfig(configId: string, changes: Partial<AiConnectionConfig>) {
    setSettings(current => ({
      ...current,
      ai_configs: current.ai_configs.map(config => config.id === configId ? { ...config, ...changes } : config),
    }));
    setModelStatus("");
    setError("");
  }

  function addConfig() {
    const id = localConfigId();
    const config: AiConnectionConfig = {
      id,
      name: `配置 ${settings.ai_configs.length + 1}`,
      base_url: "",
      model: "",
      models: [],
      api_key_configured: false,
    };
    setSettings(current => ({
      ...current,
      ai_configs: [...current.ai_configs, config],
      active_ai_config_id: current.active_ai_config_id || id,
    }));
    setSelectedConfigId(id);
    setStatus("");
    setError("");
  }

  function removeConfig(configId: string) {
    setSettings(current => {
      const configs = current.ai_configs.filter(config => config.id !== configId);
      const activeId = current.active_ai_config_id === configId ? configs[0]?.id || "" : current.active_ai_config_id;
      return { ai_configs: configs, active_ai_config_id: activeId };
    });
    if (selectedConfigId === configId) {
      setSelectedConfigId(settings.ai_configs.find(config => config.id !== configId)?.id || "");
    }
    setApiKeyDrafts(current => {
      const next = { ...current };
      delete next[configId];
      return next;
    });
    setClearKeyIds(current => {
      const next = { ...current };
      delete next[configId];
      return next;
    });
  }

  async function saveSettings(nextSettings: AiSettings, successMessage: string) {
    setSaving(true);
    try {
      const data = await apiFetch<AiSettings>(API_PATHS.aiSettings, {
        method: "PUT",
        body: jsonBody({
          active_ai_config_id: nextSettings.active_ai_config_id,
          ai_configs: nextSettings.ai_configs.map(config => ({
            ...config,
            api_key: apiKeyDrafts[config.id] || "",
            clear_api_key: Boolean(clearKeyIds[config.id]),
          })),
        }),
      });
      setSettings(data);
      setSelectedConfigId(current => data.ai_configs.some(config => config.id === current)
        ? current
        : data.active_ai_config_id || data.ai_configs[0]?.id || "");
      setApiKeyDrafts({});
      setClearKeyIds({});
      setStatus(successMessage);
      setError("");
      return data;
    } catch (value) {
      setError(errorMessage(value));
      throw value;
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    try {
      const saved = await saveSettings(settings, "AI 配置已保存到本机 ai_settings.json");
      const configId = saved.ai_configs.find(config => config.id === selectedConfigId)?.id
        || saved.active_ai_config_id
        || saved.ai_configs[0]?.id
        || "";
      if (configId) await loadUsage(configId);
    } catch {
      // 错误已在 saveSettings 中写入页面状态。
    }
  }

  async function loadUsage(configId = "") {
    const targetId = configId.trim();
    setUsageLoading(true);
    try {
      const query = targetId ? `?config_id=${encodeURIComponent(targetId)}` : "";
      const data = await apiFetch<AiUsageResponse>(`${API_PATHS.aiSettings}/usage${query}`);
      setUsageByConfig(current => {
        const next = { ...current };
        for (const usage of data.usages) next[usage.config_id] = usage;
        return next;
      });
      setUsageError("");
    } catch (value) {
      setUsageError(errorMessage(value));
    } finally {
      setUsageLoading(false);
    }
  }

  async function activateConfig(configId: string) {
    const next = { ...settings, active_ai_config_id: configId };
    setSettings(next);
    setSelectedConfigId(configId);
    try {
      const config = settings.ai_configs.find(item => item.id === configId);
      await saveSettings(next, `已切换为「${config?.name || configId}」`);
    } catch {
      // 保存失败时保留本地选择，便于用户修正后重试。
    }
  }

  function addCustomModels() {
    if (!selectedConfig) return;
    const additions = customModels
      .split(/[\n,，;；]+/)
      .map(model => model.trim())
      .filter(Boolean);
    if (!additions.length) {
      setError("请先输入要添加的模型名称");
      return;
    }
    const models = uniqueModels([...selectedConfig.models, ...additions]);
    updateConfig(selectedConfig.id, { models, model: selectedConfig.model || additions[0] });
    setCustomModels("");
    setStatus(`已加入 ${additions.length} 个可选模型；保存后生效`);
  }

  function removeModel(model: string) {
    if (!selectedConfig) return;
    const models = selectedConfig.models.filter(item => item !== model);
    updateConfig(selectedConfig.id, {
      models,
      model: selectedConfig.model === model ? "" : selectedConfig.model,
    });
  }

  function applyDiscoveredConfig(configId: string, result: AiConnectionTestResult) {
    if (!result.config) return;
    setSettings(current => ({
      ...current,
      ai_configs: current.ai_configs.map(config => config.id === configId
        ? { ...config, models: result.config?.models || config.models, model: result.config?.model || config.model }
        : config),
    }));
  }

  async function discoverModelList(config: AiConnectionConfig, isConnectionTest = false) {
    if (isConnectionTest) setTestingConnection(config.id);
    else setDiscoveringModels(config.id);
    try {
      const savedSettings = await saveSettings(
        settings,
        isConnectionTest ? `已保存「${config.name}」，正在测试链接…` : `已保存「${config.name}」，正在探查模型…`,
      );
      const savedConfig = savedSettings.ai_configs.find(item => item.id === config.id) || config;
      const result = await apiFetch<AiConnectionTestResult>(`${API_PATHS.aiSettings}/models`, {
        method: "POST",
        body: jsonBody({ config_id: savedConfig.id }),
      });
      applyDiscoveredConfig(savedConfig.id, result);
      setStatus(result.message);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingConnection("");
      setDiscoveringModels("");
    }
  }

  async function testCurrentModel(config: AiConnectionConfig) {
    if (!config.model.trim()) {
      setModelStatus("");
      setError(`请先为「${config.name}」选择或输入模型名称`);
      return;
    }
    setTestingModel(config.id);
    try {
      const savedSettings = await saveSettings(settings, `已保存「${config.name}」，正在测试模型…`);
      const savedConfig = savedSettings.ai_configs.find(item => item.id === config.id) || config;
      const result = await apiFetch<AiModelTestResult>(`${API_PATHS.aiSettings}/model-test`, {
        method: "POST",
        body: jsonBody({ config_id: savedConfig.id, model: savedConfig.model }),
      });
      setModelStatus(result.response ? `${result.message}：${result.response}` : result.message);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setTestingModel("");
    }
  }

  function renderConfigButton(config: AiConnectionConfig) {
    const isActive = config.id === settings.active_ai_config_id;
    const isSelected = config.id === selectedConfig?.id;
    return (
      <button
        type="button"
        key={config.id}
        className={`ai-config-chip${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
        onClick={() => setSelectedConfigId(config.id)}
        title={config.base_url || "尚未填写 API 地址"}
      >
        <span>{config.name || "未命名配置"}</span>
        <small>{config.model || config.base_url || "未配置"}</small>
      </button>
    );
  }

  function renderUsageEntry(entry: AiUsageSummary["entries"][number], index: number) {
    const percent = entry.used_percent === null || entry.used_percent === undefined
      || !Number.isFinite(entry.used_percent)
      ? null
      : entry.used_percent;
    const barWidth = percent === null ? 0 : Math.min(100, Math.max(0, percent));
    const percentText = formatUsagePercent(percent);
    const resetTime = formatUsageTime(entry.resets_at);
    const unit = entry.unit?.trim() || "";
    const quotaText = entry.remaining !== null && entry.remaining !== undefined
      ? entry.total !== null && entry.total !== undefined
        ? `剩余 ${formatUsageNumber(entry.remaining)} / ${formatUsageNumber(entry.total)}${unit}`
        : `剩余 ${formatUsageNumber(entry.remaining)}${unit}`
      : entry.used !== null && entry.used !== undefined && entry.total !== null && entry.total !== undefined
        ? `已用 ${formatUsageNumber(entry.used)} / ${formatUsageNumber(entry.total)}${unit}`
        : "";
    return (
      <div className="ai-usage-entry" key={`${entry.label}-${index}`}>
        <div className="ai-usage-entry-head">
          <strong>{entry.label}</strong>
          <small>{percentText || "暂无占比"}</small>
        </div>
        {quotaText ? <span className="ai-usage-value">{quotaText}</span> : null}
        {percent !== null ? (
          <div className="ai-usage-progress" role="img" aria-label={`${entry.label}已用 ${percentText}`}>
            <span style={{ width: `${barWidth}%` }} />
          </div>
        ) : null}
        {resetTime ? <small className="ai-usage-reset">{resetTime} 重置</small> : null}
      </div>
    );
  }

  function renderUsage(config: AiConnectionConfig) {
    const usage = usageByConfig[config.id];
    return (
      <section className="ai-usage field-wide" aria-label={`${config.name}剩余用量`}>
        <div className="ai-models-head">
          <span>剩余用量</span>
          <small>{usage?.supported && usage.level ? `GLM ${usage.level}` : "按服务商能力自适应展示"}</small>
        </div>
        <div className="ai-usage-body">
          {usageError ? <p className="ai-usage-message is-error">{usageError}</p> : null}
          {!usageError && usageLoading && !usage ? <p className="ai-usage-message">正在读取剩余用量…</p> : null}
          {!usageError && (!usageLoading || usage) && !usage ? (
            <p className="ai-usage-message">保存配置后可读取剩余用量。</p>
          ) : null}
          {usage && !usage.supported ? <p className="ai-usage-message">{usage.message || "该服务暂无用量接口"}</p> : null}
          {usage?.supported && usage.message && !usage.entries.length ? (
            <p className="ai-usage-message is-error">{usage.message}</p>
          ) : null}
          {usage?.supported && usage.entries.length ? (
            <div className="ai-usage-list">
              {usage.entries.map(renderUsageEntry)}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void loadUsage(config.id)}
          disabled={usageLoading}
        >
          {usageLoading ? "用量读取中…" : "刷新用量"}
        </Button>
      </section>
    );
  }

  function renderSelectedConfig(config: AiConnectionConfig) {
    const isActive = config.id === settings.active_ai_config_id;
    const apiKey = apiKeyDrafts[config.id] || "";
    const clearKey = Boolean(clearKeyIds[config.id]);
    return (
      <Card>
        <CardHeader
          title={config.name || "未命名配置"}
          description={isActive ? "当前 AI 任务正在使用这个配置。" : "编辑配置后点击“保存配置”；要启用它请点击“设为当前使用”。"}
          actions={
            <>
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存配置"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void activateConfig(config.id)} disabled={isActive || saving}>
                {isActive ? "当前使用" : "设为当前使用"}
              </Button>
              <Button size="sm" variant="danger" onClick={() => removeConfig(config.id)} disabled={saving}>
                删除
              </Button>
            </>
          }
        />
        <div className="form-grid">
          <Field label="配置名称">
            <input
              value={config.name}
              onChange={event => updateConfig(config.id, { name: event.target.value })}
              placeholder="例如 DeepSeek / OpenAI / 本地 vLLM"
            />
          </Field>
          <Field label="API 地址">
            <input
              type="url"
              value={config.base_url}
              onChange={event => updateConfig(config.id, { base_url: event.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </Field>
          <Field label="当前使用模型" hint="可以从下方选择，也可以直接输入未知模型名">
            <input
              list={`ai-model-options-${config.id}`}
              value={config.model}
              onChange={event => updateConfig(config.id, { model: event.target.value })}
              placeholder="例如 deepseek-flash"
            />
            <datalist id={`ai-model-options-${config.id}`}>
              {config.models.map(item => <option value={item} key={item}>{item}</option>)}
            </datalist>
          </Field>
          <Field label="API 密钥" hint={config.api_key_configured ? "已保存；留空则保持不变" : "不会回显已保存的密钥，可留空"}>
            <input
              type="password"
              value={apiKey}
              onChange={event => setApiKeyDrafts(current => ({ ...current, [config.id]: event.target.value }))}
              placeholder={config.api_key_configured ? "已保存，留空则不修改" : "可留空"}
            />
          </Field>
          <label className="check-choice">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={event => setClearKeyIds(current => ({ ...current, [config.id]: event.target.checked }))}
            />
            清除此配置的密钥
          </label>

          {renderUsage(config)}

          <section className="ai-models field-wide" aria-label={`${config.name}可选模型`}>
            <div className="ai-models-head">
              <span>可选模型列表</span>
              <small>{config.models.length ? `${config.models.length} 个 · 保存后持久保留` : "可探查或手工添加"}</small>
            </div>
            {config.models.length ? (
              <div className="ai-model-list">
                {config.models.map(item => (
                  <div className={`ai-model-chip${config.model === item ? " is-selected" : ""}`} key={item}>
                    <button type="button" onClick={() => updateConfig(config.id, { model: item })} title={`使用 ${item}`}>
                      <span>{item}</span>
                    </button>
                    <button type="button" className="ai-model-remove" onClick={() => removeModel(item)} title={`移除 ${item}`}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ai-models-empty">探查结果和手工添加的模型会保存在这个配置里；未知模型名也可以直接填入上方输入框。</p>
            )}
            <div className="ai-model-add">
              <textarea
                value={customModels}
                onChange={event => setCustomModels(event.target.value)}
                placeholder={"手工添加可选模型，每行一个；也可以用逗号分隔\n例如 my-private-model"}
                rows={3}
              />
              <Button type="button" variant="secondary" size="sm" onClick={addCustomModels}>添加模型</Button>
            </div>
          </section>

          <div className="ai-action-grid field-wide">
            <Button variant="secondary" size="sm" onClick={() => void discoverModelList(config, true)} disabled={saving || Boolean(testingConnection || discoveringModels)}>
              {testingConnection === config.id ? "测试链接中…" : "测试链接"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void discoverModelList(config)} disabled={saving || Boolean(testingConnection || discoveringModels)}>
              {discoveringModels === config.id ? "探查中…" : "探查模型列表"}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void testCurrentModel(config)} disabled={saving || Boolean(testingModel)}>
              {testingModel === config.id ? "测试模型中…" : "测试模型"}
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return <>
    <PageHeader
      kicker="设置 / AI"
      title="AI 能力设置"
      description="维护任意多个 OpenAI 兼容 API 配置，并随时切换当前使用的配置。每个配置都有独立的模型、密钥和可持久保存的可选模型列表。"
    />
    {error ? <ErrorState message={error} /> : null}
    {status ? <div className="inline-message"><Badge tone="success">接口</Badge>{status}</div> : null}
    {modelStatus ? <div className="inline-message"><Badge tone="success">模型</Badge>{modelStatus}</div> : null}
    {loading ? <LoadingState /> : (
      <div className="stack-grid ai-settings-stack">
        <Card>
          <CardHeader
            title="配置列表"
            description="点击配置进入编辑；“设为当前使用”会立即保存并切换 AI 任务实际使用的配置。"
            actions={<Button size="sm" onClick={addConfig} disabled={saving}>添加配置</Button>}
          />
          {settings.ai_configs.length ? (
            <div className="ai-config-list">
              {settings.ai_configs.map(renderConfigButton)}
            </div>
          ) : (
            <p className="muted-line">还没有 AI 配置。点击“添加配置”开始。</p>
          )}
        </Card>
        {selectedConfig ? renderSelectedConfig(selectedConfig) : null}
        <p className="muted-line">密钥和模型列表只保存在本机被 Git 忽略的 ai_settings.json；AI 任务只会使用标记为“当前使用”的配置。</p>
      </div>
    )}
  </>;
}
