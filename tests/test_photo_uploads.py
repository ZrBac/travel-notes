import io
from pathlib import Path
import unittest
from PIL import Image
import test_app
from database import connect


class PhotoUploadTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_app.AppTests();self.fixture.setUp();self.fixture.login()
    def upload(self,raw,name='phone.jpeg',mime='image/jpeg'):
        return self.fixture.client.post('/api/upload',data={'image':(io.BytesIO(raw),name,mime)},headers={'X-CSRF-Token':self.fixture.csrf})
    def read_saved(self,response):
        self.assertEqual(response.status_code,201,response.json)
        return Image.open(Path(test_app.TEMP.name)/'uploads'/response.json['url'].split('/')[-1])
    def test_jpeg_extensions_and_inaccurate_browser_mime(self):
        buf=io.BytesIO()
        with Image.new('RGB',(120,80),'green') as image:image.save(buf,'JPEG',progressive=True)
        for name,mime in [('photo.jpg','image/jpeg'),('photo.jpeg','image/jpg'),('手机照片.JPEG','application/octet-stream')]:
            with self.subTest(name=name),self.read_saved(self.upload(buf.getvalue(),name,mime)) as saved:
                self.assertEqual(saved.format,'WEBP');self.assertEqual(saved.size,(120,80))
    def test_phone_mpf_jpeg_keeps_main_frame_and_orientation(self):
        buf=io.BytesIO();exif=Image.Exif();exif[274]=6
        with Image.new('RGB',(120,80),'red') as main,Image.new('RGB',(60,40),'blue') as layer:
            main.save(buf,'MPO',save_all=True,append_images=[layer],exif=exif)
        with Image.open(io.BytesIO(buf.getvalue())) as original:
            self.assertEqual(original.format,'MPO');self.assertEqual(original.n_frames,2)
        with self.read_saved(self.upload(buf.getvalue(),'IMG_0001.JPEG')) as saved:
            self.assertEqual(saved.size,(80,120));r,g,b=saved.getpixel((40,60))
            self.assertGreater(r,200);self.assertLess(b,30);self.assertIsNone(saved.getexif().get(274))
    def test_48_megapixel_jpeg_is_downsampled_and_rotated(self):
        buf=io.BytesIO();exif=Image.Exif();exif[274]=6
        with Image.new('RGB',(8000,6000),(10,100,180)) as original:original.save(buf,'JPEG',quality=90,exif=exif)
        with self.read_saved(self.upload(buf.getvalue(),'48MP.jpeg')) as saved:
            self.assertEqual(saved.size,(1800,2400));self.assertLess(len(saved.info.get('exif',b'')),10)
    def test_wrong_extension_and_unsafe_resolution_have_clear_errors(self):
        buf=io.BytesIO()
        with Image.new('RGB',(20,20),'white') as original:original.save(buf,'TIFF')
        response=self.upload(buf.getvalue(),'misnamed.jpeg');self.assertEqual(response.status_code,400);self.assertIn('TIFF',response.json['error'])
        response=self.upload(b'not a photograph','broken.jpeg');self.assertEqual(response.status_code,400);self.assertIn('实际格式',response.json['error'])
        buf=io.BytesIO()
        with Image.new('RGB',(20,20),'white') as original:original.save(buf,'JPEG')
        raw=bytearray(buf.getvalue());sof=raw.index(b'\xff\xc0')
        raw[sof+5:sof+7]=(9000).to_bytes(2,'big');raw[sof+7:sof+9]=(9000).to_bytes(2,'big')
        response=self.upload(bytes(raw),'huge.jpeg');self.assertEqual(response.status_code,400);self.assertIn('8000 万像素',response.json['error'])
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],0)
