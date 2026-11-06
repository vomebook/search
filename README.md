# Search — GitHub Pages

资料搜索和阅读的静态站点。本仓库与 [Hugging Face Search Space](https://huggingface.co/spaces/VoiceOfML/Search/tree/main) 是两个独立仓库：Pages 提供静态搜索索引和阅读器，Space 提供后端 API 与其自身部署版本。两边共享部分 Reader 代码和测试，但入口、资源路径和部分实现不同；修改共享功能时应分别检查并验证两边，不能直接覆盖整个目录。

## 目录

- `static/`：Pages 资源和入口；`search/` 是搜索组件，`reader/` 按核心、格式、PDF、搜索、界面划分，`sw.js` 是 Service Worker。
- `data/`：站点使用的搜索和目录数据。
- `tests/`：Node、Python 和浏览器测试；已整理的领域测试放在 `tests/search/` 和 `tests/reader/`。PDF 全文搜索测试见 `tests/reader/pdf-search/README.txt`。
- `scripts/build/`、`scripts/data/`：构建与数据获取；`scripts/reader/`、`scripts/search/` 是按领域归组的检查，其他检查暂留在 `scripts/`。
- `.github/workflows/`：Pages 构建发布及双站 Reader 回归；`typings/` 和 `jsconfig*.json` 定义前端类型检查边界。

## 检查

CI 使用 Node 26.11.1 和 Python 3.11.17。在支持可执行文件和符号链接的文件系统中安装后：

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 -m pip install -r requirements-static-check.txt
npm run check:static
python3 -B scripts/check_python_static.py
node scripts/reader/check_pdf_book_client_coverage.mjs
```

浏览器测试还需要 Playwright、浏览器和 Reader vendor；完整安装与执行命令见 `.github/workflows/reader-refactor.yml`。Android 共享存储常以 `noexec` 挂载，应在支持执行和符号链接的目录中安装依赖及运行检查。修改不自动发布：涉及双仓库的变更应先发布 Space，再发布本仓库并检查双站 CI（GitHub 工作流会拉取 Space 的 main）。
