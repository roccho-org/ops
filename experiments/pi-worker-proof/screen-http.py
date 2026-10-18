"""Read the actual packaged Worker over loopback; never follow/log OAuth URLs."""
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

origin, destination = sys.argv[1:]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
opener = urllib.request.build_opener(NoRedirect)
def request(path, data=None, headers=None):
    req = urllib.request.Request(origin + path, data=data, headers=headers or {})
    try:
        return opener.open(req, timeout=5)
    except urllib.error.HTTPError as response:
        return response

for attempt in range(60):
    try:
        landing = request('/')
        break
    except urllib.error.URLError:
        time.sleep(0.5)
else:
    raise SystemExit('Worker did not start')
assert landing.status == 200 and '接続は完了しません' in landing.read().decode(), 'landing failed'
assert request('/auth/start').status == 405, 'method boundary failed'
assert request('/auth/start', b'', {'Origin': 'https://other.invalid'}).status == 403, 'origin boundary failed'
assert request('/auth/callback').status == 410, 'callback boundary failed'
assert request('/api/sessions', b'').status == 404, 'chat route exposed'
urls = []
for _ in range(2):
    response = request('/auth/start', b'', {'Origin': origin})
    assert response.status == 303, 'Pi authorization URL not returned'
    url = urllib.parse.urlsplit(response.headers['Location'])
    query = urllib.parse.parse_qs(url.query)
    assert url.scheme == 'https' and url.netloc == 'auth.openai.com' and url.path == '/api/accounts/authorize', 'wrong authorization destination'
    assert query.get('code_challenge_method') == ['S256'], 'PKCE missing'
    assert all(len(query.get(key, [''])[0]) >= 43 for key in ('state', 'nonce', 'code_challenge')), 'fresh fields missing'
    urls.append(query)
assert all(urls[0][key] != urls[1][key] for key in ('state', 'nonce', 'code_challenge')), 'retry reused state'
assert urls[0]['ext_agent_host_id'] == urls[1]['ext_agent_host_id'], 'host identity changed'
Path(destination).write_text(json.dumps({'scope': 'BUILT_WORKER_HTTP_SCREEN_ONLY', 'landing': 200, 'redirects': 2, 'oauth_origin': 'https://auth.openai.com', 'pkce_state_nonce': 'PASS', 'retry_fresh': True, 'stable_host': True, 'callback': 410, 'chat_route': 404, 'wrong_method': 405, 'wrong_origin': 403, 'oauth_query_published': False, 'browser_auth_screen': 'SEPARATE_PROOF', 'real_tokens': 'NOT_REQUESTED'}, indent=2) + '\n')
print('Built Worker HTTP entry, real Pi URL generation, boundaries and retry: PASS; no OAuth query retained')
