"""Read the actual component graph for non-executing source smoke assertions."""
import re


def read_reader_source(root):
    static = root / "static"
    barrel = static / "reader/reader-components.mjs"
    exports = barrel.read_text(encoding="utf-8")
    files = [static / "reader.js", *(barrel.parent / name for name in
             re.findall(r'from "\./([\w/-]+\.mjs)"', exports))]
    sources = []
    for filename in files:
        source = filename.read_text(encoding="utf-8")
        source = re.sub(r"\breaderContext\.", "", source)
        sources.append(re.sub(r"^  ", "", source, flags=re.M))
    return "\n".join(sources)
