# 欢乐斗牛部署到 Render

这个项目是 Node.js + Socket.IO，需要部署为 Render Web Service，不要部署成 Static Site。

## 费用

Render 当前有 Free Web Service，可以先免费测试。免费服务适合好友临时玩；如果要更稳定，后面可以升到 Starter。

## 部署步骤

1. 把 `doudou-online` 文件夹上传到 GitHub 仓库。
2. 打开 Render，创建 `New` -> `Web Service`。
3. 连接你的 GitHub 仓库。
4. 如果 Render 自动识别到 `render.yaml`，直接确认创建。
5. 如果需要手动填写：
   - Runtime: `Node`
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path: `/`
6. 部署完成后，打开 Render 给你的公网网址。

## 注意

- 房间数据保存在服务器内存里，服务重启后房间会消失。
- 公网部署后二维码会自动使用 Render 的网址，不再使用局域网 IP。
- 如果绑定自己的域名，可以在 Render 的 Custom Domains 里配置。
