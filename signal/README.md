# 信令服务

一个只干一件事的服务：**把房主的码递给客机、把客机的码递回房主，然后消失。**

游戏数据仍然全程 P2P，一个字节都不经过它。它不碰游戏逻辑、不做房间状态机
（那套仍然跑在房主页面里的 `p2p.js`）、不存任何能标识玩家的东西。一间房活 2 分钟。

它的存在只为解决一件事：**进房太麻烦**。原来两个人要互发两串 600+ 字符的码，
现在房主拿一个 4 位数字，对方输进去就行。

## 为什么是 Durable Object 而不是 KV

信令状态只活 2 分钟，放 DO 内存里正合适。KV 免费层**每天只能写 1000 次**，
一局要写 2 次 = 500 局/天就到顶；DO 没有这个坎，只剩 Workers 的 10 万请求/天，
按轮询算一局约 15 个请求 → 约 6000 局/天。SQLite-backed DO 在免费层可用，且免费层不计存储费。

## 文件

| | |
|---|---|
| `room.js` | **全部业务逻辑**。不碰任何 Cloudflare API，纯函数进出，所以能在 `node:test` 里把整条握手跑完 |
| `worker.js` | Cloudflare Worker 入口 + 两个 Durable Object。只做路由、CORS、转发 |
| `dev-server.js` | 本地跑的同一套接口，共用 `room.js`，所以两边行为不可能漂移 |
| `wrangler.toml` | 部署配置 |
| `../test/signal.test.js` | 22 条单测，跑 `npm test` |

## 部署（一次性，约 5 分钟）

```bash
npm install -g wrangler
wrangler login
cd signal
wrangler deploy
```

部署完会打印一个地址，形如 `https://zombie-signal.<你的账号>.workers.dev`。
**把它填进 `p2p.js` 顶部的 `SIGNAL_DEFAULT`**，然后重新打包发布游戏：

```js
const SIGNAL_DEFAULT = "https://zombie-signal.xxx.workers.dev";
```

`SIGNAL_DEFAULT` 留空 = 这条路整个关掉，联机页只显示邀请码那一套。**所以在填之前，
线上行为和现在一模一样**，不会因为服务没部署好而把联机搞坏。

### 换地址不用重新发版

`p2p.js` 会优先读 `localStorage` 里的 `zombie-world-signal`：

```js
localStorage.setItem('zombie-world-signal', 'https://别的地址')
```

真机排查、临时换托管时用这个，不用重新过审。

## 本地开发

```bash
node signal/dev-server.js          # 默认 8787
```

然后在游戏页面的控制台里指过来：

```js
localStorage.setItem('zombie-world-signal', 'http://localhost:8787')
```

两个浏览器标签页就能演完整条流程（一个开房拿号，一个输号加入）。

## 接口

| | | |
|---|---|---|
| `POST` | `/new` | body `{offer,name}` → `{code,token,ttl}`；开房，`code` 是 4 位数字 |
| `GET` | `/offer?code=` | → `{offer,name}`；房间不在或过期给 404 |
| `POST` | `/answer?code=` | body `{answer,name}`；已经有人应答过给 409（先到先得） |
| `GET` | `/answer?code=&token=` | → `{answer,name}`；还没人应答给 204，令牌不对给 403 |
| `POST` | `/close?code=&token=` | 连上之后主动销毁，把号早点还回号池 |
| `GET` | `/health` | 客户端启动时探这个，探不通就只显示邀请码那条路 |

几条刻意的取舍：

- **CORS 一律放开。** 这里没有任何要保护的东西：房间只活 2 分钟、内容是一次性的 SDP、
  也不存任何能标识玩家的信息。收紧到某个 Origin 反而会在 B站 换域名那天把联机整个搞挂，
  而那种故障在真机上极难查。滥用靠建房限流挡，不靠 Origin。
- **令牌只保护房主那一侧。** 知道房间号就能取 offer、能回 answer——房间号本来就是要告诉队友的。
  但取走应答、销毁房间需要令牌，否则别人猜到号就能替房主把队友截走。
- **应答先到先得。** 第二个人来只会拿到 409，不会把前一个人的应答顶掉。
- **建房限流**：一个 IP 10 分钟内最多开 15 间房。只限建不限读——读要先知道 4 位号，
  本身就有门槛；建房才是能把配额烧光的那个动作。

## 已知的坑

- **workers.dev 在国内的可达性没验证过。** 这是整个方案最大的风险，只能靠真机在无代理的
  网络上验。所以客户端把地址做成了可换的，并且**永远保留复制粘贴码作为兜底**。
- **信令通了不代表能连上。** 这个服务只解决「进房」，不解决「局域网直连本身通不通」——
  后者要靠 `tools/webrtc-probe.html` 的真机结论。
