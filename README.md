# 僵尸危机：方块头 · 经典复刻版

一个 HTML5 Canvas 俯视角射击小游戏，致敬经典 Boxhead 玩法。单机客户端零构建，可直接部署到静态托管或上传至 B 站 toy 网页小游戏平台；互联网联机另需运行 Node.js WebSocket 服务。

## 项目简介

玩家将在五张不同风格的俯视角战场中抵挡一波波僵尸和特殊敌人的进攻，通过连续击杀提升连击倍率，并逐步解锁更强武器。游戏内置键盘、鼠标和触屏操作，适合直接在浏览器中体验。

## 主要特性

- 单机客户端为纯前端实现（`index.html` + `style.css` + `script.js` + `multiplayer.js`），无需前端打包工具
- Canvas 渲染的俯视角动作射击玩法
- 独立地图选择页，五张地图均带实景缩略图卡片
- 美化主菜单，包含动态标题、特色徽章、氛围背景和僵尸剪影
- 菜单、暂停、结算、地图选择和操作说明界面
- 键盘经典模式、鼠标射击模式和移动端触屏摇杆（横屏竖屏都能玩）
- 9 种武器、5 张地图、5 级 BOSS、无双大招、3 档难度
- 接 Toy JS SDK 的排行榜：得分榜 / 坚守波数榜，总榜与本周榜（仅统计标准难度）
- 波次刷怪、连击倍率、武器解锁、掉落补给和爆炸连锁
- Web Audio 实时合成音效，无需额外音频资源

## 如何运行（本地开发）

`index.html` 通过相对路径引用 `style.css`、`multiplayer.js` 与 `script.js`，浏览器对 `file://` 直接打开有安全限制，建议起一个本地静态服务：

```bash
# 在项目根目录执行任意一种
python -m http.server 8000
# 或
npx serve .
```

然后浏览器访问 `http://localhost:8000/`。推荐使用 Chrome、Edge、Firefox 等现代浏览器。

## 2–4 人联机模式（入口默认关闭）

> 🔴 **主菜单里的联机入口目前是关掉的**（`script.js` 顶部 `ONLINE_ENABLED = false`）。
> 联机需要一台**自己的公网 WSS 服务器**——Toy 只托管静态包、不跑 Node。线上没有服务器时，
> 玩家点进联机大厅只会看到「联机服务器连接中断」，那是个必坏的按钮，所以先摘掉止血。
> 代码原样保留（`multiplayer.js` / `server/` / `test/`）：把服务器架好、在 `multiplayer.js`
> 里换掉默认服务器地址，再把 `ONLINE_ENABLED` 改成 `true`，入口就回来了。
> 关闭状态下也不会自动恢复上一局联机会话，避免老玩家一进来就被丢进进不去的大厅。

联机版采用「WebSocket 房间服务器 + 房主权威模拟」：

- 2–4 人通过 6 位房间码加入，同一房间共享地图、敌人、波次、掉落和团队得分
- 客端只发送移动、瞄准、开火、武器和大招输入；房主推进战局并广播权威快照
- 10 秒断线重连窗口；队友倒地后，队伍撑到下一波即可复活
- 房主掉线超过窗口后房间关闭；当前版本不做房主迁移、公开匹配、聊天或长期战绩
- 单人模式不会发起网络请求，联机服务不可用也不影响原有单机玩法
- 当前权威模拟运行在房主浏览器；房主必须保持游戏页面在前台，否则浏览器后台节流会暂时冻结全房战局

联机开发与本地测试：

```bash
npm install
npm start
```

访问 `http://localhost:8080/`，打开 2–4 个浏览器窗口，使用同一房间码即可联调。
服务器同时托管静态客户端和 `/ws` WebSocket 端点；也可以将静态客户端部署到其他域名，
在联机大厅填写独立的 `wss://你的域名/ws`。

运行自动化测试：

```bash
npm test
node --check script.js
node --check multiplayer.js
```

本地启动默认仅监听 `127.0.0.1`。生产环境至少应显式配置公网监听、HTTPS/WSS、
反向代理和 Origin 白名单：

```bash
HOST=0.0.0.0 ALLOWED_ORIGINS=https://你的游戏域名.example npm start
```

> B 站 Toy 包只包含静态客户端，`server/`、证书、环境变量和 `node_modules/` 不会打包进去。
> Toy 官方文档尚未明文承诺 WebSocket；公开发布前应先向 Toy 运营报备固定 WSS 域名、
> 传输字段和数据策略，取得书面确认，再完成 App 真机预览。

## 打包上传（B 站 toy 平台）

平台要求扁平的文件结构（`index.html` 为必需入口），运行打包脚本即可生成符合要求的压缩包：

```powershell
powershell -ExecutionPolicy Bypass -File tools\package.ps1
```

产物为 `release/zombie-world.zip`，包内结构：

```text
zombie-world.zip
├── index.html        # 必需，入口文件
├── style.css
├── script.js
├── multiplayer.js
└── images/
    ├── logo.png      # 封面
    └── banner.jpg    # 横幅
```

> 封面/横幅/海报可用 `python tools/make_cover.py` 重新生成，或直接替换 `images/` 下的图片为自己的设计。
>
> `images/poster.png`（1200×900，4:3）是**上传平台用的封面**，不进游戏、也不需要进 zip：
> Toy 的列表卡片与公开动态卡片按 4:3 取图，3:1 的 `banner.jpg` 放进卡片会被裁掉两头。

### 🔴 发布目标：只更新公开版

线上有两个 Toy，**以后只更新公开版这一个**：

| | id | slug | 可见性 | 状态 |
|---|---|---|---|---|
| **公开版（唯一维护目标）** | `19242799980544` | `zombie-crisis-boxhead` | PUBLIC | 在维护 |
| 旧版（冻结保留） | `2485653607424` | `A597enE8Bcg3a7D0` | LINK_ONLY | **停更**，勿再发包 |

```powershell
# 更新线上公开版（预览 → 人工确认 → 加 --yes 才真正提交审核）
toy update 19242799980544 release\zombie-world.zip --poster images\poster.png --json
```

旧版之所以留着不删：**玩家反馈的评论都挂在它的关联动态上**（2026-08 那批手游反馈就是从那儿来的），
删了评论就没了。它不能改成公开——Toy 平台规定 link-only 无法转公开，只能换 slug 新建，
公开版正是这么来的。详见上文《Toy 平台能力（JS SDK）》同批查证记录。

## Toy 平台能力（JS SDK）—— 查证记录 2026-08-07

结论先写在这：**Toy JS SDK 没有联机 / 实时同步 / 房间能力，不要再指望用它做多人对战。**

核查方式：从发布平台前端包（`//s1.hdslb.com/bfs/static/toy/app/publish/assets/index-*.js`）里取出
SDK 文档数据，并直接下载 SDK 本体 `//s1.hdslb.com/bfs/seed/toy/app/sdk/toy-sdk.js` 检索。
**SDK 版本 1.5.0，更新于 2026-07-31**，全部能力共 18 个：

| 分类 | API | B站 App | Web 端 |
|---|---|---|---|
| 容器 | `isSupport` `navigate` | ✅ | ✅ |
| 容器 | `saveImageToAlbum` `closeBrowser` | ✅ | — |
| 用户/作者 | `getUserProfile` `getAuthorProfile` `getAuthorVideos` `getAuthorRelation` `getVideoUserActions` | ✅ | ✅ |
| 云存储 | `setCloudStorage` `getCloudStorage` `removeCloudStorage` | ✅ | ✅ |
| 排行榜 | `submitScore` `getRankList` `getMyRank` | ✅ | ✅ |
| 媒体 | `requestCamera` `requestMicrophone` `stopMedia` | ✅ | ✅ |

在 `toy-sdk.js` 里精确检索：`websocket` / `createRoom` / `joinRoom` / `roomId` / `realtime` /
`multiplayer` / `matchmaking` **均为 0 次命中**。文件里出现 140 多次的 `room` 全部来自
`liveRoomHalf.*`（B站直播间 JSBridge，SDK 顺带打包的通用桥），与游戏联机无关；
唯一一处 `RTCPeerConnection` 是 SDK 与宿主容器通信的内部管道，不是对外能力。

要做「不用自建服务器的多人感」，方向是**排行榜 + 云存储**（异步竞争而非实时同框）：

- 排行榜按「toy + 榜位 + 周期」隔离；榜位固定 `1/2/3`（含义自定，如榜1 得分、榜2 波数）；
  周期 `all`（永久）/ `month` / `week` / `day`
- 分数为整数，范围 `-16777216 ~ 16777215`，允许 0 与负数；固定从高到低排序，
  同分先达成者靠前（先到先赢），名次唯一不并列
- **读榜游客可读**，上报分数需登录；判断是否上榜必须看返回的 `ranked` 字段，**不能用 `score` 判断**
- 云存储按「登录用户 + Toy」隔离，单个 Toy 最多 128 个 key-value，需登录但不触发用户数据确认
- 接入前一律先 `await toy.isSupport('xxx')` 判断，SDK 缺失/环境不支持时要能降级

文档入口：发布平台页内路由 `/sdk`（「开放能力」→ JS SDK / CLI / Skill 三个页签）。

## 排行榜

已接入，用的就是上面那套 SDK。设计取舍写在这里，免得后面看代码猜：

- **榜位**：`1` = 得分榜，`2` = 坚守波数榜，`3` 预留。**周期**只开了「总榜」`all` 与「本周」`week`。
- **只收标准难度**。轻松打得轻松、硬核敌人更多分自然更高，混进同一个榜这榜就废了；
  非标准难度的局在结算页明说「不计入排行榜」，不偷偷丢弃也不假装上传。
- **不擅自弹确认框**。首次上榜要由玩家点结算页的「上传成绩到排行榜」触发
  （平台会弹一次数据确认）；同意过一次后记在 `localStorage`，之后每局自动上传。
- 服务端只保留历史最高分，重复上报不会把成绩刷低，所以上传逻辑不用自己比大小。
- **读榜游客可读**，`getMyRank` 未登录会抛错——这属于正常路径，静默降级为不显示「我的排名」，
  不弹错误。判断是否上榜一律看 `ranked` 字段，不能用 `score`（分数允许为 0/负）。
- 榜单里的昵称是**别人可控的文本**，一律走 `textContent` 构建 DOM，不拼 `innerHTML`。
- **拿不到 SDK 的环境**（本地开发、站外托管、CDN 挂掉）：主菜单排行榜入口保持隐藏、
  结算页一个字都不提排行榜，游戏本体完全不受影响。

分数上限 16777215，本作实际到不了；上报前仍统一 `clampScore` 夹到 `0 ~ 16777215` 并取整。

## 操作方式

**电脑**

- 移动：`W` `A` `S` `D` 或方向键
- 射击：鼠标左键 / `空格` / `J`
- 切换武器：鼠标滚轮 / `Q` / `E` 或数字键 `1` 到 `9`（自动跳过没弹药的枪）
- 无双大招：`R`
- 暂停：`P` 或 `Esc`
- 鼠标模式：左键点击或按住朝指针方向攻击，右键点击或按住移动

**手机 / 平板**

- 移动：按住**屏幕左半边**拖动，就地生成摇杆
- 射击：按住**屏幕右半边**即开火——按住不动打当前朝向，拖动则决定射击方向
- 切换武器：点右下角**换枪**键循环，或**直接点最下面那排武器格**指定一把
- 无双：右下角红色圆键 ｜ 暂停：左上角 `❚❚`
- 进入战斗时会浮一层操作说明，碰一下屏幕即消失

## 多设备适配

参照官方《Toy 多设备自适应设计参考》（见 [docs/toy-responsive-guide.md](docs/toy-responsive-guide.md)）做了手机 / 平板 / PC 三档适配：

- **画布等比缩放**：逻辑用虚拟坐标，渲染时按容器尺寸映射真实像素，不写死宽高。
- **按物理像素出图**（2K/4K 屏发糊的根因）：画布后备缓冲区曾经恒为 `VW×VH` 个像素，
  却被 CSS 拉伸到整块屏幕——2K 屏上等于把 960 宽的位图放大 2.25 倍，再叠 `devicePixelRatio`，
  屏越大越糊。现在后备缓冲区按 **CSS 尺寸 × dpr** 出真实物理像素，
  绘制坐标仍走虚拟坐标系（`ctx.setTransform` 负责换算），游戏逻辑一行没改。
  预渲染的地面大图跟着升清，步进 `1 / 1.5 / 2`（2× 时 3840×2560 约 39MB，手机封顶 1.5×），
  跨档才重建，拖窗口不会反复重画。
- **横竖屏都能玩**：横屏（含 PC）用经典 `960×640` 视口；**竖屏换成等面积的竖版视口**（如 `581×1057`），
  可视面积保持 61 万像素不变，竖着玩不会因为看得少而变难。竖屏只弹一条可关掉的提示横幅，
  **不再冻结游戏**——B站 App 内嵌 WebView 常常锁竖屏，转不过来的人以前是直接玩不了。
- **安全区**：`viewport-fit=cover` + `env(safe-area-inset-*)`，画布与界面避开刘海、底部指示条。
- **移动端可视区**：用 `100dvh` 处理地址栏展开收起；监听 `resize` / `orientationchange` / `visualViewport` 重算画布。
- **输入分层**：`pointer:coarse` 判定触摸设备显示虚拟摇杆，PC（鼠标/键盘）隐藏摇杆；三套输入共用一套游戏逻辑。
- **触屏按钮按画布实位摆放**：换枪 / 无双 / 暂停由 JS 依 `getBoundingClientRect` 定位，
  保证压不到底部武器栏，也不会掉进刘海或圆角。
- **性能**：手机端自动降低粒子数量与爆炸碎屑上限，缓解低端机卡顿。

可在浏览器开发者工具的设备模拟下，分别检查手机竖/横屏、平板、PC 表现。

## 画质（分辨率倍率）

主菜单可切三档，选择记在 `localStorage`；按钮上会显示当前实际倍率（如「画质：自动（2.3×）」），
方便直接看出这一档有没有生效：

| 档位 | 渲染倍率上限 | 说明 |
| --- | --- | --- |
| 自动 | 电脑 2.5× / 手机 2× | 跟随 `CSS 尺寸 × devicePixelRatio` |
| 流畅 | 1× | 等同旧行为，最省性能 |
| 极清 | 3× | 榨干屏幕，老机器慎选 |

## 难度

主菜单可切三档，选择记在 `localStorage`：

| 档位 | 敌人数量 | 敌人血量 | 受到伤害 | BOSS 血量 |
|---|---|---|---|---|
| 轻松 | ×0.75 | ×0.8 | ×0.7 | ×0.72 |
| 标准 | ×1 | ×1 | ×1 | ×1 |
| 硬核 | ×1.3 | ×1.3 | ×1.35 | ×1.45 |

BOSS 排布：第 1–5 波五级递进，**第 6 波起在前四级之间轮转**并逐波变强，
**每逢 5 的倍数波**僵尸博士登场。第 5 波之后不再是每波都打满技能博士。

## 文件结构

```text
.
├── index.html        # 入口页面（必需）
├── style.css         # 全部样式
├── multiplayer.js   # 原生 WebSocket 客端、房间会话与断线重连
├── script.js         # 全部游戏逻辑（渲染、输入、波次、敌人/BOSS AI、Web Audio 音效合成）
├── images/           # 平台封面素材
│   ├── logo.png      #   封面 1280×720
│   ├── banner.jpg    #   横幅 1920×640
│   └── poster.png    #   平台封面 1200×900（4:3，上传用，不进游戏）
├── server/
│   └── server.js     # 静态托管、WebSocket 房间与重连服务
├── test/
│   └── server.test.js # 房间、权限、限流与重连测试
├── tools/            # 开发辅助脚本（不进 zip）
│   ├── make_cover.py #   生成封面/横幅/平台海报
│   └── package.ps1   #   打包成平台 zip
├── docs/             # 参考文档（不进 zip）
│   └── toy-responsive-guide.md  # 官方多设备自适应指南
├── package.json      # Node 20+ 启动与测试脚本
├── README.md
└── .claude/launch.json   # 本地静态预览配置
```

## 说明

`index.html` / `style.css` / `multiplayer.js` / `script.js` 为静态客户端，`images/` 为平台展示用素材。
互联网联机还需要运行 `server/server.js`，它不进入 Toy 静态包。
`tools/` 与 `release/` 仅用于本地开发与打包，不影响游戏运行。
