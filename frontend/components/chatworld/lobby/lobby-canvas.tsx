"use client";

import { useEffect, useRef } from "react";
import { createLobbyGame } from "./game/create-game";
import type { TouchState } from "./game/player";

interface LobbyCanvasProps {
  touch: TouchState;
  onProgress: (value: number) => void;
  onReady: () => void;
  onError: (message: string) => void;
}

/** 挂载 Phaser 游戏的容器；组件卸载时销毁游戏，避免重复进入页面时残留循环与监听。 */
export default function LobbyCanvas({ touch, onProgress, onReady, onError }: LobbyCanvasProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const game = createLobbyGame(el, { touch, onProgress, onReady, onError });
    return () => game.destroy();
  }, [touch, onProgress, onReady, onError]);

  return <div ref={host} className="lobby-canvas-host" />;
}