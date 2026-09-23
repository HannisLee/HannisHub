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

function parseGeometry(file: PointCloudSource, data: ArrayBuffer): THREE.BufferGeometry {
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
  file: PointCloudSource;
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

export function PointCloudViewer({ file }: { file: PointCloudSource }) {
  const [pointSize, setPointSize] = useState(3);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [details, setDetails] = useState<ViewerDetails | null>(null);

  return <>
    <div className="point-cloud-toolbar">
      <span>{loading ? "正在读取并解析点云…" : details ? `${details.pointCount.toLocaleString()} 个点${details.hasColors ? " · 保留文件颜色" : " · 使用主题色"}` : "预览失败"}</span>
      <div className="point-cloud-toolbar-actions">
        <label>点大小 <input type="range" min="1" max="10" value={pointSize} onChange={event => setPointSize(Number(event.target.value))} /><b>{pointSize}</b></label>
        <a className="button button-secondary button-sm" href={file.url} download>下载文件</a>
      </div>
    </div>
    {error ? <div className="point-cloud-viewer-error">{error}</div> : null}
    <PointCloudCanvas file={file} pointSize={pointSize} onLoading={() => { setLoading(true); setError(""); setDetails(null); }} onError={message => { setLoading(false); setError(message); }} onLoaded={value => { setLoading(false); setDetails(value); }} />
    <p className="point-cloud-help">左键拖动旋转视角，滚轮缩放，右键拖动平移；触控板可双指缩放和平移。</p>
  </>;
}
