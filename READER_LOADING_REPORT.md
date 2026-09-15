# 阅读器加载测量与缓存升级验收

日期：2026-09-15。测量来源为生产 `https://vomebook.github.io/search/`，
页面版本 `53faffb6c4a3ccdcd28bbcc363d9c3a3c59bd76b`。
本次预热可靠性与构建修复尚未部署时完成测量；阅读器渲染代码未改。

## 方法与范围

- Chromium 无头浏览器，390×844 视口，未模拟手机 CPU 或限制网络。
- 从生产 API 分别选择一个 1–200 KB 的 TXT、Markdown、原生 PDF，每种三组配对。
- 每组首次打开使用新浏览器上下文并清除 HTTP 缓存；第二次保留该上下文的 HTTP 缓存和阅读历史。
- 禁用 Service Worker，直接打开仅带书籍 ID 的阅读器链接，无搜索页悬停预热。
  因此这些数字不是搜索页点击耗时，也不是本次预热修复的前后速度对比。
- 以导航起点为零点，记录运行时启动、地址解析、格式 open/render、ready 和首次内容观察。
  PDF 必须完成首个页面的渲染，不能仅凭创建 canvas 判定可读。
- 使用浏览器内临时包装器和 CDP 记录，无生产埋点、无安全策略修改。
  各阶段可能包含异步等待；CPU ScriptDuration 单独记录。各列为各自中位数，不应相加。

## 结果

单位：秒，三次中位数。

| 格式 | 首次内容出现 | 缓存后再次出现 | 首次启动阶段 | 首次地址解析 | 首次内容／引擎准备 | 首次 render 阶段 |
|---|---:|---:|---:|---:|---:|---:|
| TXT | 6.228 | 0.113 | 2.388 | 3.402 | 0.527 | 0.209 |
| Markdown | 9.796 | 0.964 | 1.631 | 6.369 | 1.803 | 0.031 |
| PDF | 9.637 | 0.313 | 1.485 | 5.413 | 2.301 | 0.230 |

缓存后二次导航的启动阶段中位数为 51–56 ms，CDP 观察到 13–15 个静态／引擎缓存响应。
首次导航也可能在同一次导航内部复用一个已经加载的资源，不代表缓存未清除。

补充实验保留静态资源缓存，对阅读器 `fetch` 设置 `cache: reload`，重新请求地址和内容：

| 格式 | 首次内容出现 | 启动阶段 | 地址解析 | 内容／引擎准备 | render | 主线程 ScriptDuration |
|---|---:|---:|---:|---:|---:|---:|
| TXT | 1.007 | 0.170 | 0.321 | 0.394 | 0.017 | 0.015 |
| Markdown | 1.395 | 0.195 | 0.317 | 0.791 | 0.031 | 0.035 |
| PDF | 1.377 | 0.142 | 0.334 | 0.812 | 0.068 | 0.041 |

补充实验的 PDF.js 内部请求不完全受 window.fetch 包装器控制，因此 PDF 一行
不能声称排除了所有正文缓存。此实验也会重新请求导航 HTML，因为额外测量参数改变了 URL。

样本：TXT《95%的强化接种率与自愿接种自相矛盾》；Markdown《打倒帝国主义和反动战争!无产阶级国际主义万岁!》；
PDF《活页文选  11  葫芦僧判断葫芦案1》。未测试大书、EPUB、DOCX 或真实手机。
网络/CDN/TLS、跨域预检和服务器缓存都会影响结果；不能将站点差异直接归因于 Python 或 JavaScript 性能。

## 判断

本次样本的首次等待主要在资源获取和地址解析；主线程执行量明显小于等待时间。
现有资源预取值得保留，当前结果不支持增加默认隐藏阅读器初始化。
如继续优化，应先测跨域解析链路和静态资源加载瀑布，保持完整阅读和安全校验。

## 旧缓存升级

以 `888265a` 的 HTML、app 和 Service Worker 为旧客户端，在同一真实 Chromium Cache Storage 中
切换到本次实际构建产物，覆盖旧 HTML／新 app 混合、首次刷新、更新 Worker 后重新打开和离线重载。
旧 HTML 配独立新版 app 曾复现 `VoiceOfMLReaderNavigation is not defined`。
构建阶段将导航模块作为有条件初始化的前缀打入 app 后，所有组合均可启动和显示结果。
固定缓存名 `vomebook-search-v1.0.0`，未增加阅读器预启动。

## 本地复现材料

- `node tests/test_reader_warming.js`
- `python3 -B -m unittest tests.test_reader_navigation_host -v`
- `/tmp/opencode/check_cache_upgrade.py github`：真实旧 Worker 升级验收，需要 `/tmp/opencode/navigation-build-github` 产物。
- `/tmp/opencode/measure_reader_open.py github [shell]`：只读生产计时，完整原始阶段数据位于
  `/tmp/opencode/reader-timing-github.json` 和 `/tmp/opencode/reader-timing-github-shell.json`。

临时材料为本机验收记录，不作为站点运行文件发布。
