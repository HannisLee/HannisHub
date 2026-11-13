import Phaser from "phaser";
import { LobbyScene, type LobbySceneOptions } from "./lobby-scene";

export interface LobbyGameHandle {
  destroy: () => void;
}

/** 在指定容器内创建 Phaser 游戏实例；返回销毁句柄供 React 卸载时清理。 */
export function createLobbyGame(parent: HTMLElement, opts: LobbySceneOptions): LobbyGameHandle {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    pixelArt: true,
    roundPixels: true,
    backgroundColor: "#141413",
    audio: { noAudio: true },
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    physics: { default: "arcade", arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    scene: [new LobbyScene(opts)],
  });
  return {
    destroy() {
      game.destroy(true);
    },
  };
}