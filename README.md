# Search — GitHub Pages

[在线站点](https://vomebook.github.io/search/) · [Hugging Face Space](https://huggingface.co/spaces/VoiceOfML/Search) · [Reader CI](https://github.com/vomebook/search/actions/workflows/reader-refactor.yml)

这是资料搜索和阅读的静态站点。Pages 提供搜索索引和阅读器；Space 是**独立仓库**，提供后端 API 和自己的前端部署。两边共享部分 Reader 代码和测试，但入口、资源路径、PDF 范围请求实现和部分覆盖率基线不同。修改共享功能时应分别检查并验证两边，不要整体覆盖同步。

## 目录

- `static/`：Pages 资源和入口；`search/` 是搜索组件，`reader/` 按核心、格式、PDF、搜索、界面划分，`sw.js` 是 Service Worker。
- `data/`：站点使用的搜索和目录数据。
- `tests/`：Node、Python 和浏览器测试；已整理的领域测试放在 `tests/search/` 和 `tests/reader/`。PDF 全文搜索见 `tests/reader/pdf-search/README.txt`，PDF v3 清单校验见 `tests/reader/pdf-v3/README.txt`，PDF 网络见 `tests/reader/pdf-network/README.txt`，请求和文档加载见 `tests/reader/transport/README.txt`，章节、布局和图片分别见 `tests/reader/chapters/`、`tests/reader/layout/` 和 `tests/reader/images/`。
- `scripts/build/`、`scripts/data/`：构建与数据获取；`scripts/reader/`、`scripts/search/` 是按领域归组的检查，其他检查暂留在 `scripts/`。
- `.github/workflows/`：Pages 构建发布及双站 Reader 回归；`typings/` 和 `jsconfig*.json` 定义前端类型检查边界。

## 本地检查

CI 使用 Node **26.11.1** 和 Python **3.11.17**。在仓库根目录、支持执行文件和符号链接的文件系统中安装并运行基本静态检查：

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 -m pip install -r requirements-static-check.txt
npm run check:static
python3 -B scripts/check_python_static.py
```

Android 共享存储常以 `noexec` 挂载，也可能不支持符号链接；请将源码检出或复制到私有、支持执行和符号链接的目录，再在那里安装依赖。不要把共享存储中的 `node_modules` 当作可执行的安装结果。

按改动运行 Reader 分域检查，完整列表见 [`scripts/reader/README.txt`](scripts/reader/README.txt)。例如 PDF v3 和搜索缓存的定向门禁：

```sh
node scripts/reader/check_reader_v3_coverage.mjs
node scripts/reader/check_reader_v3_mutations.mjs
node scripts/reader/check_pdf_book_client_coverage.mjs
node scripts/reader/check_pdf_text_store_coverage.mjs
node scripts/reader/check_pdf_text_store_mutations.mjs
```

v3 覆盖率只统计 `reader-v3.mjs`；变异检查是有限的定向用例，不代表整个 Reader 或站点的覆盖率。各门禁的范围和测试数据见对应 README。这些 Node 测试、上述静态检查均**不等于完整 CI**。

### 真实浏览器定向回归

先按 [Reader workflow](.github/workflows/reader-refactor.yml) 安装固定版本的 Playwright、Chromium/Firefox、系统库和 Reader vendor；部分 PDF 测试还需要 `qpdf`。以下命令分别测试真实 Worker 的结构化克隆和原生 IndexedDB，默认 Chromium，变量选择 Firefox：

```sh
python3 -B tests/reader/pdf-search/test_pdf_book_worker_browser.py
PDF_WORKER_TEST_BROWSER=firefox python3 -B tests/reader/pdf-search/test_pdf_book_worker_browser.py
python3 -B tests/reader/pdf-search/test_pdf_text_store_browser.py
PDF_TEXT_STORE_TEST_BROWSER=firefox python3 -B tests/reader/pdf-search/test_pdf_text_store_browser.py
```

它们使用本地 fixture，是定向浏览器测试，不替代真实网络、完整 Reader 或线上回归。

## CI 与发布

- Reader workflow 对 `main` 推送、手动触发及每日 02:17 UTC 定时运行；若一次推送的改动**全部**位于 `data/**`，不会触发该推送回归，可手动运行。并发组会取消较早的同组运行。
- 两站 job 分别运行，另有独立 Firefox staged-PDF job；是否将每个 job 设为分支保护必需状态需在仓库设置中确认。Pages 部署 workflow 的 `deploy` 依赖 `source-checks`，还会检查构建后的 PDF 打开流程。
- CI 只在识别到特定 Ubuntu 24.04 APT 布局时替换镜像列表，不更改源配置或签名验证；未知布局告警并保留默认配置。官方镜像不保证加速，此措施也不是恶意 checkout 的沙箱。
- 涉及两站的变更先发布 Space，再发布 Pages：先确认所需提交已进入 Space 远端 `main`，GitHub Reader workflow 会克隆其默认分支并检查基线祖先。分别检查 Space 构建与运行版本、GitHub 双站 CI 和 Pages 部署；部署后再到两站检查搜索、文档首屏、翻页及全文搜索，并留意控制台和网络错误。冒烟不能替代完整 CI。
