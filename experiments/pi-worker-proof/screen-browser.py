"""Fresh browser: actual Worker form -> actual OpenAI screen; never consent.
Only safe status/origin/path is retained; no OAuth URL, account data or trace.
"""
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

origin, directory = sys.argv[1:]
out = Path(directory)
result = {'scope': 'SCREEN_ONLY_NO_CONSENT', 'screen': 'NOT_REACHED', 'credentials_written': False, 'oauth_query_published': False, 'consent_submitted': False, 'token_exchange': 'DISABLED'}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context()  # no user's account/cookies/storage state
        def boundary(route):
            req = route.request
            url = urlsplit(req.url)
            if url.path == '/auth/callback' or '/oauth/token' in url.path or (req.method != 'GET' and not req.url.startswith(origin + '/auth/start')):
                route.abort()
            else:
                route.continue_()
        context.route('**/*', boundary)
        page = context.new_page()
        page.goto(origin, wait_until='domcontentloaded', timeout=20000)
        assert '接続は完了しません' in page.locator('body').inner_text(), 'landing not visible'
        page.get_by_role('button', name='OpenAIの認証画面を開く').click(no_wait_after=True)
        page.wait_for_url('https://auth.openai.com/**', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function("() => /sign in|log in|choose an account|select an account|ログイン|アカウントを選択/i.test(document.body.innerText)", timeout=15000)
        current = urlsplit(page.url)
        result.update({'screen': 'AUTH_SCREEN_VISIBLE', 'origin': current.scheme + '://' + current.netloc, 'path': current.path, 'fresh_browser': True})
        # Empty isolated profile: no personal account or supplied identity. No URL bar is captured.
        page.screenshot(path=str(out / 'auth-screen.png'))
        context.close()
        browser.close()
except Exception as error:
    # Playwright exceptions can embed the full OAuth URL: do not print them.
    result.update({'screen': 'AUTH_SCREEN_NOT_PROVEN', 'error_type': type(error).__name__})
(out / 'screen-browser.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
# This is an observed external reachability result, not mock success or live-plan use.
# root must complete a real protected deployed-URL readback even when CI reaches the screen.
