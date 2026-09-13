from tests.reader_test_selection import load_category_tests


def load_tests(loader, _tests, _pattern):
    return load_category_tests(loader, "navigation")
