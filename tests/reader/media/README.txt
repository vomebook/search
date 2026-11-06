Reader media format contracts
=============================

Run from the repository root with Node 26:

  node scripts/reader/check_reader_media_coverage.mjs

These 15 named contracts use synthetic media elements, fake timers and fixture
responses; they cover formatting, dynamic argument forwarding, metadata, retry,
restoration, progress, failure and disposal. The V8 coverage gate includes only
static/reader/formats/reader-media-format.mjs. It does not claim coverage of the
Reader host, real browser media codecs, Ruffle, network, worker or the site.
Existing browser tests remain in their Python package and are not replaced.
