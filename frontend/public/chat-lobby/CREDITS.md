# 聊天大厅素材来源与许可证

本目录素材仅供 HannisHub「聊天大厅」场景使用，来源与授权如下。

## 室内与人物素材（modern/）

- 来源：Limezu — Modern Interiors（付费完整版，用户已购买）
  https://limezu.itch.io/moderninteriors
- 许可：见 `modern/LICENSE.txt`。允许在商业与非商业项目中使用与修改；
  不得将素材单独转售或再分发；**要求署名（limezu.itch.io）**。
  本项目将其作为内置场景资源使用，保留原始许可证并在页面素材说明中署名。
- 原始包内容（16x16 / 32x32 / 48x48 三档分辨率、角色生成器、动画物件、户型参考图）
  未整体入库，仅提取本场景所需部分，避免仓库体积膨胀。
  原始包完整解压在本机 `chatworld/asset/modern_interiors/`（不入库），下文来源路径均相对该目录；速查索引见 `chatworld/asset/asset_index.md`。
- 派生文件（本项目自原始包提取/拼接/改色，仍受上述许可约束）：
  - `modern/tiles_sheet.png`：25 块 16x16 地板/墙壳砖横向图集，供 Phaser tilemap 使用。
    索引顺序（0 起）：0 地板、1 地板变体、2 墙顶、3 墙面、4/5 墙顶左右角、6/7 墙面左右斜角、
    8/11 侧墙上段外/外右、9/10 侧墙上段透视斜肩左/右、12/15 侧墙中段外左/外右、
    13/14 侧墙中段斜肩左/右、16/19 侧墙下段外左/外右、17/18 侧墙下段斜肩左/右、
    20/21 侧墙中段左/右、22/24 底边左右角、23 底边。
    全部裁剪自包内官方预拼房间 `6_Home_Designs/Condominium_Designs/16x16/Condominium_Design_layer_1.png`
    的同套砖块，保证透视斜肩与收边连贯（直接拼 Walls/borders 表易错接）。
  - `modern/objects/*.png`：家具单件（沙发、单人椅、茶几、书柜、储物柜、电脑桌、椅子、
    电视柜、饮水机、挂画、绿植、落地灯），取自 `Theme_Sorter_Singles` 的
    Living Room / Conference Hall / Japanese Interiors 主题。
  - `modern/objects/rug.png`：以 Japanese Interiors 榻榻米单件为底，按亮度映射改色为暖陶土色
    区域毯，并在中段插入 16 列同纹样扩为 48x32（边框仍只在四周）。
  - `modern/objects/tv.png`、`clock.png`、`cat.png`、`door.png`：动画物件 spritesheet，
    取自 `3_Animated_objects/16x16/spritesheets`（旧电视、布谷鸟钟、猫、木门）。
    原生帧宽：电视 32x32（6 帧）、布谷鸟钟 16x32（10 帧）、猫 48x16（12 帧）、门 16x32（5 帧）。
  - `modern/player.png`：取预制角色 `Premade_Character_12`（16x16 档）的静止与行走动画，
    重排为 6 帧 × 8 行（16x32 帧）：静止 南/北/左/右 + 行走 南/北/左/右。

## 署名

Modern Interiors by Limezu — https://limezu.itch.io/moderninteriors