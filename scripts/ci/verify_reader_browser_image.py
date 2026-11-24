"""Confirm the pinned Python package can launch both image-provided browsers."""
from importlib.metadata import version
from os import geteuid
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    if version('playwright') != '1.65.2':
        raise RuntimeError('unexpected Playwright Python version')
    home = Path.home()
    if home.stat().st_uid != geteuid():
        raise RuntimeError(f'browser HOME is not owned by the job user: {home}')
    with sync_playwright() as playwright:
        for browser in (playwright.chromium, playwright.firefox):
            executable = Path(browser.executable_path).resolve(strict=True)
            if Path('/ms-playwright') not in executable.parents:
                raise RuntimeError(f'{browser.name}: unexpected executable {executable}')
            with browser.launch() as process:
                page = process.new_page()
                page.goto('data:text/html,<title>Reader CI image</title>')
                if page.title() != 'Reader CI image':
                    raise RuntimeError(f'{browser.name}: smoke check failed')
                print(f'{browser.name}: {process.version}', flush=True)


main()
