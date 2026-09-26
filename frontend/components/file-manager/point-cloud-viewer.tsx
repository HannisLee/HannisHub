"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PCDLoader } from "three/addons/loaders/PCDLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

export interface PointCloudSource {
  name: string;
  format: string;
  url: string;
}

interface ViewerDetails {
  pointCount: number;
  hasColors: boolean;
  gaussian: boolean;
}

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

function parseGaussianPly(data: ArrayBuffer): THREE.BufferGeometry | null {
  const header = new TextDecoder().decode(data.slice(0, Math.min(data.byteLength, 65536)));
  const endMarker = header.indexOf("end_header");
  if (endMarker < 0 || !header.includes("format binary_little_endian")) return null;
  const headerEnd = header.indexOf("\n", endMarker);
  if (headerEnd < 0) return null;
  const lines = header.slice(0, headerEnd + 1).split(/\r?\n/);
  const vertexLine = lines.find(line => line.startsWith("element vertex "));
  const count = vertexLine ? Number(vertexLine.split(" ")[2]) : 0;
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const typeSizes: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const properties = new Map<string, { offset: number; type: string }>();
  let inVertex = false;
  let stride = 0;
  for (const line of lines) {
    if (line.startsWith("element ")) {
      inVertex = line.startsWith("element vertex ");
      continue;
    }
    if (!inVertex || !line.startsWith("property ")) continue;
    const [, type, name] = line.split(/\s+/);
    if (!typeSizes[type] || !name) return null;
    properties.set(name, { offset: stride, type });
    stride += typeSizes[type];
  }
  if (!["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0"].every(name => properties.has(name))) return null;
  if (headerEnd + 1 + count * stride > data.byteLength) throw new Error("Gaussian PLY 文件数据不完整");
  const view = new DataView(data);
  const read = (base: number, name: string): number => {
    const property = properties.get(name);
    if (!property) return 0;
    const offset = base + property.offset;
    switch (property.type) {
      case "float": case "float32": return view.getFloat32(offset, true);
      case "double": case "float64": return view.getFloat64(offset, true);
      case "uchar": case "uint8": return view.getUint8(offset);
      case "char": case "int8": return view.getInt8(offset);
      case "short": case "int16": return view.getInt16(offset, true);
      case "ushort": case "uint16": return view.getUint16(offset, true);
      case "int": case "int32": return view.getInt32(offset, true);
      default: return view.getUint32(offset, true);
    }
  };
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
  const sampleStep = Math.max(1, Math.ceil(count / 1_000_000));
  const capacity = Math.ceil(count / sampleStep);
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const opacity = new Float32Array(capacity);
  const scale = new Float32Array(capacity);
  let written = 0;
  for (let index = 0; index < count; index += sampleStep) {
    const base = headerEnd + 1 + index * stride;
    const x = read(base, "x"), y = read(base, "y"), z = read(base, "z");
    const alpha = sigmoid(read(base, "opacity"));
    if (![x, y, z, alpha].every(Number.isFinite) || alpha < 0.04) continue;
    const offset = written * 3;
    positions[offset] = x; positions[offset + 1] = y; positions[offset + 2] = z;
    for (let channel = 0; channel < 3; channel++) {
      const color = 0.5 + 0.2820947918 * read(base, `f_dc_${channel}`);
      colors[offset + channel] = clamp01(Number.isFinite(color) ? color : 0.5);
    }
    opacity[written] = alpha;
    const radius = Math.exp(Math.max(-12, Math.min(2, Math.max(read(base, "scale_0"), properties.has("scale_1") ? read(base, "scale_1") : read(base, "scale_0")))));
    scale[written] = Number.isFinite(radius) ? Math.max(0.001, Math.min(radius, 0.5)) : 0.01;
    written++;
  }
  if (!written) throw new Error("Gaussian PLY 不包含可显示的点");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions.subarray(0, written * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors.subarray(0, written * 3), 3));
  geometry.setAttribute("splatOpacity", new THREE.BufferAttribute(opacity.subarray(0, written), 1));
  geometry.setAttribute("splatScale", new THREE.BufferAttribute(scale.subarray(0, written), 1));
  return geometry;
}

function parseGeometry(file: PointCloudSource, data: ArrayBuffer): { geometry: THREE.BufferGeometry; gaussian: boolean } {
  switch (file.format.toLowerCase()) {
    case "ply": {
      const gaussian = parseGaussianPly(data);
      return { geometry: gaussian || new PLYLoader().parse(data), gaussian: Boolean(gaussian) };
    }
    case "pcd":
      return { geometry: new PCDLoader().parse(data).geometry, gaussian: false };
    case "xyz":
    case "xyzn":
    case "xyzrgb":
    case "pts":
      return { geometry: parseTextPointCloud(data), gaussian: false };
    default:
      throw new Error(`暂不支持在浏览器中预览 .${file.format} 文件`);
  }
}

function PointCloudCanvas({
  file,
  pointSize,
  colored,
  onLoaded,
  onError,
  onLoading,
  onProgress,
  loadingLabel,
}: {
  file: PointCloudSource;
  pointSize: number;
  colored: boolean;
  onLoaded: (details: ViewerDetails) => void;
  onError: (message: string) => void;
  onLoading: () => void;
  onProgress: (percent: number | null) => void;
  loadingLabel: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const materialRef = useRef<THREE.PointsMaterial | null>(null);
  const pointSizeRef = useRef(pointSize);
  const coloredRef = useRef(colored);
  const hasColorsRef = useRef(false);
  const redrawRef = useRef(true);
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  const onLoadingRef = useRef(onLoading);
  const onProgressRef = useRef(onProgress);

  useEffect(() => { onLoadedRef.current = onLoaded; }, [onLoaded]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onLoadingRef.current = onLoading; }, [onLoading]);
  useEffect(() => { onProgressRef.current = onProgress; }, [onProgress]);

  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    let disposed = false;
    let frame = 0;
    let lastDraw = 0;
    const abortController = new AbortController();
    let fallbackGeometry: THREE.BufferGeometry | null = null;
    let fallbackGaussian = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
    const overlay = document.createElement("canvas");
    overlay.className = "point-cloud-canvas point-cloud-canvas-overlay";
    mount.appendChild(overlay);
    const context = overlay.getContext("2d", { alpha: true });
    if (!context) {
      onErrorRef.current("浏览器无法创建点云画布");
      overlay.remove();
      return;
    }
    let renderer: THREE.WebGLRenderer | null = null;
    const controls = new OrbitControls(camera, overlay);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.target.set(0, 0, 0);
    controls.addEventListener("change", () => { redrawRef.current = true; });

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect();
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      overlay.width = Math.round(width * ratio);
      overlay.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderer?.setSize(width, height, false);
      redrawRef.current = true;
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const drawFallback = () => {
      if (!fallbackGeometry) return;
      const width = overlay.clientWidth;
      const height = overlay.clientHeight;
      if (!width || !height) return;
      context.clearRect(0, 0, width, height);
      camera.updateMatrixWorld();
      const positions = fallbackGeometry.getAttribute("position");
      const colors = fallbackGeometry.getAttribute("color");
      const opacities = fallbackGeometry.getAttribute("splatOpacity");
      const sampleStep = Math.max(1, Math.ceil(positions.count / 120_000));
      const points: Array<{ x: number; y: number; depth: number; size: number; color: string; alpha: number }> = [];
      const point = new THREE.Vector3();
      const view = new THREE.Vector3();
      const fallbackColor = cssColor(mount, "--color-brand", "#D97757");
      for (let index = 0; index < positions.count; index += sampleStep) {
        point.fromBufferAttribute(positions, index);
        view.copy(point).applyMatrix4(camera.matrixWorldInverse);
        const depth = -view.z;
        if (depth <= camera.near || depth >= camera.far) continue;
        point.project(camera);
        if (Math.abs(point.x) > 1.1 || Math.abs(point.y) > 1.1) continue;
        const size = Math.max(0.5, pointSizeRef.current * 0.9);
        const color = coloredRef.current && colors
          ? `rgb(${Math.round(Math.max(0.07, colors.getX(index)) * 255)} ${Math.round(Math.max(0.07, colors.getY(index)) * 255)} ${Math.round(Math.max(0.07, colors.getZ(index)) * 255)})`
          : fallbackColor;
        points.push({
          x: (point.x + 1) * width / 2,
          y: (1 - point.y) * height / 2,
          depth,
          size,
          color,
          alpha: fallbackGaussian && opacities ? Math.min(0.85, opacities.getX(index)) : 0.9,
        });
      }
      points.sort((left, right) => right.depth - left.depth);
      for (const point of points) {
        context.globalAlpha = point.alpha;
        context.fillStyle = point.color;
        context.fillRect(Math.round(point.x - point.size / 2), Math.round(point.y - point.size / 2), point.size, point.size);
      }
      context.globalAlpha = 1;
    };

    const animate = (now: number) => {
      frame = window.requestAnimationFrame(animate);
      controls.update();
      if (fallbackGeometry) {
        if (redrawRef.current && now - lastDraw >= 55) {
          drawFallback();
          redrawRef.current = false;
          lastDraw = now;
        }
      } else renderer?.render(scene, camera);
    };
    frame = window.requestAnimationFrame(animate);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      const points = scene.children.find(child => child instanceof THREE.Points) as THREE.Points | undefined;
      if (points) {
        fallbackGeometry = points.geometry;
        redrawRef.current = true;
      }
    };
    async function loadPointCloud() {
      onLoadingRef.current();
      try {
        const response = await fetch(file.url, { credentials: "include", cache: "no-store", signal: abortController.signal });
        if (response.status === 401) {
          window.dispatchEvent(new CustomEvent("hannishub:unauthorized", { detail: window.location.pathname }));
          throw new Error("登录已过期");
        }
        if (!response.ok) throw new Error(`读取点云文件失败（${response.status}）`);
        let bytes: ArrayBuffer;
        const total = Number(response.headers.get("content-length"));
        if (response.body && total > 0) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let received = 0;
          let lastPercent = -1;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
            const percent = Math.min(100, Math.floor(received / total * 100));
            if (!disposed && percent !== lastPercent) onProgressRef.current(percent);
            lastPercent = percent;
          }
          const merged = new Uint8Array(received);
          let offset = 0;
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
          bytes = merged.buffer;
        } else bytes = await response.arrayBuffer();
        if (!disposed) onProgressRef.current(null);
        const { geometry, gaussian } = parseGeometry(file, bytes);
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
        hasColorsRef.current = hasColors;
        const distance = maxDimension * 1.65;
        camera.near = Math.max(maxDimension / 10_000, 0.0001);
        camera.far = Math.max(maxDimension * 100, 10);
        if (gaussian) camera.position.set(0, 0, distance * 1.3);
        else camera.position.set(distance, distance * 0.72, distance);
        camera.updateProjectionMatrix();
        controls.maxDistance = maxDimension * 50;
        controls.target.set(0, 0, 0);
        controls.update();
        if (!gaussian) {
          try {
            renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.setClearColor(cssColor(mount, "--color-bg", "#141413"));
            renderer.domElement.className = "point-cloud-canvas";
            mount.insertBefore(renderer.domElement, overlay);
            renderer.domElement.addEventListener("webglcontextlost", onContextLost);
            resize();
          } catch {
            // 浏览器无 WebGL 时仍可使用二维画布预览。
            renderer?.domElement.remove();
            renderer?.dispose();
            renderer = null;
          }
        }
        if (gaussian || !renderer) {
          fallbackGeometry = geometry;
          fallbackGaussian = gaussian;
          redrawRef.current = true;
        } else {
          const material = new THREE.PointsMaterial({
            color: coloredRef.current && hasColors ? "#FFFFFF" : cssColor(mount, "--color-brand", "#D97757"),
            size: maxDimension * pointSizeRef.current * 0.003,
            sizeAttenuation: true,
            vertexColors: coloredRef.current && hasColors,
          });
          materialRef.current = material;
          scene.add(new THREE.Points(geometry, material));
          scene.add(new THREE.GridHelper(maxDimension * 1.2, 12, cssColor(mount, "--color-border", "#353431"), cssColor(mount, "--color-divider", "#302F2D")));
        }
        onLoadedRef.current({ pointCount: position.count, hasColors, gaussian });
      } catch (error) {
        if (!disposed) onErrorRef.current(error instanceof Error ? error.message : "点云预览失败");
      }
    }

    void loadPointCloud();
    return () => {
      disposed = true;
      abortController.abort();
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      scene.traverse(object => {
        const renderable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        renderable.geometry?.dispose();
        if (Array.isArray(renderable.material)) renderable.material.forEach(material => material.dispose());
        else renderable.material?.dispose();
      });
      if (fallbackGeometry && !scene.children.some(child => child instanceof THREE.Points && child.geometry === fallbackGeometry)) fallbackGeometry.dispose();
      materialRef.current = null;
      renderer?.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer?.dispose();
      renderer?.domElement.remove();
      overlay.remove();
    };
  }, [file]);

  useEffect(() => {
    if (materialRef.current) materialRef.current.size *= pointSize / pointSizeRef.current;
    pointSizeRef.current = pointSize;
    redrawRef.current = true;
  }, [pointSize]);

  useEffect(() => {
    coloredRef.current = colored;
    const material = materialRef.current;
    if (material) {
      material.vertexColors = colored && hasColorsRef.current;
      const mount = mountRef.current;
      material.color.set(material.vertexColors ? "#FFFFFF" : mount ? cssColor(mount, "--color-brand", "#D97757") : "#D97757");
      material.needsUpdate = true;
    }
    redrawRef.current = true;
  }, [colored]);

  return <div className="point-cloud-canvas-wrap" ref={mountRef} aria-label={`点云预览：${file.name}`}>
    {loadingLabel ? <div className="point-cloud-loading" role="status">{loadingLabel}</div> : null}
  </div>;
}

export function PointCloudViewer({ file, filePath, favoriteName, expanded, onToggleExpanded }: { file: PointCloudSource; filePath: string; favoriteName?: string; expanded: boolean; onToggleExpanded: () => void }) {
  const [pointSize, setPointSize] = useState(1);
  const [colored, setColored] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(0);
  const [details, setDetails] = useState<ViewerDetails | null>(null);

  return <div className="point-cloud-viewer">
    <div className="point-cloud-file-identity">
      {favoriteName ? <strong>{favoriteName}</strong> : null}
      <span title={filePath}>{filePath}</span>
    </div>
    <div className="point-cloud-toolbar">
      <span>{loading ? "正在读取并解析点云…" : details ? `${details.pointCount.toLocaleString()} 个点${details.gaussian ? " · Gaussian 预览" : details.hasColors ? " · 保留文件颜色" : " · 使用主题色"}` : "预览失败"}</span>
      <div className="point-cloud-toolbar-actions">
        <label>点大小 <input type="range" min="0.2" max="10" step="0.2" value={pointSize} onChange={event => setPointSize(Number(event.target.value))} /><b>{pointSize.toFixed(1)}</b></label>
        <button className="file-manager-filter" type="button" aria-pressed={colored} onClick={() => setColored(value => !value)}>{colored ? "文件颜色" : "主题单色"}</button>
        <button className="button button-secondary button-sm" type="button" onClick={onToggleExpanded}>{expanded ? "退出大屏" : "放大预览"}</button>
      </div>
    </div>
    {error ? <div className="point-cloud-viewer-error">{error}</div> : null}
    <PointCloudCanvas file={file} pointSize={pointSize} colored={colored} loadingLabel={loading ? progress === null ? "正在解析点云…" : `正在读取点云… ${progress}%` : ""} onLoading={() => { setLoading(true); setProgress(0); setError(""); setDetails(null); }} onProgress={setProgress} onError={message => { setLoading(false); setError(message); }} onLoaded={value => { setLoading(false); setDetails(value); }} />
    <p className="point-cloud-help">左键拖动旋转视角，滚轮缩放，右键拖动平移；触控板可双指缩放和平移。</p>
  </div>;
}
