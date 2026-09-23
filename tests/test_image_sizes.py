import io
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import test_app as base
from performance import IMAGE_WIDTHS, image_variant_path, prepare_image_variants


class ImageSizeTests(unittest.TestCase):
    def setUp(self):
        self.f=base.AppTests();self.f.setUp();self.f.login()
    def upload(self):
        raw=io.BytesIO()
        Image.new('RGB',(1800,1200),'green').save(raw,'JPEG');raw.seek(0)
        return self.f.client.post('/api/upload',data={'image':(raw,'camera.jpeg')},headers={'X-CSRF-Token':self.f.csrf})
    def test_all_sizes_exist_before_first_read_and_revalidate_visibility(self):
        r=self.upload();self.assertEqual(r.status_code,201,r.json)
        url=r.json['url'];path=Path(base.TEMP.name)/'uploads'/url.split('/')[-1]
        for width in IMAGE_WIDTHS:
            with Image.open(image_variant_path(path,width)) as image:
                self.assertEqual(image.width,width);self.assertLessEqual(image.height,width)
            self.assertEqual(self.f.visitor.get(url+'?w='+str(width)).status_code,404)
        with patch('performance.Image.open',side_effect=AssertionError('must reuse prepared images')):
            prepare_image_variants(path)
            for width in IMAGE_WIDTHS:self.assertEqual(self.f.client.get(url+'?w='+str(width),buffered=True).status_code,200)
        guide=self.f.create(status='public',cover=url)
        etags={}
        for width in IMAGE_WIDTHS:
            r=self.f.visitor.get(url+'?w='+str(width),buffered=True)
            self.assertEqual(r.status_code,200);self.assertEqual(r.headers['Cache-Control'],'private, no-cache');etags[width]=r.headers['ETag']
        guide['status']='private';self.f.mutate('PUT','/api/guides/'+str(guide['id']),guide)
        for width in IMAGE_WIDTHS:self.assertEqual(self.f.visitor.get(url+'?w='+str(width),headers={'If-None-Match':etags[width]}).status_code,404)
    def test_failed_upload_cleans_original_and_prepared_sizes(self):
        root=Path(base.TEMP.name);before={str(p) for p in root.rglob('*.webp')}
        with patch('app.audit',side_effect=RuntimeError('simulated transaction failure')):
            self.assertEqual(self.upload().status_code,500)
        self.assertEqual({str(p) for p in root.rglob('*.webp')},before)
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],0)
    def test_portrait_preparation_decodes_once_and_cleans_partial_failure(self):
        root=Path(base.TEMP.name);path=root/'uploads'/('e'*32+'.webp')
        Image.new('RGB',(800,1600),'blue').save(path,'WEBP')
        from performance import remove_image_variants, _save_variant
        remove_image_variants(path)
        with patch('performance.Image.open',wraps=Image.open) as opened:
            prepare_image_variants(path);self.assertEqual(opened.call_count,1)
        for width in IMAGE_WIDTHS:
            with Image.open(image_variant_path(path,width)) as image:self.assertEqual(image.size,(width//2,width))
        remove_image_variants(path);path.unlink()
        before={str(p) for p in root.rglob('*.webp')};calls=[]
        def fail_later(picture,result,width):
            calls.append(width)
            if width==480:raise OSError('simulated image write failure')
            return _save_variant(picture,result,width)
        with patch('performance._save_variant',side_effect=fail_later):self.assertEqual(self.upload().status_code,400)
        self.assertEqual(calls,[320,480]);self.assertEqual({str(p) for p in root.rglob('*.webp')},before)
