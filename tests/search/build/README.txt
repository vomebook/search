Search bundle integration contract
==================================

Run from the repository root with Node 26:

  node tests/search/build/test_search_record_path_build.mjs

Despite its historical filename, this checks six search modules against
compose_app dependencies, HTML script order, bundled stripping, resource lists
and service-worker precache exclusions. It is a source integration contract,
not a built-artifact, network or browser test; the production build release
check remains independent.
