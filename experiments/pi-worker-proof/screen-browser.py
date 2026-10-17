"""Actual Worker form -> OpenAI screen in a fresh browser; never consent.
Retain only fixed status/category fields, never OAuth queries or exception text.
"""
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

origin, directory = sys.argv[1:]
out = Path(directory)
result = {
    'scope': 'SCREEN_ONLY_NO_CONSENT', 'screen': 'AUTH_SCREEN_NOT_PROVEN',
    'credentials_written': False, 'oauth_query_published': False,
    'consent_submitted': False, 'token_exchange': 'DISABLED',
    'worker_start_status': None, 'auth_document_status': None,
    'blocked': {'callback': 0, 'token': 0, 'external_non_get': 0},
    'auth_document_failed': False,
}
with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context()  # No personal account/cookies/storage state.
    page = context.new_page()
    def boundary(route):
        req, url = route.request, urlsplit(route.request.url)
        category = ('callback' if url.path == '/auth/callback' else
                    'token' if '/oauth/token' in url.path else
                    'external_non_get' if req.method != 'GET' and req.url != origin + '/auth/start' else None)
        if category:
            result['blocked'][category] += 1
            route.abort()
        else:
            route.continue_()
    def response_status(response):
        if response.url == origin + '/auth/start':
            result['worker_start_status'] = response.status
        url = urlsplit(response.url)
        if url.netloc == 'auth.openai.com' and response.request.resource_type == 'document' and response.request.frame == page.main_frame:
            result['auth_document_status'] = response.status
    def request_failed(request):
        if urlsplit(request.url).netloc == 'auth.openai.com' and request.resource_type == 'document':
            result['auth_document_failed'] = True
    context.route('**/*', boundary)
    page.on('response', response_status)
    page.on('requestfailed', request_failed)
    try:
        page.goto(origin, wait_until='domcontentloaded', timeout=20000)
        assert '接続は完了しません' in page.locator('body').inner_text(), 'landing not visible'
        page.get_by_role('button', name='OpenAIの認証画面を開く').click(no_wait_after=True)
        page.wait_for_url('https://auth.openai.com/**', wait_until='domcontentloaded', timeout=30000)
        page.wait_for_function("() => /sign in|log in|choose an account|select an account|ログイン|アカウントを選択/i.test(document.body.innerText) && !!document.querySelector('input[type=email], input[name=email], button')", timeout=15000)
        result.update({'screen': 'AUTH_SCREEN_VISIBLE', 'fresh_browser': True})
        # Screen capture is only from a new, account-free CI browser and never includes a URL bar.
        if not any(part in page.locator('body').inner_text() for part in ('code_challenge=', 'state=', 'nonce=')):
            page.screenshot(path=str(out / 'auth-screen.png'))
    except Exception as error:
        # Playwright messages may include the full OAuth URL; publish the class only.
        result['error_type'] = type(error).__name__
    finally:
        current = urlsplit(page.url)
        if current.netloc == 'auth.openai.com':
            result['origin'] = 'https://auth.openai.com'
            known = {'/api/accounts/authorize', '/choose-an-account', '/log-in', '/login', '/'}
            result['path'] = current.path if current.path in known else 'OTHER_AUTH_PATH'
            try:
                body = page.locator('body').inner_text(timeout=2000).lower()
                result['challenge_page'] = any(text in body for text in ('just a moment', 'verify you are human', 'enable javascript and cookies', 'checking your browser'))
                result['access_denied_page'] = any(text in body for text in ('access denied', 'request blocked', 'you have been blocked', 'forbidden'))
            except Exception:
                result['page_body_readable'] = False
        context.close()
        browser.close()
(out / 'screen-browser.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
# External reachability is an explicit separate result; the Worker form must work.
if result['worker_start_status'] != 303:
    raise SystemExit('Actual browser did not receive the Worker authorization redirect')
