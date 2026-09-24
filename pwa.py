"""Public app shell only; no session, API, media or private-page caching."""
import hashlib
import json
import re
from pathlib import Path
from flask import Response, send_file
from performance import page_html

BASE = Path(__file__).parent

def worker_response():
    html = page_html('index.html')
    assets = sorted(set(re.findall(r'(?:src|href)="(/static/[^"<>]+)"', html)))
    manifest = json.loads((BASE/'static/manifest.webmanifest').read_text())
    assets += [icon['src'] for icon in manifest['icons']]
    assets = sorted(set(assets))
    template = (BASE/'static/pwa-worker.js').read_text()
    digest = hashlib.sha256((html+template).encode())
    for url in assets:
        digest.update((BASE/url.split('?')[0].lstrip('/')).read_bytes())
    body = template.replace('__BUILD__', digest.hexdigest()[:16]).replace('__ASSETS__', json.dumps(assets))
    return Response(body, mimetype='application/javascript', headers={
        'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/',
    })

def manifest_response():
    return send_file(BASE/'static/manifest.webmanifest', mimetype='application/manifest+json', max_age=0)
