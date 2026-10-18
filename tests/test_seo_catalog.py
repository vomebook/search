"""Offline fixtures for the small catalog, URL identity and indexing policy."""
import copy
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import unittest
from xml.etree import ElementTree


ROOT = Path(__file__).parents[1]
MODULE = ROOT / ("backend/seo.py" if (ROOT / "backend").exists() else "scripts/build/seo.py")
spec = importlib.util.spec_from_file_location("seo_catalog_under_test", MODULE)
seo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seo)


class Facts(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.canonicals = []
        self.links = []
        self.robots = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and attrs.get("rel") == "canonical": self.canonicals.append(attrs["href"])
        if tag == "a" and attrs.get("href"): self.links.append(attrs["href"])
        if tag == "meta" and attrs.get("name") == "robots": self.robots.append(attrs["content"])


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"v": 2, "rp": ["VoiceOfML/Alpha", "VoiceOfML/Beta"], "fd": [["资料"], []],
                        "rc": [[0, "书一", "pdf", 0, 10, 0], [0, '坏&标题"<', "txt", 0, 20, 1],
                               [1, "readme", "md", 1, 30, 1]]}
        self.records = seo.decode_corpus(self.payload)
        self.pilot = {"samples": [["VoiceOfML/Alpha", "资料/书一.pdf"], ["VoiceOfML/Beta", "readme.md"]],
                      "folder": ["VoiceOfML/Alpha", "资料"]}

    def build(self, project="pages", records=None, pilot=None):
        return seo.build_catalog(self.records if records is None else records, project=project,
                                 corpus_identity="fixture-generation", pilot=self.pilot if pilot is None else pilot)

    def test_compact_schema_and_record_references_are_validated(self):
        self.assertEqual(len(self.records), 3)
        self.assertEqual(self.records[0]["Folder"], ["资料"])
        for broken in ({}, {**self.payload, "v": 3}, {**self.payload, "rc": [[99, "bad", "pdf", 0, 1, 0]]}):
            with self.subTest(broken=broken), self.assertRaises(ValueError): seo.decode_corpus(broken)

    def test_all_counts_and_complete_leaf_are_preserved(self):
        result = self.build()
        self.assertEqual(result["manifest"]["record_count"], 3)
        self.assertEqual(result["manifest"]["repo_counts"], {"VoiceOfML/Alpha": 2, "VoiceOfML/Beta": 1})
        self.assertEqual(result["manifest"]["detail_count"], 3)
        folder = next(body for path, body in result["files"].items() if path.startswith("catalog/folders/"))
        self.assertIn("完整列出该叶目录的 2 个文件", folder)
        self.assertIn("书一", folder)
        self.assertIn("坏&amp;标题", folder)

    def test_pages_has_real_repo_paths_and_exact_self_canonicals(self):
        result = self.build()
        self.assertIn("Alpha/index.html", result["files"])
        for path, body in result["files"].items():
            if not path.endswith(".html"): continue
            facts = Facts(body)
            self.assertEqual(facts.canonicals, [seo.PAGES + path.removesuffix("index.html")])
            self.assertEqual(facts.robots, [])
            self.assertIn("<h1>", body)

    def test_hf_new_mirrors_do_not_add_a_second_canonical(self):
        result = self.build("hf")
        self.assertNotIn("sitemap.xml", result["files"])
        self.assertEqual(result["manifest"]["sitemap_urls"], [])
        for body in result["files"].values():
            facts = Facts(body)
            self.assertEqual(facts.canonicals, [])
            self.assertEqual(facts.robots, ["noindex,follow"])
            self.assertTrue(any(link.startswith(seo.PAGES) for link in facts.links))
        book = next(body for path, body in result["files"].items() if path.startswith("catalog/book/"))
        self.assertIn('href="' + seo.PAGES + 'book/', book)

    def test_sitemap_contains_only_exact_indexable_page_set(self):
        result = self.build()
        root = ElementTree.fromstring(result["files"]["sitemap.xml"])
        urls = [element.text for element in root.findall("{*}url/{*}loc")]
        self.assertEqual(urls, result["manifest"]["sitemap_urls"])
        self.assertEqual(len(urls), len(set(urls)))
        self.assertNotIn("lastmod", result["files"]["sitemap.xml"])
        for url in urls:
            self.assertTrue(url.startswith(seo.PAGES))
            self.assertNotIn("?", url)
            self.assertNotIn("#", url)
            self.assertNotIn("reader.html", url)

    def test_directory_links_reach_every_pilot_detail_without_javascript(self):
        result = self.build()
        facts = Facts(result["files"]["catalog/index.html"])
        for detail in result["manifest"]["details"]:
            self.assertIn(seo.PAGES + "book/" + detail["id"] + "/", facts.links)
        self.assertNotIn("<script src=", result["files"]["catalog/index.html"])
        self.assertIn("#/Alpha", result["files"]["Alpha/index.html"])

    def test_text_attributes_and_json_ld_are_escaped(self):
        result = self.build()
        body = next(body for path, body in result["files"].items() if path.startswith("book/") and "坏&amp;" in body)
        self.assertIn("坏&amp;标题&quot;&lt;", body)
        self.assertNotIn('坏&标题"<', body)
        self.assertNotIn("</script><img", seo.json_script({"name": "</script><img src=x>"}))
        self.assertEqual(json.loads(seo.json_script({"name": "</script>"}))["name"], "</script>")
        self.assertNotIn('"author"', body)
        self.assertNotIn('"isbn"', body)

    def test_reader_ids_match_existing_published_contract_vectors(self):
        record = dict(Repo="VoiceOfML/Test", Folder=[], File="book29", Extension="txt")
        self.assertEqual(seo.source_id(record), "0ym7e7wbcxau0")
        self.assertEqual(seo.source_id({**record, "File": "a b"}), "1ckyy8f8m7pim")
        vectors = json.loads((ROOT / "tests/reader-contract-vectors.json").read_text())
        parts = vectors["reportedBook"]["path"].split("/")
        record = dict(Repo="VoiceOfML/VOMEBOOK", Folder=parts[:-1], File=parts[-1][:-4], Extension="pdf")
        self.assertEqual(seo.source_id(record), vectors["reportedBook"]["id"])

    def test_missing_or_growing_pilot_never_silently_truncates(self):
        pilot = copy.deepcopy(self.pilot)
        pilot["samples"][0][1] = "missing.pdf"
        with self.assertRaises(ValueError): self.build(pilot=pilot)
        child = {**self.records[0], "Folder": ["资料", "新增子目录"]}
        with self.assertRaises(ValueError): self.build(records=[*self.records, child])
        many = [{**self.records[0], "File": f"book{i}"} for i in range(65)]
        with self.assertRaises(ValueError): self.build(records=[*self.records, *many])

    def test_paths_and_conflicting_identity_fail_closed(self):
        with self.assertRaises(ValueError): seo.relative_path({**self.records[0], "Folder": [".."]})
        conflict = {**self.records[0], "Size": 999}
        with self.assertRaises(ValueError): self.build(records=[*self.records, conflict])

    def test_output_is_deterministic_and_does_not_mutate_search_records(self):
        before = copy.deepcopy(self.records)
        self.assertEqual(self.build(), self.build())
        self.assertEqual(self.records, before)

    def test_hf_shell_metadata_is_scoped_and_not_a_canonical_override(self):
        template = '<head><!-- SEO:HEAD --><title>old</title><!-- /SEO:HEAD --></head><body>unchanged</body>'
        html = seo.enrich_search_shell(template, "VoiceOfML/Alpha", 23)
        self.assertIn("<title>VoiceOfML Search</title>", html)
        self.assertNotIn("Alpha 资料检索", html)
        self.assertIn("23 条资料记录", html)
        self.assertEqual(Facts(html).canonicals, [])
        self.assertIn("<body>unchanged</body>", html)
        self.assertEqual(html.count("<title>"), 1)

    def test_reader_shell_is_explicitly_non_indexable(self):
        shell = (ROOT / "static/reader.html").read_text(encoding="utf-8")
        self.assertIn('<meta name="robots" content="noindex, nofollow, noarchive"', shell)


if __name__ == "__main__":
    unittest.main()
