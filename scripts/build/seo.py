"""Small, deterministic metadata catalog; no source-body downloads or search changes.

The same file is copied to Pages' scripts/build/seo.py. Pages owns the indexable
catalog; new HF catalog pages are noindex mirrors because HF appends a Hub canonical.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
from html import escape
import json
from pathlib import Path
import re
from urllib.parse import quote, urlencode


PAGES = "https://vomebook.github.io/search/"
HF = "https://voiceofml-search.hf.space/"
DESCRIPTION = "检索 VoiceOfML 公开资料的文件名、路径和格式，浏览文库目录，在线阅读或下载原始文件。"
PILOT = {
    "samples": [
        ["VoiceOfML/VOMEBOOK", "马列之声ebook小组第二批成果集成赞助部分/jiang/中国社会主义时代的教育革命 研究资料集成pdf（近800种）/工农兵大学生/工农兵学员的优秀代表----曹谊林.txt"],
        ["VoiceOfML/SovMaterials", "重要中文文献/斯大林著作各种/斯大林语录.txt"],
        ["VoiceOfML/GPCREducation", "化学/简明化学手册.pdf"],
        ["VoiceOfML/Teachers", "其他/李达/李达传记.pdf"],
        ["VoiceOfML/MLMRL-Library", "历史/中国近代史1.pdf"],
        ["VoiceOfML/Japanese-Materials", "极端派的时代.pdf"],
        ["VoiceOfML/A-Historical-Learning-Data", "无产阶级政党/列宁《怎么办？》.pdf"],
        ["VoiceOfML/MLMRL-Hub", "001643/学点逻辑.pdf"],
        ["VoiceOfML/Omnibus", "幻の大連.pdf"],
    ],
    "folder": ["VoiceOfML/SovMaterials", "俄苏史/苏联史"],
}
CATALOG_CSS = """body{font:17px/1.7 system-ui,sans-serif;margin:0;background:#fafafa;color:#202124}
main{max-width:900px;margin:auto;padding:24px 18px}a{color:#1558a6}a:focus-visible{outline:3px solid #1558a6;outline-offset:3px}
h1{font-size:1.65rem;line-height:1.4;overflow-wrap:anywhere}h2{font-size:1.2rem;margin-top:1.8em}
nav,footer{margin:18px 0}li{margin:9px 0}p{margin:12px 0}dl{display:grid;grid-template-columns:5em 1fr;gap:8px}
dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}code{white-space:pre-wrap;overflow-wrap:anywhere}
.note{padding:12px;background:#edf3fa;border-radius:8px}.muted{color:#555}img{max-width:100%}
@media(prefers-color-scheme:dark){body{background:#181a1d;color:#e2e2e6}a{color:#9ec5ff}.muted{color:#bfc5cf}.note{background:#242f40}}
"""


def json_script(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def metadata(title: str, description: str, url: str, *, canonical: bool, noindex: bool = False) -> str:
    image = (PAGES if url.startswith(PAGES) else HF) + "icons/icon-512.png"
    values = [f"<title>{escape(title)}</title>",
              f'<meta name="description" content="{escape(description, quote=True)}">']
    if canonical:
        values.append(f'<link rel="canonical" href="{escape(url, quote=True)}">')
    if noindex:
        values.append('<meta name="robots" content="noindex,follow">')
    for key, value in [("og:type", "website"), ("og:site_name", "VoiceOfML"),
                       ("og:title", title), ("og:description", description), ("og:url", url),
                       ("og:image", image), ("og:image:alt", "VoiceOfML 文库"), ("og:locale", "zh_CN")]:
        values.append(f'<meta property="{key}" content="{escape(value, quote=True)}">')
    for key, value in [("twitter:card", "summary"), ("twitter:title", title),
                       ("twitter:description", description), ("twitter:image", image),
                       ("twitter:image:alt", "VoiceOfML 文库")]:
        values.append(f'<meta name="{key}" content="{escape(value, quote=True)}">')
    return "\n".join(values)


def enrich_search_shell(html: str, repo: str | None = None, count: int | None = None) -> str:
    """HF-only: retain the platform's single HTTP canonical, never add a rival."""
    title = f"{repo} 资料检索 — VoiceOfML Search" if repo else "VoiceOfML Search — 资料检索与文库目录"
    description = (f"检索 {repo} 的 {count:,} 条资料记录，按文件名、路径和格式查找，在线阅读或下载。"
                   if repo and count is not None else DESCRIPTION)
    url = HF + (quote(repo.split("/")[-1], safe="") + "/" if repo else "")
    start, end = "<!-- SEO:HEAD -->", "<!-- /SEO:HEAD -->"
    if start in html and end in html:
        head = metadata(title, description, url, canonical=False)
        head += '\n<script type="application/ld+json">' + json_script({
            "@context": "https://schema.org", "@type": "WebSite", "name": "VoiceOfML",
            "url": HF, "description": DESCRIPTION, "inLanguage": "zh-CN",
        }) + '</script>'
        html = html.split(start, 1)[0] + start + "\n" + head + "\n" + end + html.split(end, 1)[1]
    return html


def decode_corpus(payload: object) -> list[dict]:
    if not isinstance(payload, dict) or payload.get("v") != 2:
        raise ValueError("SEO requires the current compact-v2 corpus")
    repos, folders, rows = payload.get("rp"), payload.get("fd"), payload.get("rc")
    if not all(isinstance(value, list) for value in (repos, folders, rows)):
        raise ValueError("Invalid compact tables")
    result = []
    for row in rows:
        if (not isinstance(row, list) or len(row) < 6 or type(row[0]) is not int
                or not 0 <= row[0] < len(repos) or type(row[3]) is not int or not 0 <= row[3] < len(folders)):
            raise ValueError("Invalid compact record reference")
        record = dict(Repo=repos[row[0]], File=row[1], Extension=row[2], Folder=folders[row[3]], Size=row[4])
        if (not isinstance(record["Repo"], str) or not re.fullmatch(r"VoiceOfML/[A-Za-z0-9._-]+", record["Repo"])
                or not all(isinstance(record[key], str) for key in ("File", "Extension"))
                or not isinstance(record["Folder"], list)
                or not all(isinstance(part, str) for part in record["Folder"])):
            raise ValueError("Invalid compact record fields")
        result.append(record)
    return result


def relative_path(record: dict) -> str:
    name = record["File"] + ("." + record["Extension"] if record["Extension"] else "")
    path = "/".join([*record["Folder"], name])
    if any(part in (".", "..") for part in path.split("/")) or "\x00" in path or "\\" in path:
        raise ValueError("Unsafe source path")
    return path


def source_url(record: dict, action: str = "resolve") -> str:
    return f'https://huggingface.co/datasets/{record["Repo"]}/{action}/main/{quote(relative_path(record), safe="/")}'


def source_id(record: dict) -> str:
    value = 1469598103934665603
    for byte in source_url(record).encode("utf-8"):
        value = ((value ^ byte) * 1099511628211) & ((1 << 64) - 1)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, digit = divmod(value, 36)
        result = digits[digit] + result
    return result.rjust(13, "0")


def build_catalog(records: list[dict], *, project: str, corpus_identity: str, pilot: dict | None = None) -> dict:
    if project not in ("pages", "hf"):
        raise ValueError("Unknown project")
    pilot = PILOT if pilot is None else pilot
    primary = project == "pages"
    origin = PAGES if primary else HF
    catalog = "catalog/"
    repo_prefix = "" if primary else catalog
    book_prefix = "book/" if primary else catalog + "book/"
    grouped = defaultdict(list)
    by_key = {}
    for record in records:
        grouped[record["Repo"]].append(record)
        key = (record["Repo"], relative_path(record))
        if key in by_key and any(by_key[key].get(field) != record.get(field) for field in ("File", "Extension", "Folder", "Size")):
            raise ValueError("Conflicting source identity")
        by_key[key] = record
    selected = {}
    for repo, path in pilot["samples"]:
        record = by_key.get((repo, path))
        if record is None:
            raise ValueError(f"Missing configured SEO pilot source: {repo}/{path}")
        selected[(repo, path)] = record
    folder_repo, folder_path = pilot["folder"]
    folder_records = [record for record in grouped[folder_repo] if "/".join(record["Folder"]) == folder_path]
    descendants = [record for record in grouped[folder_repo]
                   if "/".join(record["Folder"]).startswith(folder_path + "/")]
    if not folder_records or descendants or len(folder_records) > 64:
        raise ValueError("SEO pilot must be a complete leaf folder of 1–64 files; never truncate it")
    for record in folder_records:
        selected[(record["Repo"], relative_path(record))] = record
    selected_records = sorted(selected.values(), key=lambda record: (record["Repo"], relative_path(record)))
    ids = [source_id(record) for record in selected_records]
    if len(set(ids)) != len(ids):
        raise ValueError("SEO source-ID collision")
    folder_id = hashlib.sha256((folder_repo + "\0" + folder_path).encode()).hexdigest()[:16]
    folder_route = catalog + "folders/" + folder_id + "/"
    pages = {}
    page_urls = []

    def anchor(route, label):
        return f'<a href="{escape(origin + route, quote=True)}">{escape(label)}</a>'

    def search_link(repo, folder=""):
        short = quote(repo.split("/")[-1], safe="")
        return origin + ("#/" + short if primary else short + "/") + ("?" + urlencode({"path": folder}) if folder else "")

    def entries(values):
        return "<ul>" + "".join("<li>" + anchor(book_prefix + source_id(record) + "/", record["File"])
                                 + " — " + escape(record["Extension"].upper()) + "</li>" for record in values) + "</ul>"

    def page(route, title, description, body, entity):
        url = origin + route
        graph = {"@context": "https://schema.org", "@graph": [
            {"@type": "WebSite", "@id": origin + "#website", "name": "VoiceOfML", "url": origin},
            {"@type": "WebPage", "@id": url, "url": url, "name": title, "description": description,
             "inLanguage": "zh-CN", "isPartOf": {"@id": origin + "#website"}, "mainEntity": entity},
        ]}
        mirror = ""
        # Mirror links use explicit route correspondence, not title-derived guesses.
        if not primary:
            main_route = route.removeprefix(catalog) if route.startswith(catalog + "book/") or route in {catalog + repo.split("/")[-1] + "/" for repo in grouped} else route
            mirror = '<p class="note">这是 HF 导航镜像；<a href="' + escape(PAGES + main_route, quote=True) + '">打开对应的主目录页</a>。</p>'
        html = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                + metadata(title, description, url, canonical=primary, noindex=not primary)
                + '<script type="application/ld+json">' + json_script(graph) + '</script>'
                + '<style>' + CATALOG_CSS + '</style></head><body><main>'
                + '<nav aria-label="主导航">' + anchor("", "资料检索") + " · " + anchor(catalog, "文库目录") + '</nav>'
                + '<h1>' + escape(title) + '</h1>' + mirror + body
                + '<footer class="muted">本页仅整理公开文件元数据，不代表已核实作者、出版或 OCR 准确性。'
                '如资料信息或来源有误，请通过原始仓库反馈。目录试点不限制站内完整搜索。</footer>'
                + '</main></body></html>')
        pages[route + "index.html"] = html
        page_urls.append(url)

    repo_links = '<ul>' + ''.join('<li>' + anchor(repo_prefix + repo.split('/')[-1] + '/', repo.split('/')[-1])
                 + f' — {len(grouped[repo]):,} 条记录</li>' for repo in sorted(grouped)) + '</ul>'
    page(catalog, "VoiceOfML 文库目录", DESCRIPTION,
         '<p>按来源仓库浏览公开资料。下列数量是文件元数据记录数，不是去重后的书籍数。</p>' + repo_links
         + f'<h2>目录试点</h2><p>本批提供 {len(selected_records)} 个资源详情和一个完整叶目录；其余资料仍可通过站内搜索查找。</p>'
         + '<p>' + anchor(folder_route, folder_repo.split('/')[-1] + '/' + folder_path) + '</p>' + entries(selected_records),
         {"@type": "ItemList", "numberOfItems": len(grouped)})
    for repo in sorted(grouped):
        formats = Counter(record["Extension"] for record in grouped[repo])
        top = Counter(record["Folder"][0] if record["Folder"] else "（根目录）" for record in grouped[repo])
        sample = [record for record in selected_records if record["Repo"] == repo]
        body = f'<p>{escape(repo)} 包含 {len(grouped[repo]):,} 条文件记录，可按文件名、路径和格式检索。</p>'
        body += '<p><a href="' + escape(search_link(repo), quote=True) + '">进入此仓库的完整搜索</a> · <a href="https://huggingface.co/datasets/' + quote(repo, safe='/') + '/tree/main">原始数据仓库</a></p>'
        body += '<h2>文件格式</h2><p>' + '；'.join(escape(ext.upper() or '无扩展名') + f' {count:,}' for ext, count in sorted(formats.items())) + '</p>'
        body += '<h2>路径概览</h2><p>以下为条目最多的至多 12 个顶层路径示例；完整目录见仓库搜索。</p><ul>'
        body += ''.join('<li>' + escape(name) + f' — {count:,} 条</li>' for name, count in sorted(top.items(), key=lambda item: (-item[1], item[0]))[:12]) + '</ul>'
        body += '<h2>本批资源详情</h2>' + entries(sample)
        if repo == folder_repo:
            body += '<p>' + anchor(folder_route, '浏览完整试点目录：' + folder_path) + '</p>'
        page(repo_prefix + repo.split('/')[-1] + '/', repo.split('/')[-1] + ' 资料目录 — VoiceOfML',
             f'{repo} 的文件目录、格式分布与来源路径；共 {len(grouped[repo]):,} 条元数据记录，支持在线检索、阅读和原始文件下载。',
             body, {"@type": "CollectionPage", "name": repo})
    page(folder_route, folder_path + ' — ' + folder_repo.split('/')[-1],
         f'{folder_repo}/{folder_path} 的完整叶目录，包含 {len(folder_records)} 个文件。',
         '<p>' + anchor(repo_prefix + folder_repo.split('/')[-1] + '/', folder_repo) + '</p><p>原始目录：<code>'
         + escape(folder_path) + f'</code>；本页完整列出该叶目录的 {len(folder_records)} 个文件。</p>'
         + entries(sorted(folder_records, key=relative_path)), {"@type": "ItemList", "numberOfItems": len(folder_records)})
    for record in selected_records:
        repo, path, identifier = record['Repo'], relative_path(record), source_id(record)
        size = str(record.get('Size', '未知')) + (' bytes' if type(record.get('Size')) in (int, float) else '')
        body = '<p>' + anchor(repo_prefix + repo.split('/')[-1] + '/', repo) + '</p><dl>'
        for label, value in [('文件名', record['File']), ('仓库', repo), ('原始路径', path),
                             ('格式', record['Extension'].upper()), ('文件大小', size)]:
            body += '<dt>' + label + '</dt><dd>' + escape(value) + '</dd>'
        body += '</dl><p><a href="' + escape(origin + 'static/reader.html?id=' + identifier, quote=True) + '">在线阅读</a> · '
        body += '<a href="' + escape(source_url(record), quote=True) + '">下载原始文件</a> · <a href="' + escape(source_url(record, 'blob'), quote=True) + '">查看原始文件页面</a></p>'
        body += '<p>资料说明：此条目按原始文件名和仓库路径登记；请以原文件及来源页面核对内容、版本与权利信息。本页不推测作者、ISBN 或出版日期。</p>'
        page(book_prefix + identifier + '/', record['File'] + ' — VoiceOfML 资源详情',
             f'{record["File"]}，{record["Extension"].upper()} 文件，来源 {repo}；查看路径、在线阅读与原始下载入口。', body,
             {"@type": "DigitalDocument", "name": record['File'], "encodingFormat": record['Extension'],
              "isBasedOn": source_url(record, 'blob')})
    sitemap_urls = [PAGES, *page_urls] if primary else []
    if primary:
        pages['sitemap.xml'] = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + ''.join('<url><loc>' + escape(url) + '</loc></url>' for url in sitemap_urls) + '</urlset>'
    manifest = {'version': 1, 'profile': 'metadata-catalog-pilot-v1', 'project': project,
                'corpus_identity': corpus_identity, 'record_count': len(records),
                'repo_counts': {repo: len(grouped[repo]) for repo in sorted(grouped)},
                'detail_count': len(selected_records), 'folder_count': 1, 'urls': page_urls,
                'sitemap_urls': sitemap_urls, 'details': [dict(id=source_id(record), repo=record['Repo'],
                    path=relative_path(record), source=source_url(record)) for record in selected_records],
                'files': {path: hashlib.sha256(body.encode()).hexdigest() for path, body in sorted(pages.items())}}
    return {'files': pages, 'manifest': manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', choices=('pages', 'hf'), required=True)
    parser.add_argument('--corpus', default='data/search_data.json.gz')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    source = Path(args.corpus).read_bytes()
    result = build_catalog(decode_corpus(json.loads(gzip.decompress(source))), project=args.project,
                           corpus_identity=hashlib.sha256(source).hexdigest())
    output = Path(args.output)
    if (output / 'seo-publication.json').exists():
        raise ValueError('Use a fresh build output; refusing stale catalog artifacts')
    if any((output / relative).exists() for relative in result['files']):
        raise ValueError('Refusing to overwrite existing catalog or sitemap files')
    for relative, body in result['files'].items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding='utf-8')
    (output / 'seo-publication.json').write_text(json.dumps(result['manifest'], ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: result['manifest'][key] for key in ('project', 'record_count', 'detail_count', 'folder_count')}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
