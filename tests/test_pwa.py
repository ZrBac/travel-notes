"""PWA public-shell boundaries; uses the isolated database setup shared by the suite."""
import io
import json
import re
import unittest
from unittest.mock import patch
from PIL import Image
from test_app import app
import pwa

class PWATests(unittest.TestCase):
    def test_worker_has_root_scope_public_only_precache_and_no_personalization(self):
        visitor=app.test_client();admin=app.test_client()
        with admin.session_transaction() as session:session['csrf']='private-token-never-cache';session['admin_id']=99999
        response=visitor.get('/sw.js');body=response.get_data(as_text=True)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['Service-Worker-Allowed'],'/')
        self.assertEqual(response.headers['Cache-Control'],'no-cache')
        self.assertNotIn('Set-Cookie',response.headers)
        self.assertEqual(admin.get('/sw.js').data,response.data)
        self.assertNotIn('private-token',body)
        self.assertNotIn('__ASSETS__',body)
        assets=json.loads(re.search(r'const ASSETS=(\[.*?\]);',body).group(1))
        self.assertTrue(assets)
        for asset in assets:
            self.assertTrue(asset.startswith('/static/'))
            self.assertEqual(visitor.get(asset).status_code,200,asset)
        old=pwa.page_html('index.html')
        with patch('pwa.page_html',return_value=old+'<!-- new release -->'):
            self.assertNotEqual(visitor.get('/sw.js').data,response.data)

    def test_manifest_install_icons_and_html_links(self):
        client=app.test_client();response=client.get('/manifest.webmanifest')
        self.assertEqual(response.mimetype,'application/manifest+json')
        manifest=json.loads(response.data)
        self.assertEqual(manifest['scope'],'/');self.assertEqual(manifest['start_url'],'/')
        self.assertEqual(manifest['display'],'standalone')
        for icon in manifest['icons']:
            with Image.open(io.BytesIO(client.get(icon['src']).data)) as image:
                self.assertEqual(str(image.width)+'x'+str(image.height),icon['sizes'])
        html=client.get('/').get_data(as_text=True)
        self.assertIn('viewport-fit=cover',html)
        self.assertIn('rel="manifest"',html)
        self.assertRegex(html,r'/static/pwa.js\?v=[a-f0-9]{16}')
        self.assertNotIn('pwa.js',client.get('/admin').get_data(as_text=True))
