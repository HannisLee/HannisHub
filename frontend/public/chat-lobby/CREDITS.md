# 聊天大厅素材来源与许可证

本目录素材仅供 HannisHub「聊天大厅」场景使用，来源与授权如下。

## 室内与人物素材（club/）

- 来源：Limezu — Modern Interiors（付费完整版，用户已购买）
  https://limezu.itch.io/moderninteriors
- 许可：见 `club/LICENSE.txt`。允许在商业与非商业项目中使用与修改；
  不得将素材单独转售或再分发；**要求署名（limezu.itch.io）**。
  本项目将其作为内置场景资源使用，保留原始许可证，并在聊天大厅页面底部署名。
- 原始包（16x16 / 32x32 / 48x48 三档分辨率、角色生成器、动画物件、户型参考图）未整体入库，
  仅提取本场景所需部分。原始包完整解压在本机 `chatworld/asset/modern_interiors/`（不入库），
  速查索引见 `chatworld/asset/asset_index.md`。
- 派生文件（本项目自原始包裁剪 / 拼接 / 烘焙，仍受上述许可约束），除 `player.png` 外
  全部由 `scripts/build_chat_lobby_assets.py` 生成，来源路径相对原始包目录：
  - `club/room.png`：我的房间背景（Room_Builder 木地板与墙面，烘焙 Generic 窗帘窗与地毯）。
  - `club/avatar/*.png` + `club/avatar/parts.json`：角色生成器分层部件，取自
    `2_Characters/Character_Generator/` 的 Bodies、Eyes、Outfits、Hairstyles、Accessories（16x16 档），
    每件只保留静止与行走帧并重排为 96x256 块（与 `player.png` 同布局），按类别拼成图集，前端运行时叠层合成。
  - `club/foyer.png`、`club/hall.png`：入口厅与大厅背景。地板取自
    `1_Interiors/16x16/Room_Builder_subfiles/Room_Builder_Floors_16x16.png`，墙面取自
    `Room_Builder_Walls_16x16.png`；墙顶收边、墙脚阴影、区域地毯边框与入口厅墙面像素字「Hannis」「Hub」为脚本绘制；
    窗帘窗、挂画、地图、软木板、彩灯串、小地毯烘焙其中（`Theme_Sorter/1_Generic_16x16.png`
    与各主题 `Theme_Sorter_Singles`）。
  - `club/objects.png` + `club/objects.json`：家具图集（Phaser JSON Hash），单件取自
    `Theme_Sorter_Singles` 的 Living Room、Basement、Classroom and Library、Conference Hall、
    Television and Film Studio，办公椅、长椅与穿衣镜裁剪自 Generic 总表，单人床、床头柜与衣柜裁剪自
    `Theme_Sorter/4_Bedroom_16x16.png`。
  - `club/anims/*.png`：动画帧条，取自 `3_Animated_objects/16x16/spritesheets`：
    玻璃双开门 32x48（8 帧）、电梯 32x32（14 帧，作为通往我的房间的自动门）、接待员 16x32（7 帧）、
    滚动屏显示器 16x32（12 帧）、音箱 16x48、机柜 16x48、文档屏 32x32（5 帧）、
    咖啡 16x32（6 帧）、猫 48x16（12 帧）、鱼缸 32x32（8 帧）、布谷鸟钟 16x32（10 帧）；
    `wave_screen` 为 X 光机监视器波形区域逐帧截取（16x16，14 帧）；
    `arrow_down`、`arrow_up` 由 `4_User_Interface_Elements/Animated_Spritesheets/UI_arrow_pointing_down_16x16.gif`、
    `UI_arrow_pointing_up.gif` 转为帧条。
  - `club/layout.json`：房间布局数据（非图像）。
  - `club/player.png`：取预制角色 `Premade_Character_12`（16x16 档）的静止与行走动画，
    重排为 6 帧 × 8 行（16x32 帧）：静止 南/北/左/右 + 行走 南/北/左/右。

## 署名

Modern Interiors by Limezu — https://limezu.itch.io/moderninteriors
