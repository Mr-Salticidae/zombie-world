# 部署房间服务器

一台机器就够。这里假设是**香港/境外节点**（免备案），Caddy 终止 TLS 并反代给本机的 Node。

游戏本体仍然发在 Toy 平台上；这台机器**只做房间中转**，不发游戏文件。

## 为什么必须是 wss:// 而不是 ws://

Toy 页面是 https 打开的，浏览器会直接拒绝从 https 页面连 `ws://`（混合内容）。
所以必须有域名 + 证书。IP 签不了证书，这一步绕不过去。

## 一个最容易踩的坑：Origin 填什么

游戏**不是**跑在 `bilibili.com` 上。线上真实结构是：

```text
https://www.bilibili.com/toy/<slug>          ← 宿主页
  └─ <iframe src="https://www.bilibilitoy.com/toy/<slug>/<id>-v<ver>/index.html">
                    ↑ 游戏跑在这个源上，WebSocket 的 Origin 就是它
```

所以 `ALLOWED_ORIGINS` 必须包含 **`https://www.bilibilitoy.com`**。
填成 `https://www.bilibili.com` 的表现是「连接被拒绝」，而且从客户端根本看不出为什么。

## 步骤

### 1. 装 Node 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### 2. 放代码

只需要 `server/`、`multiplayer.js`、`package.json`、`package-lock.json`：

```bash
sudo mkdir -p /opt/zombie-world && sudo chown "$USER" /opt/zombie-world
cd /opt/zombie-world
git clone --depth 1 <你的仓库地址> .
npm ci --omit=dev            # 只装 ws
```

### 3. systemd

把 `zombie-world.service` 拷到 `/etc/systemd/system/`，**先改里面的 `ALLOWED_ORIGINS`**：

```bash
sudo cp server/deploy/zombie-world.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zombie-world
systemctl status zombie-world --no-pager
```

服务只监听 `127.0.0.1:8080`，不直接对外——对外那一层交给 Caddy。

### 4. Caddy（自动签证书）

```bash
sudo apt-get install -y caddy
sudo cp server/deploy/Caddyfile /etc/caddy/Caddyfile   # 先把域名改成你的
sudo systemctl reload caddy
```

域名要先解析到这台机器的 IP，Caddy 才签得下来。云控制台的安全组要放行 **80 和 443**
（80 是 Let's Encrypt 验证要用的，不能只开 443）。

### 5. 验一下

```bash
curl -sS https://你的域名/healthz          # 期望 {"ok":true,...}
```

然后把域名填进 `multiplayer.js` 顶部的 `SERVER_DEFAULT`，重新打包发布游戏。

## 运维

```bash
journalctl -u zombie-world -f        # 实时日志
systemctl restart zombie-world       # 重启
```

更新代码：

```bash
cd /opt/zombie-world && git pull && npm ci --omit=dev && sudo systemctl restart zombie-world
```

## 容量与带宽

快照瘦身 + `permessage-deflate` 之后（实测，平均 21 只敌人）：

| | |
|---|---|
| 每客机 | **28 KB/s ≈ 0.22 Mbps** |
| 4 人房（服务器下行） | **83 KB/s ≈ 0.7 Mbps** |
| 每客机每小时流量 | **约 100 MB** |

所以一台 5 Mbps 的小机器能同时扛 **6~7 个 4 人房**；1TB/月的流量额度约等于
**10000 客机小时**。服务器内建的上限是 128 连接 / 64 房间，真正先到顶的是带宽不是连接数。

要调的话，服务器读这些环境变量（见 `server/server.js` 末尾）：
`PORT` `HOST` `ALLOWED_ORIGINS`。
