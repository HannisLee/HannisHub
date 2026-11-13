#!/usr/bin/env python3
"""聊天大厅（俱乐部风格）素材与布局构建脚本。

从本机付费素材包 chatworld/asset/modern_interiors/（Limezu Modern Interiors，不入库）提取派生素材，
输出到 frontend/public/chat-lobby/club/：

- foyer.png / room.png / hall.png：各房间的烘焙背景（地板、墙面、墙顶收边、区域地毯、墙面挂饰）
- objects.png + objects.json：可遮挡家具的图集（Phaser JSON Hash 格式）
- anims/*.png：动画物件帧条
- avatar/*.png + avatar/parts.json：角色生成器分层部件（身体、眼睛、服装、发型、配饰），前端运行时叠层合成
- layout.json：房间尺寸、家具坐标、碰撞盒、传送门、出生点、交互机器（前端运行时读取）

layout.json 与 avatar/parts.json 带有 build 字段（素材内容哈希）。前端总是重新获取这两个清单，
并给其余素材加 ?v=<build>：重新构建后浏览器不会把缓存的旧图集与新坐标表混用（否则家具会错位）。

布局只在本脚本中维护；修改后重新运行即可，前端无需改代码。
用法：python3 scripts/build_chat_lobby_assets.py [--preview 预览图路径]
依赖 Pillow（仅本地构建时需要，不是后端运行依赖）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageSequence

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "chatworld" / "asset" / "modern_interiors"
OUT = ROOT / "frontend" / "public" / "chat-lobby" / "club"
T = 16

# ---------------------------------------------------------------- 素材读取

SINGLES = "1_Interiors/16x16/Theme_Sorter_Singles/"
SINGLE_PATTERNS = {
    "living": SINGLES + "2_Living_Room_Singles/Living_Room_Singles_{}.png",
    "basement": SINGLES + "14_Basement_Singles/Basement_Singles_{}.png",
    "class": SINGLES + "5_Classroom_and_Library_Singles/Classroom_and_Library_Singles_{}.png",
    "conf": SINGLES + "13_Conference_Hall_Singles/Conference_Hall_Singles_{}.png",
    "studio": SINGLES + "23_Television_and_Film_Studio_SIngles/Television_and_FIlm_Studio_Singles_{}.png",
}
GENERIC = "1_Interiors/16x16/Theme_Sorter/1_Generic_16x16.png"
BEDROOM = "1_Interiors/16x16/Theme_Sorter/4_Bedroom_16x16.png"
CHARGEN = "2_Characters/Character_Generator/"
FLOORS = "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Floors_16x16.png"
WALLS = "1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Walls_16x16.png"
ANIM_DIR = "3_Animated_objects/16x16/spritesheets/"
UI_DIR = "4_User_Interface_Elements/Animated_Spritesheets/"

_cache: dict[str, Image.Image] = {}


def load(rel: str) -> Image.Image:
    if rel not in _cache:
        _cache[rel] = Image.open(PACK / rel).convert("RGBA")
    return _cache[rel]


def single(theme: str, n: int) -> Image.Image:
    return load(SINGLE_PATTERNS[theme].format(n))


def flood(rel: str, x: int, y: int, gap: int = 1) -> Image.Image:
    """在没有单件拆图的总表上，从种子点泛洪取出完整单件（容忍 gap 像素的透明缝）。"""
    im = load(rel)
    w, h = im.size
    alpha = im.getchannel("A").load()
    seed = None
    for r in range(12):
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                if 0 <= x + dx < w and 0 <= y + dy < h and alpha[x + dx, y + dy] > 0:
                    seed = (x + dx, y + dy)
                    break
            if seed:
                break
        if seed:
            break
    if seed is None:
        raise ValueError(f"{rel} 在 ({x},{y}) 附近没有像素")
    seen = {seed}
    queue = deque([seed])
    x0 = x1 = seed[0]
    y0 = y1 = seed[1]
    while queue:
        cx, cy = queue.popleft()
        x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
        for dx in range(-gap - 1, gap + 2):
            for dy in range(-gap - 1, gap + 2):
                p = (cx + dx, cy + dy)
                if 0 <= p[0] < w and 0 <= p[1] < h and p not in seen and alpha[p] > 0:
                    seen.add(p)
                    queue.append(p)
    return im.crop((x0, y0, x1 + 1, y1 + 1))


def crop(rel: str, box: tuple[int, int, int, int]) -> Image.Image:
    return load(rel).crop(box)


def trimmed(rel: str, box: tuple[int, int, int, int]) -> Image.Image:
    """裁剪后再去掉四周透明边（用于相邻物件间距太小、泛洪会粘连的总表）。"""
    img = crop(rel, box)
    return img.crop(img.getbbox())


# ---------------------------------------------------------------- 素材清单

# 可遮挡家具（进图集，按底边深度排序）
OBJECTS: dict[str, Image.Image] = {}


def build_objects() -> None:
    o = OBJECTS
    # 工位
    o["desk"] = single("living", 51)
    o["desk_plain"] = single("living", 53)
    o["chair_task"] = single("conf", 39)
    o["chair_office"] = crop(GENERIC, (64, 1008, 80, 1024))
    o["chair_office_brown"] = crop(GENERIC, (64, 1024, 80, 1040))
    o["chair_office_white"] = crop(GENERIC, (64, 1040, 80, 1056))
    o["chair_office_green"] = crop(GENERIC, (112, 1040, 128, 1056))
    o["lamp_desk_blue"] = single("living", 73)
    o["lamp_desk_cream"] = single("living", 74)
    o["plant_desk"] = single("living", 15)
    # 绿植与灯
    o["plant_big"] = single("living", 18)
    o["plant_palm"] = single("living", 14)
    o["plant_tall"] = single("living", 13)
    o["plant_tall2"] = single("living", 17)
    o["plant_pot"] = single("living", 16)
    o["lamp_floor"] = single("living", 87)
    o["lamp_floor_red"] = single("living", 82)
    # 收纳
    o["bookshelf"] = single("class", 57)
    o["bookshelf_wide"] = single("class", 60)
    o["bar_shelf"] = single("class", 43)
    o["sideboard"] = single("living", 30)
    o["globe"] = single("class", 34)
    # 前台
    o["reception_left"] = single("class", 49)
    o["reception_mid"] = single("class", 50)
    o["reception_right"] = single("class", 52)
    # OCR 文档终端：自助终端 + 复印机
    o["kiosk"] = single("conf", 41)
    o["copier"] = single("conf", 43)
    o["trash"] = single("conf", 53)
    # ASR 录音台：音频工作台 + 录音话筒
    o["audio_desk"] = single("basement", 194)
    o["mic"] = single("studio", 7)
    # 休闲
    o["armchair_yellow"] = single("basement", 202)
    o["armchair_white"] = single("basement", 203)
    o["armchair_red"] = single("basement", 204)
    o["armchair_blue"] = single("basement", 205)
    o["egg_white"] = single("basement", 210)
    o["egg_yellow"] = single("basement", 211)
    o["egg_blue"] = single("basement", 212)
    o["egg_red"] = single("basement", 213)
    o["table_round"] = single("basement", 1)
    o["table_round_dark"] = single("basement", 2)
    o["sofa_gray"] = single("basement", 29)
    o["sofa_white"] = single("basement", 32)
    o["sofa_blue"] = single("basement", 35)
    o["tv_console"] = single("basement", 195)
    o["arcade_a"] = single("basement", 218)
    o["arcade_b"] = single("basement", 219)
    o["pinball"] = single("basement", 221)
    o["pool_table"] = single("basement", 76)
    o["bench"] = flood(GENERIC, 8, 264)
    # 高脚凳（大厅圆桌聊天角）
    o["stool_blue"] = single("basement", 103)
    o["stool_yellow"] = single("basement", 105)
    o["stool_wood"] = single("basement", 113)
    # 我的房间：单人床、床头柜、衣柜、穿衣镜
    o["bed_blue"] = flood(BEDROOM, 215, 365)
    o["nightstand"] = trimmed(BEDROOM, (128, 1140, 144, 1166))
    o["wardrobe"] = trimmed(BEDROOM, (128, 1572, 160, 1618))
    o["mirror"] = trimmed(GENERIC, (224, 1040, 240, 1084))


# 墙面挂饰与地毯（直接烘焙进背景，永远在人物下方）
DECALS: dict[str, Image.Image] = {}


def build_decals() -> None:
    d = DECALS
    d["window_curtain"] = flood(GENERIC, 200, 732)
    d["window_curtain_gray"] = flood(GENERIC, 152, 732)
    d["painting_aqua"] = flood(GENERIC, 76, 224)
    d["painting_sunset"] = flood(GENERIC, 44, 224)
    d["painting_forest"] = flood(GENERIC, 24, 224)
    d["string_lights"] = single("living", 12)
    d["world_map"] = single("class", 31)
    d["cork_board"] = single("class", 33)
    d["portrait_a"] = single("conf", 54)
    d["portrait_b"] = single("conf", 55)
    d["rug_red_gold"] = flood(GENERIC, 152, 88)
    d["rug_blue_gold"] = flood(GENERIC, 152, 124)
    d["rug_purple"] = flood(GENERIC, 216, 360)
    d["rug_green"] = flood(GENERIC, 24, 716)
    d["rug_beige"] = flood(GENERIC, 24, 748)


# 动画帧条：键 -> (源图像, 帧宽, 帧高, 帧率)
ANIMS: dict[str, dict] = {}


def gif_strip(rel: str) -> Image.Image:
    gif = Image.open(PACK / rel)
    frames = [f.convert("RGBA") for f in ImageSequence.Iterator(gif)]
    w, h = frames[0].size
    strip = Image.new("RGBA", (w * len(frames), h))
    for i, f in enumerate(frames):
        strip.paste(f, (i * w, 0))
    return strip


def rotate_frames(strip: Image.Image, size: int, method: Image.Transpose) -> Image.Image:
    """帧条逐帧旋转（帧为正方形）。"""
    out = Image.new("RGBA", strip.size)
    for i in range(strip.width // size):
        out.paste(strip.crop((i * size, 0, (i + 1) * size, size)).transpose(method), (i * size, 0))
    return out


def build_anims() -> None:
    a = ANIMS

    def add(key: str, img: Image.Image, fw: int, fh: int, rate: int, door: dict | None = None) -> None:
        a[key] = {"image": img, "frameWidth": fw, "frameHeight": fh, "frameRate": rate}
        if door:
            # 自动门：靠近时播放 open 帧序列，离开时播放 close 帧序列
            a[key]["door"] = door

    add("door_glass", load(ANIM_DIR + "animated_door_glass_double.png"), 32, 48, 14,
        door={"open": [0, 1, 2, 3, 4], "close": [5, 6, 7, 0]})
    add("elevator", load(ANIM_DIR + "animated_elevator_door_entrance_1.png"), 32, 32, 10)
    add("receptionist", load(ANIM_DIR + "animated_receptionist.png"), 16, 32, 5)
    add("monitor", load(ANIM_DIR + "animated_control_room_facebook_scrolling.png"), 16, 32, 4)
    add("speaker", load(ANIM_DIR + "animated_amplifier_big.png"), 16, 48, 6)
    add("server", load(ANIM_DIR + "animated_control_room_server.png"), 16, 48, 3)
    add("doc_screen", load(ANIM_DIR + "animated_hospital_screen_color.png"), 32, 32, 3)
    add("coffee", load(ANIM_DIR + "animated_coffee.png"), 16, 32, 6)
    add("cat", load(ANIM_DIR + "animated_cat.png"), 48, 16, 6)
    add("fishtank", load(ANIM_DIR + "animated_fishtank_orange.png"), 32, 32, 6)
    add("clock", load(ANIM_DIR + "animated_cuckoo_clock.png"), 16, 32, 2)
    arrow_down = gif_strip(UI_DIR + "UI_arrow_pointing_down_16x16.gif")
    add("arrow_down", arrow_down, 16, 16, 8)
    # 出口指引的其他方向：向上用官方素材，向左由向下箭头逐帧旋转（90° 旋转对像素图无损）
    add("arrow_left", rotate_frames(arrow_down, 16, Image.Transpose.ROTATE_270), 16, 16, 8)
    add("arrow_up", gif_strip(UI_DIR + "UI_arrow_pointing_up.gif"), 16, 16, 8)
    # 声纹屏：截取 X 光机监视器的波形区域（14 帧），作为 ASR 录音台的挂墙示波器
    xray = load(ANIM_DIR + "animated_hospital_xraymachine.png")
    frames = xray.width // 72
    wave = Image.new("RGBA", (16 * frames, 16))
    for i in range(frames):
        wave.paste(xray.crop((i * 72, 6, i * 72 + 16, 22)), (i * 16, 0))
    add("wave_screen", wave, 16, 16, 8)


# ---------------------------------------------------------------- 房间绘制

VOID = (20, 20, 19, 255)          # 与页面背景 #141413 一致，房间外融入舞台
OUTLINE = (43, 40, 52, 255)       # 墙顶描边
CAP = (233, 226, 212, 255)        # 墙顶（俯视看到的墙厚）
SHADOW = (24, 18, 30)


def floor_tex(col: int, row: int) -> Image.Image:
    """Room_Builder_Floors 中 3x2 砖块组（48x32），按列/行号（瓦片单位）取。"""
    return crop(FLOORS, (col * T, row * T, col * T + 48, row * T + 32))


def wall_tex(col: int, row: int) -> Image.Image:
    """Room_Builder_Walls 中单列墙面（16x32），按列/行号取中段，可水平平铺。"""
    return crop(WALLS, (col * T, row * T, col * T + T, row * T + 32))


def tile_fill(dst: Image.Image, tex: Image.Image, box: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = box
    region = Image.new("RGBA", (x1 - x0, y1 - y0))
    for y in range(0, y1 - y0, tex.height):
        for x in range(0, x1 - x0, tex.width):
            region.paste(tex, (x, y))
    dst.paste(region, (x0, y0))


def shade(dst: Image.Image, box: tuple[int, int, int, int], alpha: int, color=SHADOW) -> None:
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return
    layer = Image.new("RGBA", (x1 - x0, y1 - y0), (*color, alpha))
    dst.alpha_composite(layer, (x0, y0))


class Room:
    def __init__(self, rid: str, name: str, cols: int, rows: int, floor: Image.Image, wall: Image.Image):
        self.id = rid
        self.name = name
        self.w = cols * T
        self.h = rows * T
        self.bg = Image.new("RGBA", (self.w, self.h), VOID)
        self.floor = floor
        self.wall = wall
        self.props: list[dict] = []
        self.anims: list[dict] = []
        self.walls: list[list[int]] = []
        self.portals: list[dict] = []
        self.spawns: dict[str, dict] = {}
        self.machines: list[dict] = []
        self.doors: list[dict] = []
        self.signs: list[dict] = []
        self.bottom_openings: list[tuple[int, int]] = []
        self.top_openings: list[tuple[int, int]] = []
        # 左右墙开口（纵向区间 y0..y1，须位于墙面以下的地板段）
        self.left_openings: list[tuple[int, int]] = []
        self.right_openings: list[tuple[int, int]] = []

    # ---- 背景
    def draw_shell(self) -> None:
        w, h, bg = self.w, self.h, self.bg
        d = ImageDraw.Draw(bg)
        # 墙顶描边环：外描边 8px 处，墙厚 6px，内描边 15px 处
        d.rectangle((8, 8, w - 9, h - 9), fill=OUTLINE)
        d.rectangle((9, 9, w - 10, h - 10), fill=CAP)
        d.rectangle((15, 15, w - 16, h - 16), fill=OUTLINE)
        # 墙面（上墙两格高）与地板
        tile_fill(bg, self.wall, (16, 16, w - 16, 48))
        tile_fill(bg, self.floor, (16, 48, w - 16, h - 16))
        # 墙脚阴影与两侧内阴影，增加纵深
        for i, a in enumerate((90, 60, 36, 18)):
            shade(bg, (16, 48 + i, w - 16, 49 + i), a)
        for i, a in enumerate((50, 26, 12)):
            shade(bg, (16 + i, 48, 17 + i, h - 16), a)
            shade(bg, (w - 17 - i, 48, w - 16 - i, h - 16), a)
        shade(bg, (16, 16, w - 16, 18), 70)
        # 下墙开口：墙顶断开，地板延伸出房间并逐渐变暗
        for x0, x1 in self.bottom_openings:
            tile_fill(bg, self.floor, (x0, h - 16, x1, h))
            for i in range(16):
                shade(bg, (x0, h - 16 + i, x1, h - 15 + i), min(230, i * 16), (20, 20, 19))
            d.rectangle((x0 - 1, h - 16, x0 - 1, h - 9), fill=OUTLINE)
            d.rectangle((x1, h - 16, x1, h - 9), fill=OUTLINE)
        # 左右墙开口：墙顶断开，地板向外延伸并逐渐变暗，上下两端补描边
        for side, openings in (("left", self.left_openings), ("right", self.right_openings)):
            for y0, y1 in openings:
                tile_fill(bg, self.floor, (0, y0, 16, y1) if side == "left" else (w - 16, y0, w, y1))
                for i in range(16):
                    x = 15 - i if side == "left" else w - 16 + i
                    shade(bg, (x, y0, x + 1, y1), min(230, i * 16), (20, 20, 19))
                xs = (8, 15) if side == "left" else (w - 16, w - 9)
                d.rectangle((xs[0], y0 - 1, xs[1], y0 - 1), fill=OUTLINE)
                d.rectangle((xs[0], y1, xs[1], y1), fill=OUTLINE)

    def rug(self, box: tuple[int, int, int, int], tex: Image.Image, edge=(54, 46, 58), inner=None) -> None:
        """程序化区域地毯：平铺纹理 + 深色描边 + 可选内框线。"""
        x0, y0, x1, y1 = box
        tile_fill(self.bg, tex, box)
        d = ImageDraw.Draw(self.bg)
        d.rectangle((x0, y0, x1 - 1, y1 - 1), outline=(*edge, 255))
        if inner:
            d.rectangle((x0 + 2, y0 + 2, x1 - 3, y1 - 3), outline=(*inner, 255))
        shade(self.bg, (x0 + 1, y1, x1, y1 + 1), 50)

    def rug_round(self, box: tuple[int, int, int, int], tex: Image.Image, edge=(54, 46, 58), inner=None) -> None:
        """程序化椭圆地毯：椭圆蒙版内平铺纹理 + 深色描边 + 可选内圈线，底边下方 1px 投影。"""
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        shadow = Image.new("L", (w, h), 0)
        ImageDraw.Draw(shadow).ellipse((0, 0, w - 1, h - 1), fill=50)
        self.bg.paste(Image.new("RGBA", (w, h), (*SHADOW, 255)), (x0 + 1, y0 + 1), shadow)
        region = Image.new("RGBA", (w, h))
        tile_fill(region, tex, (0, 0, w, h))
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, w - 1, h - 1), fill=255)
        self.bg.paste(region, (x0, y0), mask)
        d = ImageDraw.Draw(self.bg)
        d.ellipse((x0, y0, x1 - 1, y1 - 1), outline=(*edge, 255))
        if inner:
            d.ellipse((x0 + 3, y0 + 3, x1 - 4, y1 - 4), outline=(*inner, 255))

    def decal(self, key: str, x: int, y: int) -> None:
        self.bg.alpha_composite(DECALS[key], (x, y))

    # ---- 运行时对象
    def prop(self, key: str, x: int, y: int, foot: int | None = None, solid=None, depth: int | None = None,
             inset: int = 1) -> dict:
        """放置家具（左上角坐标）。默认碰撞盒为底部 foot 像素高、左右各内缩 inset。"""
        img = OBJECTS[key]
        w, h = img.size
        item: dict = {"key": key, "x": x, "y": y}
        if solid is not False:
            if solid is None:
                f = min(h, foot if foot is not None else 14)
                solid = [x + inset, y + h - f, w - inset * 2, f]
            item["solid"] = solid
        if depth is not None:
            item["depth"] = depth
        self.props.append(item)
        return item

    def anim(self, key: str, x: int, y: int, depth: int | None = None, solid=None, frames=None) -> dict:
        item: dict = {"key": key, "x": x, "y": y}
        if depth is not None:
            item["depth"] = depth
        if solid:
            item["solid"] = solid
        if frames:
            item["frames"] = frames
        self.anims.append(item)
        return item

    def build_walls(self) -> None:
        """墙体碰撞：上墙（含墙面）、左右墙、下墙；开口处留空。"""
        w, h = self.w, self.h
        top_gaps = sorted(self.top_openings)
        x = 0
        for g0, g1 in top_gaps:
            self.walls.append([x, 0, g0 - x, 48])
            self.walls.append([g0, 0, g1 - g0, 20])
            x = g1
        self.walls.append([x, 0, w - x, 48])
        for x, openings in ((0, self.left_openings), (w - 16, self.right_openings)):
            y = 48
            for g0, g1 in sorted(openings):
                self.walls.append([x, y, 16, g0 - y])
                y = g1
            self.walls.append([x, y, 16, h - y])
        x = 0
        for g0, g1 in sorted(self.bottom_openings):
            self.walls.append([x, h - 16, g0 - x, 16])
            x = g1
        self.walls.append([x, h - 16, w - x, 16])

    def to_json(self, offset: tuple[int, int]) -> dict:
        return {
            "id": self.id, "name": self.name, "x": offset[0], "y": offset[1],
            "width": self.w, "height": self.h, "background": f"{self.id}.png",
            "walls": self.walls, "props": self.props, "anims": self.anims, "portals": self.portals,
            "spawns": self.spawns, "machines": self.machines, "doors": self.doors, "signs": self.signs,
        }


# ---------------------------------------------------------------- 布局

def t(n: float) -> int:
    return int(n * T)


def build_foyer() -> Room:
    """入口厅（电梯厅）：电梯进入，前台接待，右侧等候区，下墙中间开口通往大厅，左墙开口通往隔壁「我的房间」。"""
    room = Room("foyer", "入口厅", 20, 13, floor_tex(4, 8), wall_tex(1, 26))
    exit_x0, exit_x1 = t(9), t(11)
    room.bottom_openings.append((exit_x0, exit_x1))
    side_y0, side_y1 = t(6), t(8)
    room.left_openings.append((side_y0, side_y1))
    room.draw_shell()
    w, h = room.w, room.h

    # 墙面挂饰
    room.decal("string_lights", t(1.5), 18)
    room.decal("cork_board", t(5.5), 22)
    room.decal("painting_forest", t(12) + 5, 24)
    room.decal("painting_aqua", t(14) + 2, 24)
    room.decal("string_lights", t(16.5), 18)
    # 地毯：中央迎宾毯 + 等候区 + 出口地垫
    room.rug((t(6), t(5.5), t(14), t(9.5)), floor_tex(8, 20), edge=(40, 36, 70), inner=(150, 140, 200))
    room.decal("rug_red_gold", t(13.5) + 2, t(7) - 4)
    room.rug((exit_x0 + 2, h - 32, exit_x1 - 2, h - 18), floor_tex(12, 26), edge=(60, 40, 30))

    # 电梯（上墙中央），进入场景时开合一次
    room.anim("elevator", t(9), 16, depth=20, frames="once")
    room.signs.append({"x": t(10), "y": 10, "text": "HannisHub", "tone": "brand"})

    # 前台：L 形柜台 + 接待员
    room.prop("reception_left", t(1.5), t(3), foot=20)
    room.prop("reception_mid", t(3.5), t(3), foot=20)
    room.anim("receptionist", t(3.5), t(3))
    room.prop("reception_right", t(4.5), t(3), foot=20)
    room.prop("plant_tall", t(1), t(1), foot=12)
    room.anim("clock", t(7), 16, depth=20)

    # 右侧等候区
    room.prop("plant_palm", t(16.5), t(1), foot=14)
    room.prop("armchair_blue", t(13.5), t(5.5), foot=14)
    room.prop("armchair_yellow", t(16), t(5.5), foot=14)
    room.prop("table_round", t(14.75), t(7.25), foot=16)
    room.prop("lamp_floor", t(18), t(6.5), foot=8)

    # 左下角长椅与绿植，出口两侧盆栽
    room.prop("bench", t(1.5), t(9.5), foot=10)
    room.prop("plant_big", t(1), t(10) - 4, foot=14)
    room.prop("plant_pot", exit_x0 - 20, h - 46, foot=10)
    room.prop("plant_pot", exit_x1 + 4, h - 46, foot=10)
    room.prop("plant_big", t(17), t(10) - 4, foot=14)

    # 出口提示箭头与传送门
    room.anim("arrow_down", (exit_x0 + exit_x1) // 2 - 8, h - 50, depth=h + 100)
    room.signs.append({"x": (exit_x0 + exit_x1) // 2, "y": h - 54, "text": "大厅", "tone": "muted"})
    room.portals.append({"rect": [exit_x0, h - 10, exit_x1 - exit_x0, 10], "to": "hall", "spawn": "fromFoyer"})

    # 左墙门洞：通往隔壁「我的房间」，门口地垫 + 标牌
    room.rug((16, side_y0 + 3, 40, side_y1 - 3), floor_tex(12, 26), edge=(60, 40, 30))
    room.signs.append({"x": 34, "y": side_y0 - 8, "text": "我的房间", "tone": "muted"})
    room.anim("arrow_left", 20, side_y0 + 8, depth=h + 100)
    room.portals.append({"rect": [0, side_y0, 6, side_y1 - side_y0], "to": "room", "spawn": "fromFoyer"})

    room.spawns["start"] = {"x": t(10), "y": t(3) + 10, "dir": "down"}
    # 回到入口厅时站在出口标牌与箭头之外，避免标牌压在角色头上
    room.spawns["fromHall"] = {"x": t(10), "y": h - 62, "dir": "up"}
    room.spawns["fromRoom"] = {"x": 62, "y": (side_y0 + side_y1) // 2 + 4, "dir": "right"}
    room.build_walls()
    return room


def workstation(room: Room, x: int, y: int, accessory: str) -> None:
    """一个工位：两张书桌拼成 64px 长桌，双屏滚动显示器 + 桌面小物，转椅在桌前（面向屏幕）。"""
    room.prop("desk", x, y, foot=20)
    room.prop("desk_plain", x + 32, y, foot=20)
    top = y + 32
    room.anim("monitor", x + 12, y - 14, depth=top + 1)
    room.anim("monitor", x + 28, y - 14, depth=top + 1)
    if accessory == "coffee":
        room.anim("coffee", x + 44, y - 14, depth=top + 1)
    else:
        room.prop(accessory, x + 44, y - 14, solid=False, depth=top + 1)
    room.prop("chair_task", x + 24, y + 18, solid=[x + 27, y + 42, 10, 6])


def build_hall() -> Room:
    """大厅：上墙中间玻璃门入口；左上 4 工位，右上 ASR / OCR 两台机器，右侧圆桌聊天角（聊天室），左下休息区，右下游戏角。"""
    room = Room("hall", "大厅", 36, 24, floor_tex(4, 12), wall_tex(23, 24))
    door_x = t(17)
    room.top_openings.append((door_x + 4, door_x + 28))
    room.draw_shell()
    w, h = room.w, room.h

    # ---- 上墙挂饰
    room.decal("window_curtain", t(3.5), 18)
    room.decal("world_map", t(7), 16)
    room.decal("window_curtain", t(10), 18)
    room.decal("cork_board", t(13), 22)

    # ---- 入口：玻璃双开门 + 红色迎宾长毯 + 两侧绿植
    room.doors.append({"key": "door_glass", "x": door_x, "y": 0, "radius": 40})
    room.portals.append({"rect": [door_x + 6, 22, 20, 20], "to": "foyer", "spawn": "fromHall"})
    room.rug((door_x + 2, 48, door_x + 30, t(13)), floor_tex(4, 14), edge=(70, 30, 30), inner=(214, 160, 90))
    room.prop("plant_tall2", door_x - 18, 16, foot=12)
    room.prop("plant_tall2", door_x + 34, 16, foot=12)
    room.anim("arrow_up", door_x + 8, 50, depth=h + 100)
    room.signs.append({"x": door_x + 16, "y": 8, "text": "入口厅", "tone": "muted"})

    # ---- 左上：工位区（浅灰地毯 + 2x2 工位）
    room.prop("bookshelf", t(1), 16, foot=16)
    room.prop("plant_tall", t(14.5), 16, foot=12)
    room.rug((t(2), t(5), t(15), t(14.5)), floor_tex(0, 36), edge=(70, 68, 80), inner=(196, 194, 204))
    workstation(room, t(3), t(6.5), "lamp_desk_blue")
    workstation(room, t(9), t(6.5), "plant_desk")
    workstation(room, t(3), t(10.5), "coffee")
    workstation(room, t(9), t(10.5), "lamp_desk_cream")
    room.prop("plant_pot", t(7.5), t(8.5) - 4, foot=10)

    # ---- 右上：机器区。台前为高亮地台，站上去按 E 交互
    # ASR 录音台：音箱 + 音频工作台 + 音箱 + 机柜，挂墙声纹屏，台前录音话筒
    asr_x = t(20.5)
    room.rug((asr_x - 8, 48, asr_x + 88, t(6.5)), floor_tex(8, 20), edge=(110, 54, 40), inner=(217, 119, 87))
    room.anim("speaker", asr_x, 16)
    room.prop("audio_desk", asr_x + 16, 16, foot=16)
    room.anim("speaker", asr_x + 48, 16)
    room.anim("server", asr_x + 64, 16)
    room.anim("wave_screen", asr_x + 82, 22, depth=10)
    room.prop("mic", asr_x + 34, 38, solid=False)  # 话筒不挡路，地台上可横向走动
    room.machines.append({
        "id": "asr", "title": "ASR 语音转写", "hint": "上传音频，转写为文字",
        "zone": [asr_x - 6, 58, 92, t(6.5) - 58], "signX": asr_x + 40, "signY": 8,
    })

    # OCR 文档终端：自助扫描终端 + 挂墙文档屏 + 复印机 + 纸篓
    ocr_x = t(27.5)
    room.rug((ocr_x - 8, 48, ocr_x + 88, t(6.5)), floor_tex(8, 30), edge=(40, 60, 100), inner=(106, 155, 204))
    room.prop("kiosk", ocr_x + 4, 16, foot=16)
    room.anim("doc_screen", ocr_x + 22, 14, depth=10)
    room.prop("copier", ocr_x + 56, 16, foot=16)
    room.prop("trash", ocr_x + 72, 30, foot=8)
    room.machines.append({
        "id": "ocr", "title": "OCR 文字识别", "hint": "解析文档、提取字段、图像问答",
        "zone": [ocr_x - 6, 58, 92, t(6.5) - 58], "signX": ocr_x + 40, "signY": 8,
    })
    room.prop("plant_palm", t(33.5), 14, foot=14)

    # ---- 右侧中部：圆桌聊天角（椭圆地毯 + 木圆桌 + 四张高脚凳），站上地毯按 E 打开聊天室；右墙边鱼缸
    cx, cy = t(26.5), t(10.5)
    room.rug_round((cx - 58, cy - 40, cx + 58, cy + 40), floor_tex(8, 8), edge=(110, 54, 40), inner=(217, 119, 87))
    room.prop("table_round", cx - 16, cy - 16, foot=16)
    room.anim("coffee", cx - 8, cy - 26, depth=cy + 17)
    room.prop("stool_blue", cx - 8, cy - 44, foot=8)
    room.prop("stool_yellow", cx - 44, cy - 20, foot=8)
    room.prop("stool_wood", cx + 28, cy - 20, foot=8)
    room.prop("stool_blue", cx - 8, cy + 10, foot=8)
    room.machines.append({
        "id": "chat", "title": "聊天室", "hint": "和大家一起聊天",
        "zone": [cx - 50, cy - 32, 100, 64], "signX": cx, "signY": cy - 52,
    })
    room.anim("fishtank", t(32.5), t(9), solid=[t(32.5) + 1, t(9) + 18, 30, 14])
    room.prop("plant_big", t(32.5), t(11), foot=14)

    # ---- 左下：休息区
    room.rug((t(2), t(16.5), t(13), t(22)), floor_tex(12, 28), edge=(50, 60, 90), inner=(220, 230, 245))
    room.prop("armchair_red", t(3), t(17.5), foot=14)
    room.prop("table_round", t(5.5), t(18), foot=16)
    room.prop("armchair_blue", t(8), t(17.5), foot=14)
    room.prop("armchair_yellow", t(4.25), t(20), foot=14)
    room.prop("armchair_white", t(6.75), t(20), foot=14)
    room.anim("cat", t(9.5), t(21) - 2, depth=t(21) + 14)
    room.prop("lamp_floor", t(1.25), t(15), foot=8)
    room.prop("lamp_floor", t(11), t(15), foot=8)
    room.prop("plant_big", t(11), t(19.5), foot=14)
    room.prop("bookshelf_wide", t(1), t(19), foot=16)

    # ---- 中下：咖啡角
    room.prop("bar_shelf", t(15), t(15), foot=16)
    room.prop("sideboard", t(17), t(16), foot=14)
    room.anim("coffee", t(17) + 8, t(16) - 12, depth=t(18) + 1)
    room.prop("egg_yellow", t(15.5), t(19.5), foot=12)
    room.prop("table_round_dark", t(17.5), t(19.5), foot=14)
    room.prop("egg_red", t(19.5), t(19.5), foot=12)

    # ---- 右下：游戏角
    room.rug((t(22), t(15), t(34), t(22)), floor_tex(4, 20), edge=(60, 40, 40), inner=(170, 120, 100))
    room.prop("arcade_a", t(23), t(14) + 2, foot=14)
    room.prop("arcade_b", t(24), t(14) + 2, foot=14)
    room.prop("pool_table", t(27), t(17), foot=30)
    room.prop("pinball", t(31), t(14) + 2, foot=14)
    room.prop("egg_blue", t(23), t(19.5), foot=12)
    room.prop("egg_white", t(31.5), t(19.5), foot=12)
    room.prop("lamp_floor_red", t(34), t(19), foot=8)

    room.prop("plant_big", t(1), t(13) - 6, foot=14)
    room.spawns["fromFoyer"] = {"x": door_x + 16, "y": 96, "dir": "down"}
    room.build_walls()
    return room


def build_room() -> Room:
    """我的房间：入口厅左侧隔壁的小卧室。下墙中间开口出去直接回到入口厅；
    衣柜 + 穿衣镜前的地台按 E 打开「形象与名字」。"""
    room = Room("room", "我的房间", 12, 10, floor_tex(0, 24), wall_tex(23, 28))
    exit_x0, exit_x1 = t(5), t(7)
    room.bottom_openings.append((exit_x0, exit_x1))
    room.draw_shell()
    w, h = room.w, room.h

    # 左上：单人床 + 床头柜与台灯，墙上窗帘窗
    room.prop("bed_blue", 18, 30, foot=30)
    room.prop("nightstand", 46, 36, foot=8)
    room.prop("lamp_desk_cream", 46, 24, solid=False, depth=55)
    room.decal("window_curtain", 68, 18)

    # 右上：衣柜 + 穿衣镜，台前高亮地台为交互区
    wx = 110
    room.rug((wx - 6, 50, wx + 50, 80), floor_tex(8, 20), edge=(110, 54, 40), inner=(217, 119, 87))
    room.prop("wardrobe", wx, 20, foot=10)
    room.prop("mirror", wx + 34, 31, foot=6)
    room.machines.append({
        "id": "wardrobe", "title": "形象与名字", "hint": "换装、设置别人看到的名字",
        "zone": [wx - 4, 60, 52, 18], "signX": wx + 22, "signY": 8,
    })
    room.prop("plant_pot", 158, 34, foot=8)

    # 左下：书架与落地灯；右下：地毯上的扶手椅与小圆桌，桌边睡猫
    room.prop("bookshelf", 16, 90, foot=16)
    room.prop("lamp_floor", 50, 92, foot=8)
    room.decal("rug_beige", 122, 102)
    room.prop("armchair_blue", 116, 84, foot=14)
    room.prop("table_round", 144, 94, foot=16)
    room.anim("cat", 124, 128, depth=144)

    # 出口：门口地垫 + 「入口厅」标牌与向下箭头
    room.rug((exit_x0 + 2, h - 32, exit_x1 - 2, h - 18), floor_tex(12, 26), edge=(60, 40, 30))
    room.anim("arrow_down", (exit_x0 + exit_x1) // 2 - 8, h - 50, depth=h + 100)
    room.signs.append({"x": (exit_x0 + exit_x1) // 2, "y": h - 54, "text": "入口厅", "tone": "muted"})
    room.portals.append({"rect": [exit_x0, h - 10, exit_x1 - exit_x0, 10], "to": "foyer", "spawn": "fromRoom"})
    # 进门后站在「入口厅」标牌上方，标牌与箭头不压在角色身上
    room.spawns["fromFoyer"] = {"x": (exit_x0 + exit_x1) // 2, "y": h - 62, "dir": "up"}
    room.build_walls()
    return room


# ---------------------------------------------------------------- 角色部件

# 角色生成器原图（16x16 档 896x656）帧布局：每帧 16x32；第 1 行 idle、第 2 行 walk，
# 每行 24 帧按 右/上/左/下 每方向 6 帧。导出为与 player.png 相同的 96x256 块：
# 6 帧 x 8 行（静止 南/北/左/右 + 行走 南/北/左/右）。
AVATAR_DIR_ORDER = {"down": 3, "up": 1, "left": 2, "right": 0}
AVATAR_ROWS = [(1, "down"), (1, "up"), (1, "left"), (1, "right"), (2, "down"), (2, "up"), (2, "left"), (2, "right")]
AVATAR_CATEGORIES = [
    # (前端槽位, 源目录, 是否允许不选)
    ("body", "Bodies", False),
    ("eyes", "Eyes", False),
    ("outfit", "Outfits", False),
    ("hair", "Hairstyles", True),
    ("accessory", "Accessories", True),
]
AVATAR_COLS = 16


def avatar_block(src: Image.Image) -> Image.Image:
    out = Image.new("RGBA", (96, 256))
    for r, (row, direction) in enumerate(AVATAR_ROWS):
        for i in range(6):
            fx = (AVATAR_DIR_ORDER[direction] * 6 + i) * 16
            out.paste(src.crop((fx, row * 32, fx + 16, row * 32 + 32)), (i * 16, r * 32))
    return out


def split_part_name(stem: str) -> tuple[str, str]:
    """Outfit_03_02 → ("03", "02")；Accessory_15_Glasses_01 → ("15_Glasses", "01")；Body_04 → ("04", "")。"""
    parts = stem.split("_")[1:]
    if len(parts) == 1:
        return parts[0], ""
    return "_".join(parts[:-1]), parts[-1]


def build_avatar_parts() -> tuple[dict[str, Image.Image], dict]:
    sheets: dict[str, Image.Image] = {}
    manifest: dict = {"frameWidth": 16, "frameHeight": 32, "blockWidth": 96, "blockHeight": 256,
                      "columns": AVATAR_COLS, "categories": {}}
    for slot, folder, optional in AVATAR_CATEGORIES:
        files = sorted((PACK / CHARGEN / folder / "16x16").glob("*.png"))
        rows = (len(files) + AVATAR_COLS - 1) // AVATAR_COLS
        sheet = Image.new("RGBA", (min(AVATAR_COLS, len(files)) * 96, rows * 256))
        items = []
        for i, f in enumerate(files):
            sheet.paste(avatar_block(Image.open(f).convert("RGBA")), ((i % AVATAR_COLS) * 96, (i // AVATAR_COLS) * 256))
            style, variant = split_part_name(f.stem)
            items.append({"id": f.stem, "style": style, "variant": variant})
        sheets[slot] = sheet
        manifest["categories"][slot] = {"file": f"avatar/{slot}.png", "optional": optional, "items": items}
    return sheets, manifest


# ---------------------------------------------------------------- 输出

def pack_atlas(images: dict[str, Image.Image], width: int = 512, pad: int = 2):
    """简单的行式装箱：按高度降序排入固定宽度图集，返回图集与 Phaser JSON Hash。"""
    items = sorted(images.items(), key=lambda kv: (-kv[1].height, kv[0]))
    x = y = row_h = 0
    placed = {}
    for name, img in items:
        if x + img.width + pad > width:
            x = 0
            y += row_h + pad
            row_h = 0
        placed[name] = (x, y)
        x += img.width + pad
        row_h = max(row_h, img.height)
    height = y + row_h
    atlas = Image.new("RGBA", (width, height))
    frames = {}
    for name, img in items:
        px, py = placed[name]
        atlas.paste(img, (px, py))
        frames[name] = {
            "frame": {"x": px, "y": py, "w": img.width, "h": img.height},
            "rotated": False, "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": img.width, "h": img.height},
            "sourceSize": {"w": img.width, "h": img.height},
        }
    meta = {"image": "objects.png", "format": "RGBA8888", "size": {"w": width, "h": height}, "scale": "1"}
    return atlas, {"frames": frames, "meta": meta}


def render_preview(rooms: list[tuple[Room, tuple[int, int]]], path: Path, world: tuple[int, int]) -> None:
    """离线预览：按运行时同样的深度规则合成整个世界，并标出碰撞盒与交互区。"""
    canvas = Image.new("RGBA", world, VOID)
    for room, (ox, oy) in rooms:
        canvas.alpha_composite(room.bg, (ox, oy))
        drawables = []
        for p in room.props:
            img = OBJECTS[p["key"]]
            drawables.append((p.get("depth", p["y"] + img.height), img, p["x"], p["y"]))
        for a in room.anims:
            meta = ANIMS[a["key"]]
            img = meta["image"].crop((0, 0, meta["frameWidth"], meta["frameHeight"]))
            drawables.append((a.get("depth", a["y"] + meta["frameHeight"]), img, a["x"], a["y"]))
        for door in room.doors:
            meta = ANIMS[door["key"]]
            img = meta["image"].crop((0, 0, meta["frameWidth"], meta["frameHeight"]))
            drawables.append((door.get("depth", door["y"] + meta["frameHeight"]), img, door["x"], door["y"]))
        for depth, img, x, y in sorted(drawables, key=lambda d: d[0]):
            canvas.alpha_composite(img, (ox + x, oy + y))
        overlay = Image.new("RGBA", world)
        d = ImageDraw.Draw(overlay)
        for x, y, w, h in room.walls:
            d.rectangle((ox + x, oy + y, ox + x + w - 1, oy + y + h - 1), outline=(255, 0, 0, 90))
        for p in room.props + room.anims:
            if p.get("solid"):
                x, y, w, h = p["solid"]
                d.rectangle((ox + x, oy + y, ox + x + w - 1, oy + y + h - 1), outline=(255, 160, 0, 200))
        for m in room.machines:
            x, y, w, h = m["zone"]
            d.rectangle((ox + x, oy + y, ox + x + w - 1, oy + y + h - 1), outline=(0, 255, 120, 220))
        for portal in room.portals:
            x, y, w, h = portal["rect"]
            d.rectangle((ox + x, oy + y, ox + x + w - 1, oy + y + h - 1), outline=(0, 200, 255, 220))
        for s in room.spawns.values():
            d.ellipse((ox + s["x"] - 2, oy + s["y"] - 2, ox + s["x"] + 2, oy + s["y"] + 2), fill=(255, 255, 0, 255))
        canvas.alpha_composite(overlay)
    canvas.resize((world[0] * 3, world[1] * 3), Image.NEAREST).convert("RGB").save(path)


def content_hash(files: list[Path]) -> str:
    """按文件相对路径与内容计算短哈希，作为素材版本号；内容不变时哈希不变。"""
    digest = hashlib.sha1()
    for path in sorted(files):
        digest.update(str(path.relative_to(OUT)).encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def main() -> None:
    parser = argparse.ArgumentParser(description="构建聊天大厅俱乐部场景素材")
    parser.add_argument("--preview", type=Path, help="额外输出带碰撞标注的整图预览（3 倍放大）")
    parser.add_argument("--no-write", action="store_true", help="只生成预览，不写入 frontend/public")
    args = parser.parse_args()

    if not PACK.exists():
        raise SystemExit(f"找不到素材包目录：{PACK}")
    build_objects()
    build_decals()
    build_anims()
    foyer = build_foyer()
    room = build_room()
    hall = build_hall()

    # 世界排布：上一行左侧是我的房间、右侧是入口厅，大厅在入口厅正下方。
    # 房间之间留足间距：小房间在大屏上居中显示时，相机视野会超出房间，不能看到相邻房间。
    gap = 256
    room_off = (0, 0)
    foyer_off = (room.w + gap, 0)
    hall_off = (foyer_off[0] + (foyer.w - hall.w) // 2, foyer.h + gap)
    placed = [(room, room_off), (foyer, foyer_off), (hall, hall_off)]
    shift_x = -min(off[0] for _, off in placed)
    placed = [(r, (x + shift_x, y)) for r, (x, y) in placed]
    world = (max(x + r.w for r, (x, _) in placed), max(y + r.h for r, (_, y) in placed))

    layout = {
        "version": 2,
        "tile": T,
        "world": {"width": world[0], "height": world[1]},
        "start": {"room": "foyer", "spawn": "start"},
        "anims": {k: {"file": f"anims/{k}.png", "frameWidth": v["frameWidth"], "frameHeight": v["frameHeight"],
                      "frameRate": v["frameRate"], **({"door": v["door"]} if "door" in v else {})}
                  for k, v in ANIMS.items()},
        "rooms": [r.to_json(off) for r, off in placed],
    }

    if args.preview:
        render_preview(placed, args.preview, world)
        print(f"预览：{args.preview}")
    if args.no_write:
        return

    if OUT.exists():
        for child in ("anims", "avatar"):
            shutil.rmtree(OUT / child, ignore_errors=True)
    (OUT / "anims").mkdir(parents=True, exist_ok=True)
    (OUT / "avatar").mkdir(parents=True, exist_ok=True)
    for r, _ in placed:
        r.bg.save(OUT / f"{r.id}.png", optimize=True)
    atlas, atlas_json = pack_atlas(OBJECTS)
    atlas.save(OUT / "objects.png", optimize=True)
    (OUT / "objects.json").write_text(json.dumps(atlas_json, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for key, meta in ANIMS.items():
        meta["image"].save(OUT / "anims" / f"{key}.png", optimize=True)
    sheets, manifest = build_avatar_parts()
    for slot, sheet in sheets.items():
        sheet.save(OUT / "avatar" / f"{slot}.png", optimize=True)
    manifest["build"] = content_hash(list((OUT / "avatar").glob("*.png")))
    (OUT / "avatar" / "parts.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    # 场景版本覆盖背景、图集、动画帧条与默认角色（不含 layout.json 自身与角色部件）
    scene_files = [f for f in OUT.glob("*") if f.suffix in {".png", ".json"} and f.name != "layout.json"]
    layout["build"] = content_hash(scene_files + list((OUT / "anims").glob("*.png")))
    (OUT / "layout.json").write_text(json.dumps(layout, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    parts = sum(len(c["items"]) for c in manifest["categories"].values())
    print(f"已输出到 {OUT.relative_to(ROOT)}：{len(OBJECTS)} 件家具、{len(ANIMS)} 组动画、{len(placed)} 个场景、{parts} 个角色部件")


if __name__ == "__main__":
    main()
