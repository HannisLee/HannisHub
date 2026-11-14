#!/usr/bin/env python3
"""聊天大厅（俱乐部风格）素材与布局构建脚本。

从本机付费素材包 chatworld/asset/modern_interiors/（Limezu Modern Interiors，不入库）提取派生素材，
输出到 frontend/public/chat-lobby/club/：

- foyer.png / room.png / hall.png：各房间的烘焙背景（地板、墙面、墙顶收边、区域地毯、墙面挂饰）
- objects.png + objects.json：可遮挡家具的图集（Phaser JSON Hash 格式）
- anims/*.png：动画物件帧条
- player.png：默认角色（预制角色 12 号），帧布局与形象部件相同（静止、行走各 4 方向 + 左右坐姿）
- avatar/*.png + avatar/parts.json：角色生成器分层部件（身体、眼睛、服装、发型、配饰），前端运行时叠层合成
- layout.json：房间尺寸、家具坐标、碰撞盒、传送门、出生点、交互机器、座位、工位与小互动（前端运行时读取）

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
KITCHEN = "1_Interiors/16x16/Theme_Sorter/12_Kitchen_16x16.png"
MUSIC = "1_Interiors/16x16/Theme_Sorter/6_Music_and_sport_16x16.png"
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
    # ---- 大厅新增
    # 工位桌：俯视的深桌面木桌，双屏显示器能完整落在桌面上（原先的正视角书桌桌面只有几像素深，显示器像悬空）
    o["work_table"] = trimmed(GENERIC, (88, 542, 136, 592))
    o["side_cabinet"] = single("living", 65)
    # 完整台球桌：素材包把球桌拆成左右两半
    o["pool_full"] = combine([(single("basement", 76), 0, 0), (single("basement", 77), 32, 0)])
    o["pool_rack"] = single("basement", 72)
    # 三人沙发（正面）：左 / 中 / 右三段拼接
    o["sofa_front"] = combine([(single("basement", 4), 0, 0), (single("basement", 5), 16, 0), (single("basement", 6), 32, 0)])
    o["coffee_table"] = trimmed(GENERIC, (84, 96, 128, 124))
    # 侧向餐椅：靠背在左（面朝右）/ 靠背在右（面朝左）
    o["chair_side_r"] = trimmed(GENERIC, (144, 800, 160, 832))
    o["chair_side_l"] = trimmed(GENERIC, (240, 800, 256, 832))
    # 茶水间：橱柜台面、冰箱、咖啡机
    o["fridge"] = trimmed(KITCHEN, (144, 372, 160, 412))
    o["espresso"] = trimmed(KITCHEN, (240, 376, 256, 408))
    # 音乐角：钢琴凳、吉他
    o["piano_bench"] = flood(MUSIC, 16, 72)
    o["guitar"] = trimmed(MUSIC, (112, 36, 128, 80))
    o["guitar_blue"] = trimmed(MUSIC, (160, 36, 176, 80))
    o["whiteboard"] = single("class", 39)


def combine(parts: list[tuple[Image.Image, int, int]]) -> Image.Image:
    """把多个单件按偏移拼成一件（如左右两半的台球桌、三段沙发）。"""
    w = max(img.width + x for img, x, _ in parts)
    h = max(img.height + y for img, _, y in parts)
    out = Image.new("RGBA", (w, h))
    for img, x, y in parts:
        out.alpha_composite(img, (x, y))
    return out


# 家具贴图裁掉四周透明边后的偏移（原图左上角 → 可见像素左上角）。不裁掉时，贴图底部的透明行会让
# 碰撞盒与遮挡深度落在可见底边下方（绿植看起来悬空、角色走到盆底前方却被画在后面）
TRIM: dict[str, tuple[int, int, int]] = {}


def trim_objects() -> None:
    for key, img in OBJECTS.items():
        box = img.getbbox()
        TRIM[key] = (box[0], box[1], img.height - box[3])
        OBJECTS[key] = img.crop(box)


# 素材包单件自带的默认阴影是不透明的单一颜色，压在地毯上会露出一块灰底；统一换成半透明暗色
PACK_SHADOW = (167, 151, 150, 255)
SOFT_SHADOW = (30, 22, 30, 72)


def soften_shadows() -> None:
    for key, img in OBJECTS.items():
        img = img.copy()
        px = img.load()
        for y in range(img.height):
            for x in range(img.width):
                if px[x, y] == PACK_SHADOW:
                    px[x, y] = SOFT_SHADOW
        OBJECTS[key] = img


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


def build_anims() -> None:
    a = ANIMS

    def add(key: str, img: Image.Image, fw: int, fh: int, rate: int, door: dict | None = None) -> None:
        a[key] = {"image": img, "frameWidth": fw, "frameHeight": fh, "frameRate": rate}
        if door:
            # 自动门：靠近时播放 open 帧序列，离开时播放 close 帧序列
            a[key]["door"] = door

    # 玻璃双开门：开门时门扇向上收起；原图开门帧的门扇会冒出墙顶，按关门状态的上沿（y=19）裁掉其上方像素，
    # 门扇看起来是收进门楣
    door = load(ANIM_DIR + "animated_door_glass_double.png").copy()
    door.paste((0, 0, 0, 0), (0, 0, door.width, DOOR_TOP))
    add("door_glass", door, 32, 48, 14, door={"open": [0, 1, 2, 3, 4], "close": [5, 6, 7, 0]})
    # 电梯：通往楼上「我的房间」的自动门。帧 0 关闭，1–7 打开并停在全开，8–13 关闭
    add("elevator", load(ANIM_DIR + "animated_elevator_door_entrance_1.png"), 32, 32, 10,
        door={"open": list(range(0, 8)), "close": list(range(8, 14)) + [0]})
    add("receptionist", load(ANIM_DIR + "animated_receptionist.png"), 16, 32, 5)
    add("monitor", load(ANIM_DIR + "animated_control_room_facebook_scrolling.png"), 16, 32, 4)
    add("speaker", load(ANIM_DIR + "animated_amplifier_big.png"), 16, 48, 6)
    add("server", load(ANIM_DIR + "animated_control_room_server.png"), 16, 48, 3)
    add("doc_screen", load(ANIM_DIR + "animated_hospital_screen_color.png"), 32, 32, 3)
    add("coffee", load(ANIM_DIR + "animated_coffee.png"), 16, 32, 6)
    add("cat", load(ANIM_DIR + "animated_cat.png"), 48, 16, 6)
    add("fishtank", load(ANIM_DIR + "animated_fishtank_orange.png"), 32, 32, 6)
    add("clock", load(ANIM_DIR + "animated_cuckoo_clock.png"), 16, 32, 2)
    add("piano", load(ANIM_DIR + "animated_wall_piano.png"), 32, 32, 8)
    add("toytrain", load(ANIM_DIR + "animated_toytrain.png"), 96, 64, 10)
    add("arrow_down", gif_strip(UI_DIR + "UI_arrow_pointing_down_16x16.gif"), 16, 16, 8)
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
DOOR_TOP = 19                     # 玻璃双开门关门时的上沿（门贴图内 y）
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
        # 可坐的位置：角色脚底坐标、坐下朝向与站立交互区
        self.seats: list[dict] = []
        # 工位：可认领，认领者在自己的工位按 E 打开待办
        self.desks: list[dict] = []
        # 小互动：按 E 在角色头顶冒出一句气泡（咖啡、喂鱼、撸猫、弹琴……）
        self.actions: list[dict] = []
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

    def door_recess(self, x: int, y: int = 0) -> None:
        """上墙玻璃门背后的门洞：门打开后看到的是幽暗的通道而不是墙面。
        门贴图 32x48 放在 (x, y)，两侧门框各 2px，门洞取门框之间、关门上沿以下的区域。"""
        x0, y0, x1, y1 = x + 2, y + DOOR_TOP, x + 30, y + 48
        d = ImageDraw.Draw(self.bg)
        d.rectangle((x0, y0, x1 - 1, y1 - 1), fill=(40, 37, 46, 255))
        # 门楣投影：上沿两行更暗；底部几行略亮，暗示门外的地面
        d.rectangle((x0, y0, x1 - 1, y0 + 1), fill=(24, 22, 28, 255))
        for i, color in enumerate(((50, 46, 56), (58, 54, 64), (66, 61, 72), (72, 67, 78))):
            d.line((x0, y1 - 4 + i, x1 - 1, y1 - 4 + i), fill=(*color, 255))

    def decal(self, key: str, x: int, y: int) -> None:
        self.bg.alpha_composite(DECALS[key], (x, y))

    # ---- 运行时对象
    def prop(self, key: str, x: int, y: int, foot: int | None = None, solid=None, depth: int | None = None,
             inset: int = 1) -> dict:
        """放置家具（以未裁边的原图左上角为坐标，入口厅与我的房间沿用）。默认碰撞盒为可见底部 foot 像素高
        （扣除原图底部透明行）、左右各内缩 inset。"""
        dx, dy, pad = TRIM[key]
        f = None if foot is None else max(4, foot - pad)
        return self.put(key, x + dx, y + dy + OBJECTS[key].height, foot=f, solid=solid, depth=depth, inset=inset)

    def put(self, key: str, x: int, bottom: int, foot: int | None = None, solid=None, depth: int | None = None,
            inset: int = 1) -> dict:
        """放置家具：x 为可见像素左边，bottom 为可见底边（落地线）。碰撞盒默认为底部 foot 像素高。"""
        img = OBJECTS[key]
        w, h = img.size
        y = bottom - h
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
            "seats": self.seats, "desks": self.desks, "actions": self.actions,
        }

    # ---- 交互
    def seat(self, x: int, y: int, facing: str, zone: list[int], title: str = "坐下") -> dict:
        """可坐位置：(x, y) 为坐下后角色的脚底坐标（决定前后遮挡），facing 为坐下后的朝向。
        朝上的座位让 y 略小于椅子底边，椅背画在角色前面；朝下与侧向的座位 y 在椅子底边之下，角色画在椅子上。"""
        item = {"id": f"seat-{len(self.seats) + 1}", "x": x, "y": y, "dir": facing, "zone": zone, "title": title}
        self.seats.append(item)
        return item

    def action(self, aid: str, title: str, hint: str, zone: list[int], **extra) -> dict:
        item = {"id": aid, "title": title, "hint": hint, "zone": zone, **extra}
        self.actions.append(item)
        return item


# ---------------------------------------------------------------- 像素字

# 5x7 点阵（i 为 3 列），只包含墙面标识用到的字母
PIXEL_GLYPHS = {
    "H": ["1...1", "1...1", "1...1", "11111", "1...1", "1...1", "1...1"],
    "a": [".....", ".....", ".111.", "....1", ".1111", "1...1", ".1111"],
    "n": [".....", ".....", "1111.", "1...1", "1...1", "1...1", "1...1"],
    "i": [".1.", "...", "11.", ".1.", ".1.", ".1.", "111"],
    "s": [".....", ".....", ".1111", "1....", ".111.", "....1", "1111."],
    "u": [".....", ".....", "1...1", "1...1", "1...1", "1...1", ".1111"],
    "b": ["1....", "1....", "1111.", "1...1", "1...1", "1...1", "1111."],
}
BRAND = (217, 119, 87, 255)
BRAND_LIGHT = (240, 168, 132, 255)


def pixel_text(text: str, scale: int = 2) -> Image.Image:
    """像素风墙面字：品牌色字身 + 顶行高光 + 1px 深色描边 + 右下 1px 投影。"""
    cols = sum(len(PIXEL_GLYPHS[c][0]) for c in text) + len(text) - 1
    w, h = cols * scale, 7 * scale
    body = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(body)
    x = 0
    for c in text:
        glyph = PIXEL_GLYPHS[c]
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit == "1":
                    above = gy > 0 and gx < len(glyph[gy - 1]) and glyph[gy - 1][gx] == "1"
                    color = BRAND if above else BRAND_LIGHT
                    d.rectangle(((x + gx) * scale, gy * scale, (x + gx + 1) * scale - 1, (gy + 1) * scale - 1), fill=color)
        x += len(glyph[0]) + 1
    mask = body.getchannel("A")
    out = Image.new("RGBA", (w + 3, h + 3))
    shadow = Image.new("RGBA", (w, h), (24, 18, 30, 110))
    outline = Image.new("RGBA", (w, h), OUTLINE)
    out.paste(shadow, (2, 2), mask)
    for dx, dy in ((0, 1), (2, 1), (1, 0), (1, 2)):
        out.paste(outline, (dx, dy), mask)
    out.alpha_composite(body, (1, 1))
    return out


# ---------------------------------------------------------------- 布局

def t(n: float) -> int:
    return int(n * T)


def build_foyer() -> Room:
    """入口厅（电梯厅）：只有两个出入口——上墙「HannisHub」标牌下的电梯通往楼上「我的房间」，
    下墙中间开口通往大厅。电梯两侧墙面是像素字 Hannis / Hub，前台接待，右侧等候区。"""
    room = Room("foyer", "入口厅", 20, 13, floor_tex(4, 8), wall_tex(1, 26))
    exit_x0, exit_x1 = t(9), t(11)
    room.bottom_openings.append((exit_x0, exit_x1))
    # 电梯门洞：墙体碰撞只挡住电梯最里侧，角色可以走进电梯
    room.top_openings.append((t(9) + 6, t(11) - 6))
    room.draw_shell()
    w, h = room.w, room.h

    # 墙面：两端彩灯串 + 电梯两侧像素字 Hannis | Hub + 海景挂画
    room.decal("string_lights", t(1.5), 18)
    room.decal("string_lights", t(16.5), 18)
    hannis = pixel_text("Hannis")
    room.bg.alpha_composite(hannis, (t(9) - 6 - hannis.width, 24))
    room.bg.alpha_composite(pixel_text("Hub"), (t(11) + 6, 24))
    room.decal("painting_aqua", t(14) + 2, 24)
    # 地毯：中央迎宾毯 + 等候区 + 出口地垫
    room.rug((t(6), t(5.5), t(14), t(9.5)), floor_tex(8, 20), edge=(40, 36, 70), inner=(150, 140, 200))
    room.decal("rug_red_gold", t(13.5) + 2, t(7) - 4)
    room.rug((exit_x0 + 2, h - 32, exit_x1 - 2, h - 18), floor_tex(12, 26), edge=(60, 40, 30))

    # 电梯（上墙中央）：走近自动开门，走进去上楼到「我的房间」；固定深度 20，角色进入时画在门上。
    # 到达入口厅（开场、从我的房间下楼）时电梯开合一次
    room.doors.append({"key": "elevator", "x": t(9), "y": 16, "radius": 30, "depth": 20})
    room.portals.append({"rect": [t(9) + 8, 22, 16, 12], "to": "room", "spawn": "fromFoyer"})
    room.signs.append({"x": t(10), "y": 10, "text": "HannisHub", "tone": "brand"})
    room.anim("arrow_up", t(10) - 8, 50, depth=h + 100)
    room.signs.append({"x": t(10), "y": 72, "text": "我的房间", "tone": "muted"})

    # 前台：L 形柜台 + 接待员
    room.prop("reception_left", t(1.5), t(3), foot=20)
    room.prop("reception_mid", t(3.5), t(3), foot=20)
    room.anim("receptionist", t(3.5), t(3))
    room.prop("reception_right", t(4.5), t(3), foot=20)
    room.prop("plant_tall", t(1), t(1), foot=12)

    # 右侧等候区
    room.prop("plant_palm", t(16.5), t(1), foot=14)
    room.prop("armchair_blue", t(13.5), t(5.5), foot=14)
    room.prop("armchair_yellow", t(16), t(5.5), foot=14)
    room.prop("table_round", t(14.75), t(7.25), foot=16)
    room.prop("lamp_floor", t(18), t(6.5), foot=8)

    # 左下角长椅与绿植，出口两侧盆栽；两角绿植收进地板范围内（底边不超过下墙）
    room.prop("bench", t(3.5), t(9.5), foot=10)
    room.prop("plant_big", 18, h - 16 - 48, foot=14)
    room.prop("plant_pot", exit_x0 - 20, h - 46, foot=10)
    room.prop("plant_pot", exit_x1 + 4, h - 46, foot=10)
    room.prop("plant_big", w - 16 - 34, h - 16 - 48, foot=14)

    # 出口提示箭头与传送门
    room.anim("arrow_down", (exit_x0 + exit_x1) // 2 - 8, h - 50, depth=h + 100)
    room.signs.append({"x": (exit_x0 + exit_x1) // 2, "y": h - 54, "text": "大厅", "tone": "muted"})
    room.portals.append({"rect": [exit_x0, h - 10, exit_x1 - exit_x0, 10], "to": "hall", "spawn": "fromFoyer"})

    # 出生点放在「我的房间」标牌下方；开场与从楼上下来时电梯开合一次
    room.spawns["start"] = {"x": t(10), "y": 104, "dir": "down", "cycleDoor": True}
    room.spawns["fromRoom"] = {"x": t(10), "y": 104, "dir": "down", "cycleDoor": True}
    # 回到入口厅时站在出口标牌与箭头之外，避免标牌压在角色头上
    room.spawns["fromHall"] = {"x": t(10), "y": h - 62, "dir": "up"}
    room.build_walls()
    return room


# 工位数量：后端 chatworld/lobby_desks.py 的 DESK_COUNT 必须与此一致
DESK_COUNT = 6


def workstation(room: Room, desk_id: str, x: int, top: int, accessory: str) -> None:
    """一个工位：俯视木桌 + 桌面双屏滚动显示器（屏幕与键盘完整落在桌面内）+ 右侧矮柜与桌面小物 + 桌前转椅。
    转椅与桌子水平居中对齐；站到椅子后方按 E 坐下，认领者在自己的工位打开待办。"""
    table = room.put("work_table", x, top + OBJECTS["work_table"].height, foot=16)
    tw = OBJECTS["work_table"].width
    bottom = table["y"] + OBJECTS["work_table"].height
    # 显示器帧 16x32，可见像素 y=4..25：底边（键盘）落在桌面前沿上方 8px；深度紧跟桌子，画在桌面之上
    for mx in (x + 5, x + tw - 21):
        room.anim("monitor", mx, bottom - 8 - 26 + 1, depth=bottom + 1)
    cab = room.put("side_cabinet", x + tw + 2, bottom - 4, foot=12)
    cab_top = cab["y"]
    if accessory == "coffee":
        room.anim("coffee", x + tw + 2, cab_top - 22, depth=bottom - 3)
    else:
        img = OBJECTS[accessory]
        room.put(accessory, x + tw + 2 + (16 - img.width) // 2, cab_top + 4, solid=False, depth=bottom - 3)
    # 转椅：背对镜头（角色面朝屏幕），与桌子居中对齐
    cw = OBJECTS["chair_task"].width
    cx = x + tw // 2
    chair_bottom = bottom + 10
    room.put("chair_task", cx - cw // 2, chair_bottom, solid=[cx - 4, chair_bottom - 5, 8, 5])
    room.desks.append({
        "id": desk_id,
        # 站在椅子正后方（下方）按 E
        "zone": [cx - 14, chair_bottom - 4, 28, 16],
        # 坐下：脚底略高于椅子底边，椅背画在角色前面
        "seat": {"x": cx, "y": chair_bottom - 2, "dir": "up"},
        "signX": cx + 8, "signY": table["y"] - 4,
    })


def build_hall() -> Room:
    """大厅：上墙左侧 HannisHub 像素字，中间玻璃门入口；左上 6 个可认领工位，右上 ASR / OCR 两台机器，
    右侧圆桌聊天角与鱼缸，中部钢琴角，左下休息区，中下茶水间，右下游戏角。"""
    room = Room("hall", "大厅", 40, 26, floor_tex(4, 12), wall_tex(23, 24))
    w, h = room.w, room.h
    door_x = w // 2 - 16
    room.top_openings.append((door_x + 4, door_x + 28))
    room.draw_shell()
    floor_bottom = h - 16

    # ---- 上墙：左上角 HannisHub 像素字，窗与挂饰
    logo = pixel_text("HannisHub")
    room.bg.alpha_composite(logo, (26, 24))
    room.decal("window_curtain", t(9), 18)
    room.decal("world_map", t(12), 16)
    room.decal("window_curtain", t(15), 18)
    room.anim("clock", w - 70, 12, depth=10)

    # ---- 入口：玻璃双开门 + 红色迎宾长毯 + 两侧落地绿植（盆底落在墙脚以下的地板上）
    room.door_recess(door_x)
    room.doors.append({"key": "door_glass", "x": door_x, "y": 0, "radius": 40})
    room.portals.append({"rect": [door_x + 6, 22, 20, 20], "to": "foyer", "spawn": "fromHall"})
    room.rug((door_x + 2, 48, door_x + 30, t(13.5)), floor_tex(4, 14), edge=(70, 30, 30), inner=(214, 160, 90))
    room.put("plant_tall2", door_x - 16, 60, foot=8)
    room.put("plant_tall2", door_x + 34, 60, foot=8)
    room.anim("arrow_up", door_x + 8, 50, depth=h + 100)
    room.signs.append({"x": door_x + 16, "y": 8, "text": "入口厅", "tone": "muted"})

    # ---- 左上：工位区（浅灰地毯上 3x2 共 6 个工位）
    room.rug((22, 54, 280, 216), floor_tex(0, 36), edge=(70, 68, 80), inner=(196, 194, 204))
    accessories = ["lamp_desk_blue", "plant_desk", "coffee", "lamp_desk_cream", "coffee", "plant_desk"]
    n = 0
    for row, top in enumerate((60, 138)):
        for col in range(3):
            n += 1
            workstation(room, f"desk-{n}", 34 + col * 82, top, accessories[n - 1])
    assert n == DESK_COUNT
    room.signs.append({"x": 151, "y": 228, "text": "工位区 · 站到椅子后按 E 坐下 / 认领", "tone": "muted"})

    # ---- 右上：机器区。台前为高亮地台，站上去按 E 交互
    asr_x = door_x + 56
    room.rug((asr_x - 8, 48, asr_x + 88, t(6.5)), floor_tex(8, 20), edge=(110, 54, 40), inner=(217, 119, 87))
    room.anim("speaker", asr_x, 16)
    room.prop("audio_desk", asr_x + 16, 16, foot=16)
    room.anim("speaker", asr_x + 48, 16)
    room.anim("server", asr_x + 64, 16)
    room.anim("wave_screen", asr_x + 82, 22, depth=10)
    room.prop("mic", asr_x + 34, 38, solid=False)
    room.machines.append({
        "id": "asr", "title": "ASR 语音转写", "hint": "上传音频，转写为文字",
        "zone": [asr_x - 6, 58, 92, t(6.5) - 58], "signX": asr_x + 40, "signY": 8,
    })
    ocr_x = asr_x + 112
    room.rug((ocr_x - 8, 48, ocr_x + 88, t(6.5)), floor_tex(8, 30), edge=(40, 60, 100), inner=(106, 155, 204))
    room.prop("kiosk", ocr_x + 4, 16, foot=16)
    room.anim("doc_screen", ocr_x + 22, 14, depth=10)
    room.prop("copier", ocr_x + 56, 16, foot=16)
    room.prop("trash", ocr_x + 72, 30, foot=8)
    room.machines.append({
        "id": "ocr", "title": "OCR 文字识别", "hint": "解析文档、提取字段、图像问答",
        "zone": [ocr_x - 6, 58, 92, t(6.5) - 58], "signX": ocr_x + 40, "signY": 8,
    })
    room.put("plant_palm", w - 16 - 26, 62, foot=8)

    # ---- 右侧中部：圆桌聊天角（椭圆地毯 + 木圆桌 + 四张高脚凳，凳子都能坐），站上地毯按 E 打开聊天室
    cx, cy = t(31), t(11)
    room.rug_round((cx - 60, cy - 42, cx + 60, cy + 42), floor_tex(8, 8), edge=(110, 54, 40), inner=(217, 119, 87))
    tb = cy + 12
    room.put("table_round", cx - 12, tb, foot=14)
    room.anim("coffee", cx - 8, tb - 30, depth=tb + 1)
    # 高脚凳：上方（面朝下）、左右（面朝圆桌）、下方（面朝上）
    stools = [
        ("stool_blue", cx, cy - 20, "down"),
        ("stool_yellow", cx - 30, cy + 8, "right"),
        ("stool_wood", cx + 30, cy + 8, "left"),
        ("stool_blue", cx, cy + 30, "up"),
    ]
    for key, sx, sb, facing in stools:
        sw = OBJECTS[key].width
        room.put(key, sx - sw // 2, sb, solid=[sx - 4, sb - 5, 8, 5])
        seat_y = sb - 2 if facing == "up" else sb + 1
        if facing == "down":
            zone = [sx - 10, sb - 26, 20, 12]
        elif facing == "up":
            zone = [sx - 10, sb - 2, 20, 12]
        elif facing == "right":
            zone = [sx - 22, sb - 10, 14, 16]
        else:
            zone = [sx + 8, sb - 10, 14, 16]
        room.seat(sx, seat_y, facing, zone, title="坐高脚凳")
    room.machines.append({
        "id": "chat", "title": "聊天室", "hint": "和大家一起聊天",
        "zone": [cx - 52, cy - 34, 104, 68], "signX": cx, "signY": cy - 54,
    })
    # 右墙边鱼缸（可喂鱼）与绿植
    fx, fb = w - 16 - 34, cy - 6
    room.anim("fishtank", fx, fb - 32, solid=[fx + 1, fb - 14, 30, 14])
    room.action("fish", "鱼缸", "喂喂小鱼", [fx - 4, fb - 2, 40, 14])
    room.put("plant_big", w - 16 - 26, cy + 44, foot=10)
    room.action("plant", "绿植", "浇浇水", [w - 16 - 34, cy + 42, 34, 14])

    # ---- 中部偏右：白板（今日一句）
    room.put("whiteboard", 356, 170, foot=8)
    room.action("board", "白板", "看看今日一句", [352, 168, 40, 14])

    # ---- 中部：钢琴角（坐上琴凳弹一段）
    px, pb = door_x - 4, 280
    room.rug((px - 22, 238, px + 62, 300), floor_tex(12, 26), edge=(60, 40, 30))
    room.anim("piano", px, pb - 32, solid=[px + 1, pb - 12, 30, 12], frames="once")
    bw = OBJECTS["piano_bench"].width
    room.put("piano_bench", px + 16 - bw // 2, pb + 12, solid=[px + 10, pb + 6, 12, 5])
    room.seat(px + 16, pb + 10, "up", [px + 4, pb + 10, 24, 14], title="弹钢琴")
    room.seats[-1]["play"] = "piano"
    room.put("guitar", px + 38, pb, foot=6)
    room.put("guitar_blue", px + 52, pb + 2, foot=6)
    room.action("guitar", "吉他", "拨一段旋律", [px + 34, pb - 2, 34, 16], sound="guitar")

    # ---- 左下：休息区（正面三人沙发 + 两侧扶手椅 + 茶几，地毯上小火车，书柜、落地灯、睡猫）
    room.rug((22, 248, 236, floor_bottom - 6), floor_tex(12, 28), edge=(50, 60, 90), inner=(220, 230, 245))
    sofa_x, sofa_b = 80, 286
    room.put("sofa_front", sofa_x, sofa_b, foot=12)
    for i in range(3):
        sx = sofa_x + 8 + i * 16
        room.seat(sx, sofa_b + 1, "down", [sx - 7, sofa_b, 14, 14], title="坐沙发")
    for key, ax in (("armchair_red", 40), ("armchair_blue", 148)):
        aw = OBJECTS[key].width
        room.put(key, ax, sofa_b + 2, foot=10)
        room.seat(ax + aw // 2, sofa_b + 3, "down", [ax + aw // 2 - 8, sofa_b + 2, 16, 14], title="坐扶手椅")
    room.put("coffee_table", sofa_x + 5, sofa_b + 34, foot=12)
    room.prop("lamp_floor", 22, 236, foot=6)
    room.put("lamp_floor", 196, sofa_b - 2, foot=6)
    room.anim("cat", 172, 318, depth=334)
    room.action("cat", "猫", "撸一撸", [168, 316, 52, 18])
    room.anim("toytrain", 32, 326, depth=328)
    room.action("train", "小火车", "看小火车转圈", [36, 368, 88, 14])
    room.put("bookshelf_wide", 136, floor_bottom - 8, foot=12)
    room.put("bookshelf", 172, floor_bottom - 8, foot=12)
    room.action("book", "书柜", "翻一本书", [132, floor_bottom - 22, 72, 14])
    room.put("plant_big", 206, floor_bottom - 4, foot=10)

    # ---- 中下：茶水间（橱柜台面 + 咖啡机 + 冰箱），两张小圆桌配侧向餐椅
    kx, kb = 252, 332
    room.put("desk_plain", kx, kb, foot=16)
    room.put("desk_plain", kx + 32, kb, foot=16)
    room.put("bar_shelf", kx + 66, kb, foot=16)
    room.put("espresso", kx + 8, kb - 6, solid=False, depth=kb + 1)
    room.anim("coffee", kx + 40, kb - 34, depth=kb + 1)
    room.put("fridge", kx + 100, kb, foot=14)
    room.action("coffee", "咖啡机", "来一杯咖啡", [kx + 2, kb, 60, 14])
    room.action("fridge", "冰箱", "找点吃的", [kx + 96, kb, 24, 14])
    for tx in (kx + 18, kx + 82):
        tbm = floor_bottom - 10
        room.put("table_round_dark", tx - 12, tbm, foot=14)
        lw = OBJECTS["chair_side_r"].width
        room.put("chair_side_r", tx - 14 - lw, tbm, solid=[tx - 14 - lw + 1, tbm - 6, lw - 2, 6])
        room.seat(tx - 14 - lw // 2, tbm + 1, "right", [tx - 34, tbm - 14, 14, 16], title="坐下")
        room.put("chair_side_l", tx + 14, tbm, solid=[tx + 15, tbm - 6, OBJECTS["chair_side_l"].width - 2, 6])
        room.seat(tx + 14 + OBJECTS["chair_side_l"].width // 2, tbm + 1, "left", [tx + 22, tbm - 14, 14, 16], title="坐下")

    # ---- 右下：游戏角（街机、弹珠机、完整台球桌与球杆架、蛋椅）
    gx0, gx1 = 400, w - 22
    room.rug((gx0, 250, gx1, floor_bottom - 6), floor_tex(4, 20), edge=(60, 40, 40), inner=(170, 120, 100))
    room.put("arcade_a", gx0 + 10, 286, foot=10)
    room.put("arcade_b", gx0 + 28, 286, foot=10)
    room.action("arcade", "街机", "来一局", [gx0 + 8, 286, 38, 14])
    room.put("pinball", gx0 + 50, 286, foot=10)
    room.action("pinball", "弹珠机", "弹一把", [gx0 + 48, 286, 22, 14])
    pool_x = gx0 + 92
    room.put("pool_full", pool_x, 352, foot=30)
    room.action("pool", "台球桌", "打一杆", [pool_x - 6, 352, 60, 14])
    room.put("pool_rack", pool_x + 66, 330, foot=8)
    room.put("egg_blue", gx0 + 14, floor_bottom - 12, foot=10)
    room.seat(gx0 + 23, floor_bottom - 11, "down", [gx0 + 14, floor_bottom - 12, 20, 12], title="坐蛋椅")
    room.put("egg_red", gx1 - 30, floor_bottom - 12, foot=10)
    room.seat(gx1 - 21, floor_bottom - 11, "down", [gx1 - 30, floor_bottom - 12, 20, 12], title="坐蛋椅")
    room.put("lamp_floor_red", gx1 - 18, 290, foot=6)
    room.put("plant_big", gx1 - 74, floor_bottom - 4, foot=10)

    room.spawns["fromFoyer"] = {"x": door_x + 16, "y": 96, "dir": "down"}
    room.build_walls()
    return room


def build_room() -> Room:
    """我的房间：入口厅楼上的小卧室（入口厅乘电梯上来）。下墙中间开口出去，回到入口厅电梯前；
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
# 每行 24 帧按 右/上/左/下 每方向 6 帧（第 4 行坐姿为 右/左 各 6 帧）。导出为与 player.png 相同的 96x320 块：
# 6 帧 x 10 行（静止 南/北/左/右 + 行走 南/北/左/右 + 坐姿 右/左）。
AVATAR_DIR_ORDER = {"down": 3, "up": 1, "left": 2, "right": 0}
# 导出行：(源行, 源起始帧)。前 8 行为静止 南/北/左/右 + 行走 南/北/左/右；
# 第 9、10 行为坐姿（源第 4 行 sit：前 6 帧面朝右、后 6 帧面朝左），侧向座位使用
AVATAR_ROWS = [(1, AVATAR_DIR_ORDER[d] * 6) for d in ("down", "up", "left", "right")] \
    + [(2, AVATAR_DIR_ORDER[d] * 6) for d in ("down", "up", "left", "right")] \
    + [(4, 0), (4, 6)]
SHEET_ROWS = len(AVATAR_ROWS)
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
    out = Image.new("RGBA", (96, 32 * SHEET_ROWS))
    for r, (row, start) in enumerate(AVATAR_ROWS):
        for i in range(6):
            fx = (start + i) * 16
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
    manifest: dict = {"frameWidth": 16, "frameHeight": 32, "blockWidth": 96, "blockHeight": 32 * SHEET_ROWS,
                      "columns": AVATAR_COLS, "categories": {}}
    for slot, folder, optional in AVATAR_CATEGORIES:
        files = sorted((PACK / CHARGEN / folder / "16x16").glob("*.png"))
        rows = (len(files) + AVATAR_COLS - 1) // AVATAR_COLS
        sheet = Image.new("RGBA", (min(AVATAR_COLS, len(files)) * 96, rows * 32 * SHEET_ROWS))
        items = []
        for i, f in enumerate(files):
            sheet.paste(avatar_block(Image.open(f).convert("RGBA")), ((i % AVATAR_COLS) * 96, (i // AVATAR_COLS) * 32 * SHEET_ROWS))
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
        for item in room.seats + room.desks + room.actions:
            x, y, w, h = item["zone"]
            d.rectangle((ox + x, oy + y, ox + x + w - 1, oy + y + h - 1), outline=(255, 80, 220, 200))
        for item in room.seats + [dk["seat"] for dk in room.desks]:
            d.ellipse((ox + item["x"] - 1, oy + item["y"] - 1, ox + item["x"] + 1, oy + item["y"] + 1), fill=(255, 80, 220, 255))
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
    soften_shadows()
    trim_objects()
    build_decals()
    build_anims()
    foyer = build_foyer()
    room = build_room()
    hall = build_hall()

    # 世界排布：自上而下 我的房间 → 入口厅 → 大厅，水平居中对齐。
    # 房间之间留足间距：小房间在大屏上居中显示时，相机视野会超出房间，不能看到相邻房间。
    gap = 256
    foyer_off = (0, room.h + gap)
    room_off = ((foyer.w - room.w) // 2, 0)
    hall_off = ((foyer.w - hall.w) // 2, foyer_off[1] + foyer.h + gap)
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
    # 默认角色：预制角色 12 号，按与形象部件相同的帧布局导出（含坐姿行）
    avatar_block(load(CHARGEN + "0_Premade_Characters/16x16/Premade_Character_12.png")).save(OUT / "player.png", optimize=True)
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
