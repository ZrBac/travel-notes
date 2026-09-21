"""Records, linked guides and photo visibility against the isolated test database."""
import io
import unittest
from PIL import Image
import test_app as base


class RecordTests(unittest.TestCase):
    setUp = base.AppTests.setUp
    login = base.AppTests.login
    mutate = base.AppTests.mutate
    create = base.AppTests.create

    def photo(self, color='green'):
        buf=io.BytesIO();Image.new('RGB',(1600,900),color).save(buf,'PNG');buf.seek(0)
        response=self.client.post('/api/upload',data={'image':(buf,'travel.png')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,201,response.json)
        return response.json['url']

    def record(self, **extra):
        data=dict(title='泉州的慢时光',destination='泉州',start_date='2026-10-30',end_date='2026-11-02',body='## 小城烟火\n面线糊与古城巷弄。',status='private')
        data.update(extra)
        result=self.mutate('POST','/api/records',data)
        self.assertEqual(result.status_code,201,result.json)
        return self.client.get('/api/records/'+str(result.json['id'])).json['record']

    def test_authentication_and_visibility(self):
        token=self.visitor.get('/api/session').json['csrf']
        self.assertEqual(self.visitor.post('/api/records',json={},headers={'X-CSRF-Token':token}).status_code,401)
        self.assertEqual(self.visitor.get('/api/records?trash=1').status_code,401)
        self.login()
        self.assertEqual(self.client.post('/api/records',json={}).status_code,403)
        public=self.record(status='public');private=self.record(destination='私密城市');draft=self.record(status='draft')
        for row in [private,draft]:self.assertEqual(self.visitor.get('/api/records/'+str(row['id'])).status_code,404)
        data=self.visitor.get('/api/records?status=private').json
        self.assertEqual([r['id'] for r in data['records']],[public['id']])
        self.assertNotIn('私密城市',data['destinations'])
        data=self.visitor.get('/api/bootstrap').json
        self.assertEqual(data['record_count'],1);self.assertEqual(data['records'][0]['id'],public['id'])
        self.assertEqual(self.visitor.post('/api/admin/records/1/action',json={'action':'purge'}).status_code,401)

    def test_photo_visibility_revalidates_cached_variants(self):
        self.login();photo=self.photo();row=self.record(photos=[{'url':photo,'caption':'古城日落'}],body='',status='public')
        url='/api/records/'+str(row['id'])
        response=self.visitor.get(photo+'?w=640',buffered=True)
        self.assertEqual(response.status_code,200);self.assertEqual(Image.open(io.BytesIO(response.data)).size,(640,360))
        etag=response.headers['ETag'];self.assertEqual(self.visitor.get(photo+'?w=640',headers={'If-None-Match':etag}).status_code,304)
        row['status']='private';self.assertEqual(self.mutate('PUT',url,row).status_code,200)
        for path in [photo,photo+'?w=640',photo+'?w=1280',url]:
            self.assertEqual(self.visitor.get(path,headers={'If-None-Match':etag}).status_code,404,path)
        self.assertEqual(self.client.get(photo,buffered=True).status_code,200)
        self.create(status='public',cover=photo)
        self.assertEqual(self.visitor.get(photo+'?w=640',buffered=True).status_code,200)

    def test_photos_order_cover_captions_and_safe_body(self):
        self.login();a=self.photo();b=self.photo('blue')
        photos=[{'url':b,'caption':'海边 <script>alert(1)</script>'},{'url':a,'caption':'小吃'}]
        row=self.record(photos=photos,cover=a,status='public',body='<script>alert(1)</script>\n\n## 体验\n[链接](javascript:alert(1))')
        public=self.visitor.get('/api/records/'+str(row['id'])+'?view=read').json['record']
        self.assertEqual(public['photos'],photos);self.assertEqual(public['cover'],a)
        self.assertEqual(public['photo_count'],2);self.assertNotIn('body',public)
        self.assertNotIn('<script',public['html']);self.assertNotIn('javascript:',public['html'])
        row['photos'].reverse();row['cover']=b
        self.assertEqual(self.mutate('PUT','/api/records/'+str(row['id']),row).status_code,200)
        self.assertEqual(self.client.get('/api/records/'+str(row['id'])).json['record']['photos'][0]['url'],a)

    def test_validation_rejects_broken_references_and_dates(self):
        self.login();a=self.photo();valid=dict(title='旅行',destination='泉州',start_date='2026-10-30',body='正文')
        for extra in [dict(start_date='2026-02-30'),dict(end_date='2026-10-29'),dict(guide_day=1),dict(guide_id=True),dict(guide_id=9999),dict(photos=[{'url':'https://example.com/image.jpg'}]),dict(photos=[{'url':'/media/'+'a'*32+'.webp'}]),dict(photos=[{'url':a}]*2),dict(photos=[{'url':a}]*31),dict(photos=[{'url':a,'caption':'长'*201}]),dict(photos=[{'url':a}],cover='/static/assets/lake.jpg'),dict(cover={'bad':'value'}),dict(status='public',body='')]:
            response=self.mutate('POST','/api/records',{**valid,**extra})
            self.assertEqual(response.status_code,400,(extra,response.get_data(as_text=True)))
        response=self.mutate('POST','/api/records',{**valid,'photos':[{'url':a}],'cover':{'bad':'value'}})
        self.assertEqual(response.status_code,400)

    def test_linked_private_guide_is_hidden_and_purge_preserves_record(self):
        self.login();guide=self.create(status='private');row=self.record(status='public',guide_id=guide['id'],guide_day=1)
        url='/api/records/'+str(row['id'])
        data=self.visitor.get(url).json
        self.assertIsNone(data['guide']);self.assertIsNone(data['record']['guide_id']);self.assertIsNone(data['record']['guide_day'])
        self.assertEqual(self.visitor.get('/api/records?guide='+str(guide['id'])).status_code,404)
        self.assertNotIn('guide_id',self.visitor.get('/api/records').json['records'][0])
        guide['status']='public';self.mutate('PUT','/api/guides/'+str(guide['id']),guide)
        self.assertEqual(self.visitor.get(url).json['guide']['title'],guide['title'])
        self.assertEqual(self.visitor.get('/api/records?guide='+str(guide['id'])).json['total'],1)
        self.mutate('DELETE','/api/guides/'+str(guide['id']))
        self.assertIsNone(self.visitor.get(url).json['guide'])
        self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',{'ids':[guide['id']],'action':'purge'}).status_code,200)
        data=self.visitor.get(url).json['record'];self.assertIsNone(data['guide_id']);self.assertIsNone(data['guide_day'])

    def test_lifecycle_conflicts_and_media_references(self):
        self.login();photo=self.photo();row=self.record(status='public',photos=[{'url':photo}])
        url='/api/records/'+str(row['id']);action='/api/admin/records/'+str(row['id'])+'/action';media='/api/admin/media/'+photo.split('/')[-1]
        row['title']='新的回忆';self.assertEqual(self.mutate('PUT',url,row).status_code,200)
        row['title']='过期的回忆';self.assertEqual(self.mutate('PUT',url,row).status_code,409)
        refs=self.client.get('/api/admin/media').json['media'][0]['references']
        self.assertEqual(refs[0]['kind'],'record');self.assertEqual(refs[0]['id'],row['id'])
        self.assertEqual(self.mutate('POST',action,{'action':'purge'}).status_code,400)
        self.assertEqual(self.mutate('POST',action,{'action':'trash'}).status_code,200)
        self.assertEqual(self.visitor.get(url).status_code,404);self.assertEqual(self.visitor.get(photo).status_code,404)
        self.assertEqual(self.mutate('POST',media,{'action':'trash'}).status_code,409)
        self.assertEqual(self.client.get('/api/records?trash=1').json['total'],1)
        self.assertEqual(self.mutate('POST',action,{'action':'restore'}).status_code,200)
        self.assertEqual(self.visitor.get(url).status_code,200)
        self.mutate('POST',action,{'action':'trash'});self.mutate('POST',action,{'action':'purge'})
        self.assertEqual(self.client.get(url).status_code,404)
        self.assertEqual(self.mutate('POST',media,{'action':'trash'}).status_code,200)

    def test_pagination_filters_and_export(self):
        self.login()
        for i in range(13):self.record(status='public',title='旅途 '+str(i),start_date='2026-10-'+str(10+i))
        self.record(status='private',destination='秘密城市',start_date='2025-01-01',end_date='')
        data=self.visitor.get('/api/records?page=1').json
        self.assertEqual(data['total'],13);self.assertEqual(len(data['records']),12);self.assertEqual(data['pages'],2)
        self.assertEqual(data['records'][0]['title'],'旅途 12');self.assertEqual(data['years'],[2026])
        self.assertEqual(len(self.visitor.get('/api/records?page=2').json['records']),1)
        self.assertEqual(self.visitor.get('/api/records?q=旅途+12&year=2026&destination=泉州').json['total'],1)
        self.assertEqual(self.visitor.get('/api/records?year=2025').json['total'],0)
        data=self.client.get('/api/admin/export').json
        self.assertEqual(data['format'],'travel-notes-export-v2');self.assertEqual(len(data['records']),14)
        self.assertEqual(self.client.get('/api/admin/overview').json['records'],dict(total=14,public=13))
