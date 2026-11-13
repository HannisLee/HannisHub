"use client";

import { useEffect, useRef } from "react";
import { createLobbyGame } from "./game/create-game";
import type { LobbyBridge, LobbyEvents } from "./game/layout";

interface LobbyCanvasProps {
  bridge: LobbyBridge;
  events: LobbyEvents;
}

/** 挂载 Phaser 游戏的容器；组件卸载时销毁游戏，避免重复进入页面时残留循环与监听。
 *  events 通过 ref 转发，回调变化不会重建游戏。 */
export default function LobbyCanvas({ bridge, events }: LobbyCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const relay: LobbyEvents = {
      onProgress: value => eventsRef.current.onProgress?.(value),
      onReady: () => eventsRef.current.onReady?.(),
      onError: message => eventsRef.current.onError?.(message),
      onRoomChange: room => eventsRef.current.onRoomChange?.(room),
      onNearby: machine => eventsRef.current.onNearby?.(machine),
      onInteract: machine => eventsRef.current.onInteract?.(machine),
    };
    const game = createLobbyGame(el, bridge, relay);
    return () => game.destroy();
  }, [bridge]);

  return <div ref={host} className="lobby-canvas-host" />;
}
