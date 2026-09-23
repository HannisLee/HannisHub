"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PCDLoader } from "three/addons/loaders/PCDLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { API_PATHS, apiFetch } from "../../lib/api";
import { errorMessage, formatBytes, formatDate } from "../../lib/format";
import type { FileManagerDirectoryOptionsResponse, PointCloudDataset, PointCloudDatasetsResponse, PointCloudFile } from "../../lib/types";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, LoadingState, PageHeader } from "../ui/primitives";

interface ViewerDetails {
  pointCount: number;
  hasColors: boolean;
}

const EMPTY_DATASETS: PointCloudDataset[] = [];

function cssColor(element: HTMLElement, token: string, fallback: string): string {
  return getComputedStyle(element).getPropertyValue(token).trim() || fallback;
}

function parseTextPointCloud(data: ArrayBuffer): THREE.BufferGeometry {
  const text = new TextDecoder().decode(data);
  const positions: number[] = [];
  const colors: number[] = [];
  let usesColor = true;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const values = trimmed.split(/[\s,]+/).map(Number);
    if (values.length < 3 || !values.slice(0, 3).every(Number.isFinite)) continue;
    positions.push(values[0], values[1], values[2]);
    if (values.length >= 6 && values.slice(3, 6).every(Number.isFinite)) {
      const scale = Math.max(values[3], values[4], values[5]) > 1 ? 255 : 1;
      colors.push(values[3] / scale, values[4] / scale, values[5] / scale);
    } else {
      usesColor = false;
    }
  }

  if (!positions.length) throw new Error("未能从文本点云中读取有效的 x、y、z 坐标");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (usesColor && colors.length === positions.length) {
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  }
  return geometry;
}

function parseGeometry(file: PointCloudFile, data: ArrayBuffer): THREE.BufferGeometry {
  switch (file.format.toLowerCase()) {
    case "ply":
      return new PLYLoader().parse(data);
    case "pcd":
      return new PCDLoader().parse(data).geometry;
    case "xyz":
    case "xyzn":
    case "xyzrgb":
    case "pts":
      return parseTextPointCloud(data);
    default:
      throw new Error(`暂不支持在浏览器中预览 .${file.format} 文件`);
  }
}

function PointCloudCanvas({
  file,
  pointSize,
  onLoaded,
  onError,
  onLoading,
}: {
  file: PointCloudFile;
  pointSize: number;
  onLoaded: (details: ViewerDetails) => void;
  onError: (message: string) => void;
  onLoading: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const materialRef = useRef<THREE.PointsMaterial | null>(null);
  const pointSizeRef = useRef(pointSize);
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  const onLoadingRef = useRef(onLoading);

  useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onLoadingRef.current = onLoading; }, [onLoading]);

  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    let disposed = false;
    let frame = 0;
    const scene = new THREE.Scene();
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(cssColor(mount, "--color-bg", "#141413"));
    renderer.domElement.className = "point-cloud-canvas";
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.target.set(0, 0, 0);

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    async function loadPointCloud() {
      onLoadingRef.current();
      try {
        const response = await fetch(file.url, { credentials: "include", cache: "no-store" });
        if (response.status === 401) {
          window.dispatchEvent(new CustomEvent("hannishub:unauthorized", { detail: window.location.pathname }));
          throw new Error("登录已过期");
        }
        if (!response.ok) throw new Error(`读取点云文件失败（${response.status}）`);
        const geometry = parseGeometry(file, await response.arrayBuffer());
        if (disposed) {
          geometry.dispose();
          return;
        }
        const position = geometry.getAttribute("position");
        if (!position || !position.count) {
          geometry.dispose();
          throw new Error("点云不包含可显示的顶点坐标");
        }
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (!box) {
          geometry.dispose();
          throw new Error("无法计算点云范围");
        }
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z, 1e-4);
        geometry.translate(-center.x, -center.y, -center.z);
        const hasColors = Boolean(geometry.getAttribute("color"));
        const material = new THREE.PointsMaterial({
          color: cssColor(mount, "--color-brand", "#D97757"),
          size: maxDimension * pointSizeRef.current * 0.003,
          sizeAttenuation: true,
          vertexColors: hasColors,
        });
        materialRef.current = material;
        scene.add(new THREE.Points(geometry, material));
        scene.add(new THREE.GridHelper(maxDimension * 1.2, 12, cssColor(mount, "--color-border", "#353431"), cssColor(mount, "--color-divider", "#302F2D")));
        const distance = maxDimension * 1.65;
        camera.near = Math.max(maxDimension / 10_000, 0.0001);
        camera.far = Math.max(maxDimension * 100, 10);
        camera.position.set(distance, distance * 0.72, distance);
        camera.updateProjectionMatrix();
        controls.maxDistance = maxDimension * 50;
        controls.target.set(0, 0, 0);
        controls.update();
        onLoadedRef.current({ pointCount: position.count, hasColors });
      } catch (error) {
        if (!disposed) onErrorRef.current(error instanceof Error ? error.message : "点云预览失败");
      }
    }

    void loadPointCloud();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      scene.traverse(object => {
        const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        renderable.geometry?.dispose();
        if (Array.isArray(renderable.material)) renderable.material.forEach(material => material.dispose());
        else renderable.material?.dispose();
      });
      materialRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [file]);

  useEffect(() => {
    if (materialRef.current) materialRef.current.size *= pointSize / pointSizeRef.current;
    pointSizeRef.current = pointSize;
  }, [pointSize]);

  return <div className="point-cloud-canvas-wrap" ref={mountRef} aria-label={`点云预览：${file.name}`} />;
}

function preferredFile(dataset: PointCloudDataset | undefined): PointCloudFile | undefined {
  return dataset?.files.find(file => file.viewable);
}

export function PointCloudsPanel() {
  const [data, setData] = useState<PointCloudDatasetsResponse | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [scopeOptions, setScopeOptions] = useState<FileManagerDirectoryOptionsResponse | null>(null);
  const [selectedRootIndex, setSelectedRootIndex] = useState(0);
  const [scope, setScope] = useState("");
  const [scopeQuery, setScopeQuery] = useState("");
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [query, setQuery] = useState("");
  const [pointSize, setPointSize] = useState(3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewerError, setViewerError] = useState("");
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerDetails, setViewerDetails] = useState<ViewerDetails | null>(null);

  const load = useCallback(async (rootIndex: number, nextScope: string, refresh = false) => {
    setLoading(true);
    try {
      const refreshText = refresh ? "&refresh=true" : "";
      const [settings, options, datasets] = await Promise.all([
        apiFetch<{ roots: string[] }>(`${API_PATHS.fileManager}/settings`),
        apiFetch<FileManagerDirectoryOptionsResponse>(`${API_PATHS.fileManager}/directories?root=${rootIndex}${refreshText}`),
        apiFetch<PointCloudDatasetsResponse>(`${API_PATHS.pointClouds}/datasets?root=${rootIndex}&scope=${encodeURIComponent(nextScope)}${refreshText}`),
      ]);
      setRoots(settings.roots || []);
      setScopeOptions(options);
      setData(datasets);
      setError("");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(selectedRootIndex, scope), 0);
    return () => window.clearTimeout(timer);
  }, [load, scope, selectedRootIndex]);

  const scopeChoices = useMemo(() => {
    const normalized = scopeQuery.trim().toLowerCase();
    const options = (scopeOptions?.directories || []).filter(option => option.path);
    const filtered = normalized
      ? options.filter(option => `${option.path} ${option.name}`.toLowerCase().includes(normalized))
      : options;
    if (scope && !filtered.some(option => option.path === scope)) {
      const current = options.find(option => option.path === scope);
      if (current) filtered.unshift(current);
    }
    return filtered.slice(0, 400);
  }, [scope, scopeOptions, scopeQuery]);

  const datasets = data?.datasets ?? EMPTY_DATASETS;
  const filteredDatasets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? datasets.filter(dataset => `${dataset.name} ${dataset.relative_path} ${dataset.root_path}`.toLowerCase().includes(normalized)) : datasets;
  }, [datasets, query]);

  const selectedDataset = datasets.find(dataset => dataset.id === selectedDatasetId) ?? datasets[0];
  const selectedFile = selectedDataset?.files.find(file => file.relative_path === selectedFilePath && file.viewable) ?? preferredFile(selectedDataset);

  function chooseDataset(id: string) {
    setSelectedDatasetId(id);
    setSelectedFilePath("");
    setViewerDetails(null);
    setViewerError("");
  }

  function chooseFile(relativePath: string) {
    setSelectedFilePath(relativePath);
    setViewerDetails(null);
    setViewerError("");
  }

  return (
    <>
      <PageHeader kicker="文件管理 / Point clouds" title="点云查看器" description="扫描范围来自文件管理组件，默认只暴露 ~/reproduce；可选择顶层文件夹或其中的子文件夹，自动按实验结果归并点云。" actions={<Button variant="secondary" onClick={() => void load(selectedRootIndex, scope, true)} disabled={loading}>重新扫描</Button>} />
      {error ? <ErrorState message={error} /> : null}
      <div className="stack-grid">
        <Card>
          <CardHeader title="扫描范围" description="浏览器只能读取文件管理组件已暴露目录之内的点云文件；默认仅暴露 ~/reproduce。" actions={<a className="text-link" href="/files">管理文件夹 →</a>} />
          <div className="point-cloud-settings">
            <Field label="顶层文件夹">
              <select value={selectedRootIndex} onChange={event => { setSelectedRootIndex(Number(event.target.value)); setScope(""); }}>
                {roots.map((root, index) => <option value={index} key={root}>{root}</option>)}
              </select>
            </Field>
            <Field label="子文件夹">
              <div className="point-cloud-scope">
                <input className="search-input" value={scopeQuery} onChange={event => setScopeQuery(event.target.value)} placeholder="搜索子文件夹" />
                <select value={scope} onChange={event => setScope(event.target.value)}>
                  <option value="">整个顶层文件夹</option>
                  {scopeChoices.map(option => <option value={option.path} key={option.path}>{option.path}</option>)}
                </select>
                {scopeOptions?.truncated ? <span className="muted-line">最多列出 {scopeOptions.max_directories} 个文件夹。</span> : null}
              </div>
            </Field>
            <div className="form-actions">
              <Button onClick={() => void load(selectedRootIndex, scope, true)} disabled={loading}>立即扫描</Button>
              <span className="muted-line">目录与扫描结果各有 15 秒服务端缓存；点击“立即扫描”会强制同步磁盘。</span>
            </div>
          </div>
        </Card>

        {loading ? <LoadingState label="正在扫描已配置的点云目录…" /> : <div className="point-cloud-workspace">
          <Card className="point-cloud-browser">
            <CardHeader title={`发现的文件夹 · ${datasets.length}`} description="已跳过 point_cloud、iteration 等通用层级，优先显示实验或结果目录。" actions={<input className="search-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件夹" />} />
            {data?.root_errors.length ? <div className="inline-message"><Badge tone="warning">目录异常</Badge>{data.root_errors.map(item => <span key={item.path}>{item.path}：{item.message}</span>)}</div> : null}
            {data?.scan_truncated ? <div className="inline-message"><Badge tone="warning">已截断</Badge><span>扫描最多展示 {data.max_scanned_files} 个点云文件；请缩小顶层目录范围。</span></div> : null}
            {filteredDatasets.length ? <div className="point-cloud-dataset-list">{filteredDatasets.map(dataset => (
              <button className={`point-cloud-dataset${dataset.id === selectedDataset?.id ? " is-selected" : ""}`} type="button" key={dataset.id} onClick={() => chooseDataset(dataset.id)} aria-pressed={dataset.id === selectedDataset?.id}>
                <span><strong>{dataset.name}</strong><small>{dataset.relative_path}</small></span>
                <span className="point-cloud-dataset-meta"><b>{dataset.file_count}</b><small>{formatBytes(dataset.total_size)}</small></span>
              </button>
            ))}</div> : <EmptyState title={datasets.length ? "没有匹配的文件夹" : "没有找到点云文件"} detail={datasets.length ? "尝试换一个搜索词。" : "先保存一个含点云文件的顶层目录，然后重新扫描。"} />}
          </Card>

          <Card className="point-cloud-preview-card">
            {selectedDataset ? <>
              <CardHeader eyebrow="已选文件夹" title={selectedDataset.name} description={`${selectedDataset.root_path} / ${selectedDataset.relative_path}`} actions={<Badge tone="info">{selectedDataset.formats.map(format => `.${format}`).join(" · ")}</Badge>} />
              <div className="point-cloud-file-picker" role="list" aria-label="点云文件列表">
                {selectedDataset.files.map(file => <button className={`point-cloud-file${file.relative_path === selectedFile?.relative_path ? " is-selected" : ""}`} type="button" key={file.relative_path} onClick={() => file.viewable && chooseFile(file.relative_path)} disabled={!file.viewable} title={file.viewable ? file.relative_path : `.${file.format} 暂不能直接在浏览器中解析`}>
                  <span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {formatDate(file.modified)}</small></span>
                  <Badge tone={file.viewable ? "success" : "warning"}>{file.viewable ? `.${file.format}` : `.${file.format} 待转换`}</Badge>
                </button>)}
              </div>
              {selectedFile ? <>
                <div className="point-cloud-toolbar">
                  <span>{viewerLoading ? "正在读取并解析点云…" : viewerDetails ? `${viewerDetails.pointCount.toLocaleString()} 个点${viewerDetails.hasColors ? " · 保留文件颜色" : " · 使用主题色"}` : "准备预览"}</span>
                  <div className="point-cloud-toolbar-actions">
                    <label>点大小 <input type="range" min="1" max="10" value={pointSize} onChange={event => setPointSize(Number(event.target.value))} /><b>{pointSize}</b></label>
                    <a className="button button-secondary button-sm" href={selectedFile.url} download>下载文件</a>
                  </div>
                </div>
                {viewerError ? <div className="point-cloud-viewer-error">{viewerError}</div> : null}
                <PointCloudCanvas file={selectedFile} pointSize={pointSize} onLoading={() => { setViewerLoading(true); setViewerError(""); }} onError={message => { setViewerLoading(false); setViewerError(message); }} onLoaded={details => { setViewerLoading(false); setViewerDetails(details); }} />
                <p className="point-cloud-help">左键拖动旋转视角，滚轮缩放，右键拖动平移；触控板可双指缩放和平移。</p>
              </> : <EmptyState title="没有可直接预览的文件" detail="当前支持 PLY、PCD、XYZ、XYZN、XYZRGB 和 PTS；LAS/LAZ 会保留在列表中但需要先转换。" />}
            </> : <EmptyState title="选择一个点云文件夹" detail="扫描完成后，在左侧点击实验或结果文件夹即可加载预览。" />}
          </Card>
        </div>}
      </div>
    </>
  );
}
