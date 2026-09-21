import base64
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from html_imports import ImportProblem, MAX_UPLOAD, parse_upload


class ParserTests(unittest.TestCase):
    def parse(self,raw,filename='trip.html'):
        with tempfile.TemporaryDirectory() as directory:
            return parse_upload(raw,filename,Path(directory))

    def package(self,files):
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            for name,value in files.items():archive.writestr(name,value)
        return buffer.getvalue()

    def test_zip_keeps_nested_assets_lists_tables_and_metadata(self):
        image=io.BytesIO();Image.new('RGB',(3000,1200),'green').save(image,'PNG')
        html='''<html><head><meta charset="utf-8"><meta name="travel:country" content="中国"><link rel="stylesheet" href="css/theme.css"></head>
        <body><nav><a href="#day1">跳到首日</a></nav><h1>婺源四天三晚</h1><section id="day1"><h2>第一天</h2><p>正常攻略正文，走古村并在适合的位置休息。</p>
        <ul><li>古村<ul><li>廊桥</li></ul></li></ul><table><tr><th>房间</th><th>晚数</th></tr><tr><td>9间</td><td>3晚</td></tr></table>
        <figure><img src="images/图.png" alt="风景"><figcaption>作者与授权说明</figcaption></figure><details><summary>雨天方案</summary><p>去室内休息。</p></details></section></body></html>'''
        result=self.parse(self.package({'folder/trip.html':html,'folder/images/图.png':image.getvalue(),'folder/css/theme.css':'h1{color:green}'}),'trip.zip')
        self.assertEqual(result['guide']['destination'],'婺源');self.assertEqual(result['guide']['days'],4)
        self.assertEqual(result['guide']['country'],'中国');self.assertEqual(result['stats']['images'],1)
        self.assertEqual(result['images'][0]['width'],1600)
        for phrase in ('古村','廊桥','9间','3晚','作者与授权说明','雨天方案','去室内休息'):
            self.assertIn(phrase,result['guide']['body'])
        self.assertNotIn('跳到首日',result['guide']['body']);self.assertIn('h1{color:green}',result['snapshot'])

    def test_external_images_and_active_content_do_not_execute_or_fetch(self):
        raw=b'''<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><script>alert(1)</script></head><body onload="alert(1)">
        <h1>Travel plan</h1><p>Some readable travel details.</p><img src="http://169.254.169.254/latest/meta-data" onerror="alert(1)">
        <img src="file:///etc/passwd"><iframe src="http://127.0.0.1/"></iframe><object data="evil"></object>
        <a href="javascript:alert(1)">Bad link</a><a href="https://example.com/place">Source</a><svg onload="alert(2)"><foreignObject>evil</foreignObject></svg></body></html>'''
        result=self.parse(raw)
        self.assertEqual(result['stats']['images'],0);self.assertEqual(result['stats']['unresolved_images'],2)
        for phrase in ('<script','<iframe','<object','<svg','javascript:','onerror','onload','http-equiv'):
            self.assertNotIn(phrase,result['snapshot'])
        self.assertNotIn('<img',result['snapshot']);self.assertIn('https://example.com/place',result['guide']['body'])
        self.assertTrue(result['warnings'])

    def test_zip_path_escape_multiple_html_and_oversize_are_rejected(self):
        examples=[{'../trip.html':'<h1>Bad</h1>'},{'/trip.html':'<h1>Bad</h1>'},{'a.html':'<h1>A</h1>','b.html':'<h1>B</h1>'},{'a.html':'<h1>A</h1>','large.png':b'0'*(MAX_UPLOAD+1)}]
        for files in examples:
            with self.subTest(files=list(files)):
                with self.assertRaises(ImportProblem):self.parse(self.package(files),'trip.zip')
        with self.assertRaises(ImportProblem):self.parse(b'not an html file')
        with self.assertRaises(ImportProblem):self.parse(b'<html><script>document.write("generated")</script></html>')

    def test_chinese_encodings_and_english_day_headings(self):
        text='<html><head><meta charset="gbk"></head><body><h1>日本旅行手册</h1><h2>Day 1 到达</h2><p>第一天到达以后好好休息。</p><h2>Day 9 返程</h2></body></html>'
        for raw in (text.encode('gb18030'),text.replace('gbk','utf-8').encode('utf-8-sig'),text.encode('utf-16')):
            parsed=self.parse(raw);self.assertEqual(parsed['guide']['days'],9);self.assertEqual(parsed['guide']['destination'],'日本')
            self.assertIn('好好休息',parsed['guide']['body'])
            self.assertIn('<meta charset="utf-8"/>',parsed['snapshot'])
            self.assertIn('name="viewport"',parsed['snapshot'])


if __name__=='__main__':unittest.main()
