import io
import base64
import shutil
import os
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from werkzeug.security import generate_password_hash

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
TEMP=tempfile.TemporaryDirectory()
os.environ['TRAVEL_DATA']=TEMP.name
os.environ['TRAVEL_WRITE_LOCK']=str(Path(TEMP.name)/'write.lock')
Path(os.environ['TRAVEL_WRITE_LOCK']).touch()
os.environ['TRAVEL_SECRET']='isolated-integration-test-secret'
os.environ['TRAVEL_DATABASE_URL']=os.environ.get('TRAVEL_TEST_DATABASE_URL','dbname=travelnotes_test user=travelnotes host=/var/run/postgresql')
from database import connect,initialize
initialize()
from app import app
HASH=generate_password_hash('testing-password-123')

class AppTests(unittest.TestCase):
    def test_backup_guard_keeps_reads_available_and_releases_after_request(self):
        import fcntl
        self.login()
        with Path(os.environ['TRAVEL_WRITE_LOCK']).open('rb') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(self.client.get('/api/health').status_code,200)
            response=self.mutate('POST','/api/guides',{'title':'guarded'})
            self.assertEqual(response.status_code,503)
            self.assertIn('备份',response.json['error'])
        self.create()
        with Path(os.environ['TRAVEL_WRITE_LOCK']).open('rb') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def test_health_checks_database_without_exposing_details(self):
        from unittest.mock import patch
        import psycopg
        response=app.test_client().get('/api/health')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json,{'ok':True})
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        with patch('app.db',side_effect=psycopg.OperationalError('private connection details')):
            response=app.test_client().get('/api/health')
        self.assertEqual(response.status_code,503)
        self.assertEqual(response.json,{'ok':False})

    def setUp(self):
        for name in ('html-imports','uploads/handbooks'):
            shutil.rmtree(Path(TEMP.name)/name,ignore_errors=True)
        with connect() as c:
            assert c.info.dbname in ('travelnotes_test','travelagent_test')
            c.execute('TRUNCATE agent_tasks,guides,admins,categories,tags,media,audit_log,login_attempts,settings RESTART IDENTITY CASCADE')
        initialize()
        with connect() as c: c.execute('INSERT INTO admins(username,password_hash) VALUES(%s,%s)',('admin',HASH))
        self.client=app.test_client();self.visitor=app.test_client();self.csrf=self.client.get('/api/session').json['csrf']
    def login(self,client=None,password='testing-password-123',username='admin'):
        client=client or self.client;token=client.get('/api/session').json['csrf']
        r=client.post('/api/login',json={'username':username,'password':password},headers={'X-CSRF-Token':token})
        self.assertEqual(r.status_code,200,r.json)
        if client==self.client:self.csrf=r.json['csrf']
        return r.json['csrf']
    def mutate(self,method,path,data=None,**kwargs):return self.client.open(path,method=method,json=data,headers={'X-CSRF-Token':self.csrf},**kwargs)
    def create(self,**extra):
        data={'title':'旅途测试','destination':'南京','body':'## 第一天\n出发','tags':['秋天'],'status':'draft',**extra}
        r=self.mutate('POST','/api/guides',data);self.assertEqual(r.status_code,201,r.json)
        return self.client.get('/api/guides/'+str(r.json['id'])).json['guide']
    def test_auth_and_csrf(self):
        for path in ['/api/admin/overview','/api/admin/guides','/api/admin/media','/api/admin/taxonomy','/api/admin/audit','/api/admin/export']:
            self.assertEqual(self.visitor.get(path).status_code,401)
        self.assertEqual(self.client.post('/api/guides',json={}).status_code,403)
        self.assertEqual(self.mutate('POST','/api/guides',{}).status_code,401)
        self.login();self.assertEqual(self.client.post('/api/admin/settings',json={}).status_code,403)
        self.assertEqual(self.client.put('/api/admin/settings',json={}).status_code,403)
    def test_bootstrap_preserves_visibility_and_csrf(self):
        self.login();public=self.create(status='public');self.create(status='private');self.create(status='draft')
        response=self.visitor.get('/api/bootstrap');data=response.json
        self.assertFalse(data['session']['authenticated'])
        self.assertEqual([g['id'] for g in data['guides']],[public['id']])
        self.assertIn('site_name',data['site']);self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertEqual(self.visitor.post('/api/guides',json={},headers={'X-CSRF-Token':data['session']['csrf']}).status_code,401)
        data=self.client.get('/api/bootstrap').json
        self.assertTrue(data['session']['authenticated']);self.assertEqual(len(data['guides']),3)
    def test_read_view_and_render_cache_follow_content_changes(self):
        self.login();guide=self.create(status='public',body='## 原正文');url='/api/guides/'+str(guide['id'])
        first=self.visitor.get(url+'?view=read').json['guide']
        self.assertNotIn('body',first);self.assertIn('原正文',first['html'])
        self.assertEqual(self.client.get(url).json['guide']['body'],'## 原正文')
        guide['body']='## 更新后的正文';self.assertEqual(self.mutate('PUT',url,guide).status_code,200)
        second=self.visitor.get(url+'?view=read').json['guide'];self.assertIn('更新后的正文',second['html'])
        guide=self.client.get(url).json['guide'];guide['status']='private';self.mutate('PUT',url,guide)
        self.assertEqual(self.visitor.get(url+'?view=read').status_code,404)
    def test_image_variant_cache_revalidates_permissions(self):
        self.login();buf=io.BytesIO();Image.new('RGB',(1600,900),'green').save(buf,'PNG');buf.seek(0)
        response=self.client.post('/api/upload',data={'image':(buf,'test.png')},headers={'X-CSRF-Token':self.csrf},content_type='multipart/form-data')
        url=response.json['url'];guide=self.create(status='public',cover=url,body=f'![照片]({url})')
        response=self.visitor.get(url+'?w=640',buffered=True)
        self.assertEqual(response.status_code,200);self.assertEqual(response.headers['Cache-Control'],'private, no-cache')
        self.assertEqual(Image.open(io.BytesIO(response.data)).size,(640,360))
        etag=response.headers['ETag']
        self.assertEqual(self.visitor.get(url+'?w=640',headers={'If-None-Match':etag},buffered=True).status_code,304)
        rendered=self.visitor.get('/api/guides/'+str(guide['id'])+'?view=read').json['guide']['html']
        self.assertIn('loading="lazy"',rendered);self.assertIn('width="1600"',rendered);self.assertIn('?w=1280',rendered)
        guide['status']='private';self.mutate('PUT','/api/guides/'+str(guide['id']),guide)
        self.assertEqual(self.visitor.get(url+'?w=640',headers={'If-None-Match':etag}).status_code,404)
        self.assertEqual(self.client.get(url+'?w=640',buffered=True).status_code,200)
        self.assertEqual(self.client.get(url+'?w=99999').status_code,400)
    def test_large_image_upload_limit_and_optimization(self):
        self.login()
        buf=io.BytesIO()
        Image.frombytes('RGB',(2200,2200),os.urandom(2200*2200*3)).save(buf,'PNG',compress_level=1)
        raw=buf.getvalue();self.assertGreater(len(raw),12*1024*1024)
        # A real PNG crosses both of the former application and proxy limits.
        response=self.client.post('/api/upload',data={'image':(io.BytesIO(raw),'large.png')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,201,response.json)
        path=Path(TEMP.name)/'uploads'/response.json['url'].split('/')[-1]
        with Image.open(path) as saved:self.assertEqual(saved.format,'WEBP')
        self.assertLess(path.stat().st_size,len(raw))
        # PNG permits trailing bytes: exercise the exact file-size boundary,
        # including multipart overhead, without a huge decoded pixel allocation.
        tiny=io.BytesIO();Image.new('RGB',(20,20),'blue').save(tiny,'PNG');prefix=tiny.getvalue()
        for size,expected in [(50*1024*1024,201),(50*1024*1024+1,413)]:
            response=self.client.post('/api/upload',data={'image':(io.BytesIO(prefix+b'\0'*(size-len(prefix))),'boundary.png')},headers={'X-CSRF-Token':self.csrf})
            self.assertEqual(response.status_code,expected,response.json)
            if expected==413:self.assertIn('50 MB',response.json['error'])
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],2)
    def test_lifecycle_preserves_identity_and_privacy(self):
        self.login();g=self.create();url='/api/guides/'+str(g['id'])
        self.assertEqual(self.visitor.get(url).status_code,404)
        g['status']='public';r=self.mutate('PUT',url,g);self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(self.visitor.get(url).status_code,200)
        self.assertEqual(self.mutate('DELETE',url).status_code,200)
        self.assertEqual(self.visitor.get(url).status_code,404)
        self.assertEqual(self.mutate('POST',url+'/restore').status_code,200)
        self.assertEqual(self.visitor.get(url).json['guide']['id'],g['id'])
    def test_revision_conflict_does_not_overwrite(self):
        self.login();g=self.create();url='/api/guides/'+str(g['id']);g['title']='First save'
        self.assertEqual(self.mutate('PUT',url,g).status_code,200)
        g['title']='Stale overwrite';self.assertEqual(self.mutate('PUT',url,g).status_code,409)
        self.assertEqual(self.client.get(url).json['guide']['title'],'First save')
    def test_quick_metadata_edit_preserves_content_and_updates_visibility(self):
        self.login();guide=self.create(status='public',body='## 完整行程\n这些正文不能被列表修改覆盖。')
        self.mutate('POST','/api/admin/taxonomy',{'kind':'category','action':'create','name':'城市人文'})
        category=self.client.get('/api/admin/taxonomy').json['categories'][0]['id']
        path='/api/admin/guides/'+str(guide['id'])+'/metadata'
        response=self.mutate('PATCH',path,{'revision':guide['revision'],'category_id':category,'status':'private'})
        self.assertEqual(response.status_code,200,response.json);saved=response.json['guide']
        self.assertEqual(saved['category_id'],category);self.assertEqual(saved['revision'],guide['revision']+1)
        current=self.client.get('/api/guides/'+str(guide['id'])).json['guide']
        for key in ('title','body','cover','destination','tags','days','sources'):self.assertEqual(current[key],guide[key])
        self.assertEqual(self.visitor.get('/api/guides/'+str(guide['id'])).status_code,404)
        self.assertEqual(self.client.get('/api/admin/guides?category='+str(category)).json['total'],1)
        response=self.mutate('PATCH',path,{'revision':saved['revision'],'category_id':None,'status':'public'})
        self.assertEqual(response.status_code,200,response.json);self.assertIsNone(response.json['guide']['category_id'])
        self.assertEqual(self.visitor.get('/api/guides/'+str(guide['id'])).status_code,200)
        with connect() as c:self.assertEqual(c.execute("SELECT count(*) n FROM audit_log WHERE action='guide.quick_update'").fetchone()['n'],2)

    def test_quick_metadata_edit_conflicts_auth_and_trash(self):
        self.login();guide=self.create();path='/api/admin/guides/'+str(guide['id'])+'/metadata'
        data={'revision':guide['revision'],'status':'private'}
        self.assertEqual(self.visitor.patch(path,json=data).status_code,401)
        self.assertEqual(self.client.patch(path,json=data).status_code,403)
        self.assertEqual(self.mutate('PATCH',path,data).status_code,200)
        self.assertEqual(self.mutate('PATCH',path,{'revision':guide['revision'],'status':'public'}).status_code,409)
        self.assertEqual(self.mutate('PUT','/api/guides/'+str(guide['id']),guide).status_code,409)
        current=self.client.get('/api/guides/'+str(guide['id'])).json['guide']
        noop=self.mutate('PATCH',path,{'revision':current['revision'],'status':'private'})
        self.assertEqual(noop.json['guide']['revision'],current['revision'])
        self.mutate('DELETE','/api/guides/'+str(guide['id']))
        self.assertEqual(self.mutate('PATCH',path,{'revision':current['revision']+1,'status':'public'}).status_code,400)

    def test_quick_metadata_validation_is_atomic(self):
        self.login();guide=self.create(body='');path='/api/admin/guides/'+str(guide['id'])+'/metadata'
        for data in ({'status':'public'},{'status':'invalid'},{'category_id':True},{'category_id':9999},{'category_id':'1'},{'category_id':[]},{'category_id':-1},{'body':'unexpected'},{'status':'private','body':'unexpected'},{},{'revision':True,'status':'private'}):
            response=self.mutate('PATCH',path,{'revision':guide['revision'],**data})
            self.assertEqual(response.status_code,400,response.json)
        self.mutate('POST','/api/admin/taxonomy',{'kind':'category','action':'create','name':'新分类'})
        category=self.client.get('/api/admin/taxonomy').json['categories'][0]['id']
        self.assertEqual(self.mutate('PATCH',path,{'revision':guide['revision'],'category_id':category,'status':'public'}).status_code,400)
        current=self.client.get('/api/guides/'+str(guide['id'])).json['guide']
        self.assertEqual(current['status'],'draft');self.assertIsNone(current['category_id']);self.assertEqual(current['revision'],guide['revision'])
    def test_bulk_is_atomic_and_purge_requires_trash(self):
        self.login();a=self.create();b=self.create(body='')
        data={'action':'public','ids':[a['id'],b['id']]}
        self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',data).status_code,400)
        self.assertEqual(self.client.get('/api/guides/'+str(a['id'])).json['guide']['status'],'draft')
        data['action']='purge';self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',data).status_code,400)
        data['action']='trash';self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',data).status_code,200)
        data['action']='purge';self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',data).status_code,200)
        self.assertEqual(self.client.get('/api/guides/'+str(a['id'])).status_code,404)
    def test_taxonomy_propagates_without_removing_guides(self):
        self.login();self.assertEqual(self.mutate('POST','/api/admin/taxonomy',{'kind':'category','action':'create','name':'国内'}).status_code,200)
        cat=self.client.get('/api/admin/taxonomy').json['categories'][0]['id'];g=self.create(category_id=cat)
        for action,new in [('rename','深秋'),('delete','')]:
            old='秋天' if action=='rename' else '深秋'
            r=self.mutate('POST','/api/admin/taxonomy',{'kind':'tag','action':action,'old':old,'name':new});self.assertEqual(r.status_code,200,r.json)
            tags=self.client.get('/api/guides/'+str(g['id'])).json['guide']['tags'];self.assertEqual(tags,[new] if new else [])
        self.assertEqual(self.mutate('POST','/api/admin/taxonomy',{'kind':'category','action':'delete','id':cat}).status_code,200)
        self.assertIsNone(self.client.get('/api/guides/'+str(g['id'])).json['guide']['category_id'])
    def test_media_privacy_and_reference_protection(self):
        self.login();buf=io.BytesIO();Image.new('RGB',(80,60),'green').save(buf,'PNG');buf.seek(0)
        r=self.client.post('/api/upload',data={'image':(buf,'image.png')},headers={'X-CSRF-Token':self.csrf},content_type='multipart/form-data');self.assertEqual(r.status_code,201,r.json)
        url=r.json['url'];filename=url.split('/')[-1]
        self.assertEqual(self.visitor.get(url).status_code,404)
        g=self.create(cover=url,status='public');self.assertEqual(self.visitor.get(url).status_code,200)
        self.assertEqual(self.mutate('POST','/api/admin/media/'+filename,{'action':'trash'}).status_code,409)
        self.mutate('DELETE','/api/guides/'+str(g['id']));self.assertEqual(self.visitor.get(url).status_code,404)
        self.assertEqual(self.mutate('POST','/api/admin/media/'+filename,{'action':'trash'}).status_code,409)
        self.mutate('POST','/api/admin/guides/bulk',{'action':'purge','ids':[g['id']]})
        self.assertEqual(self.mutate('POST','/api/admin/media/'+filename,{'action':'trash'}).status_code,200)
        self.assertEqual(self.mutate('POST','/api/admin/media/'+filename,{'action':'restore'}).status_code,200)
    def test_settings_hide_samples_for_visitors(self):
        self.login();g=self.create(status='public',sample=True)
        data={'site_name':'新行笺','tagline':'旅行存档','footer':'出发','show_samples':False}
        r=self.mutate('PUT','/api/admin/settings',data);self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(self.visitor.get('/api/site').json,data)
        self.assertEqual(self.visitor.get('/api/guides').json['guides'],[])
        self.assertEqual(self.visitor.get('/api/guides/'+str(g['id'])).status_code,404)
        self.assertEqual(self.client.get('/api/guides/'+str(g['id'])).status_code,200)
    def test_handbook_visibility_follows_guide_and_removed_link(self):
        self.login();guide=self.create();api_url='/api/guides/'+str(guide['id'])
        url='/guides/'+str(guide['id'])+'/handbook'
        path=Path(TEMP.name)/'uploads'/'handbooks'/f"{guide['id']}.html"
        path.parent.mkdir(exist_ok=True);path.write_text('<!doctype html><h1>旅行手册</h1>')
        self.addCleanup(path.unlink,missing_ok=True)
        original=path.with_suffix('.original.html');original.write_text('<h1>完整离线手册</h1>');self.addCleanup(original.unlink,missing_ok=True)
        image_path=path.parent/str(guide['id'])/('a'*32+'.webp');image_path.parent.mkdir(exist_ok=True)
        Image.new('RGB',(80,60),'blue').save(image_path,'WEBP');self.addCleanup(image_path.unlink,missing_ok=True)
        image_url=url+'/images/'+image_path.name
        guide['body']=f'[原版手册]({url})'
        self.assertEqual(self.mutate('PUT',api_url,guide).status_code,200)
        self.assertEqual(self.visitor.get(url).status_code,404)
        self.assertEqual(self.visitor.get(image_url).status_code,404)
        self.assertEqual(self.visitor.get(url+'?download=1').status_code,404)
        response=self.client.get(url)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertIn("script-src 'sha256-",response.headers['Content-Security-Policy'])
        for status,expected in [('public',200),('private',404),('draft',404),('public',200)]:
            guide=self.client.get(api_url).json['guide'];guide['status']=status
            self.assertEqual(self.mutate('PUT',api_url,guide).status_code,200)
            self.assertEqual(self.visitor.get(url).status_code,expected)
            self.assertEqual(self.visitor.get(image_url,buffered=True).status_code,expected)
            download=self.visitor.get(url+'?download=1',buffered=True)
            self.assertEqual(download.status_code,expected)
            if expected==200:self.assertIn('attachment;',download.headers['Content-Disposition'])
        self.mutate('DELETE',api_url);self.assertEqual(self.visitor.get(url).status_code,404)
        self.mutate('POST',api_url+'/restore');self.assertEqual(self.visitor.get(url).status_code,200)
        guide=self.client.get(api_url).json['guide'];guide['body']='移除原版入口'
        self.assertEqual(self.mutate('PUT',api_url,guide).status_code,200)
        self.assertEqual(self.visitor.get(url).status_code,404)
        self.assertEqual(self.client.get(url).status_code,404)
    def test_username_change_preserves_password_and_revokes_old_sessions(self):
        self.login();other=app.test_client();self.login(other)
        with connect() as c: original=c.execute('SELECT * FROM admins WHERE username=%s',('admin',)).fetchone()
        old_cookie=self.client.get_cookie('session').value
        r=self.mutate('PUT','/api/admin/account',{'username':'travel_editor','display_name':'旅行编辑','current_password':'testing-password-123'})
        self.assertEqual(r.status_code,200,r.json);self.assertTrue(r.json['reauthenticate']);self.assertEqual(r.json['username'],'travel_editor')
        self.assertEqual(other.get('/api/admin/overview').status_code,401)
        replay=app.test_client();replay.set_cookie('session',old_cookie)
        self.assertEqual(replay.get('/api/admin/overview').status_code,401)
        token=other.get('/api/session').json['csrf']
        self.assertEqual(other.post('/api/login',json={'username':'admin','password':'testing-password-123'},headers={'X-CSRF-Token':token}).status_code,401)
        self.login(username='travel_editor')
        with connect() as c:
            changed=c.execute('SELECT * FROM admins WHERE id=%s',(original['id'],)).fetchone()
            self.assertEqual(changed['password_hash'],original['password_hash'])
            self.assertEqual(changed['session_version'],original['session_version']+1)
        logs=self.client.get('/api/admin/audit').json['logs']
        entry=next(l for l in logs if l['action']=='account.username_change')
        self.assertEqual(entry['details'],{'old_username':'admin','new_username':'travel_editor'})
        self.assertNotIn('testing-password-123',str(logs))
    def test_username_validation_and_conflicts_leave_account_unchanged(self):
        self.login()
        with connect() as c: c.execute('INSERT INTO admins(username,password_hash) VALUES(%s,%s)',('occupied',HASH))
        data={'username':'travel_editor','current_password':'wrong-password'}
        self.assertEqual(self.mutate('PUT','/api/admin/account',data).status_code,400)
        data['current_password']='testing-password-123'
        for name in ['', 'ab', 'a'*33, 'has space', '<script>', None]:
            data['username']=name;self.assertEqual(self.mutate('PUT','/api/admin/account',data).status_code,400)
        data['username']='occupied';self.assertEqual(self.mutate('PUT','/api/admin/account',data).status_code,409)
        self.assertEqual(self.client.get('/api/session').json['user']['username'],'admin')
        with connect() as c: self.assertEqual(c.execute('SELECT password_hash FROM admins WHERE username=%s',('admin',)).fetchone()['password_hash'],HASH)
    def test_username_and_password_can_change_together(self):
        self.login();data={'username':'new_editor','current_password':'testing-password-123','new_password':'updated-password-456','confirm_password':'updated-password-456'}
        r=self.mutate('PUT','/api/admin/account',data);self.assertEqual(r.status_code,200,r.json)
        self.login(username='new_editor',password='updated-password-456')
        actions=[r['action'] for r in self.client.get('/api/admin/audit').json['logs']]
        self.assertIn('account.username_change',actions);self.assertIn('account.password_change',actions)
    def test_unchanged_username_only_updates_profile(self):
        self.login();r=self.mutate('PUT','/api/admin/account',{'username':'admin','display_name':'旅行编辑','current_password':'testing-password-123'})
        self.assertEqual(r.status_code,200,r.json);self.assertFalse(r.json['reauthenticate'])
        self.assertEqual(self.client.get('/api/session').json['user']['display_name'],'旅行编辑')
    def test_password_minimum_is_eight_characters(self):
        self.login()
        data={'current_password':'testing-password-123','new_password':'abc1234','confirm_password':'abc1234'}
        self.assertEqual(self.mutate('PUT','/api/admin/account',data).status_code,400)
        self.assertTrue(self.client.get('/api/session').json['authenticated'])
        data.update(new_password='abc12345',confirm_password='abc12345')
        result=self.mutate('PUT','/api/admin/account',data)
        self.assertEqual(result.status_code,200,result.json)
        self.assertTrue(result.json['reauthenticate'])
        self.login(password='abc12345')
    def test_password_change_revokes_all_sessions(self):
        self.login();other=app.test_client();self.login(other)
        data={'current_password':'wrong','new_password':'new-password-456','confirm_password':'new-password-456','display_name':'编辑'}
        self.assertEqual(self.mutate('PUT','/api/admin/account',data).status_code,400)
        data['current_password']='testing-password-123'
        r=self.mutate('PUT','/api/admin/account',data);self.assertEqual(r.status_code,200,r.json)
        self.assertFalse(other.get('/api/session').json['authenticated']);self.assertEqual(other.get('/api/admin/overview').status_code,401)
        self.assertEqual(self.client.get('/api/admin/overview').status_code,401)
        self.login(password='new-password-456')
        logs=self.client.get('/api/admin/audit').get_data(as_text=True);self.assertNotIn('new-password-456',logs);self.assertNotIn('scrypt:',logs)
    def test_preview_and_input_validation(self):
        self.login();r=self.mutate('POST','/api/admin/preview',{'body':'<script>alert(1)</script><img src="x" onerror="alert(1)">\n[bad](javascript:alert(1))'})
        self.assertEqual(r.status_code,200);self.assertNotIn('<script',r.json['html']);self.assertNotIn('onerror',r.json['html']);self.assertNotIn('javascript:',r.json['html'])
        self.assertEqual(self.mutate('POST','/api/guides',{'title':'bad','destination':'x','tags':'wrong'}).status_code,400)
        self.assertEqual(self.mutate('POST','/api/admin/guides/bulk',{'action':'public','ids':['1;DROP TABLE guides']}).status_code,400)
    def test_export_and_search_support_chinese_and_quotes(self):
        self.login();g=self.create(title="泉州 O'Reilly 攻略",status='public')
        r=self.client.get('/api/admin/guides',query_string={'q':"O'Reilly"});self.assertEqual(r.status_code,200,r.json);self.assertEqual(r.json['total'],1)
        export=self.client.get('/api/admin/export');self.assertEqual(export.status_code,200)
        data=export.json;self.assertEqual(data['guides'][0]['id'],g['id']);self.assertNotIn('password',export.get_data(as_text=True));self.assertNotIn('scrypt:',export.get_data(as_text=True))
        with connect() as c:self.assertEqual(c.execute('SHOW server_encoding').fetchone()['server_encoding'],'UTF8')
    def test_login_rate_limit(self):
        for _ in range(8):self.assertEqual(self.mutate('POST','/api/login',{'username':'unknown','password':'x'}).status_code,401)
        self.assertEqual(self.mutate('POST','/api/login',{'username':'admin','password':'testing-password-123'}).status_code,429)
    def test_admin_filter_pagination_and_dashboard(self):
        self.login();self.create(status='public');self.create(status='draft');self.create(status='private')
        r=self.client.get('/api/admin/overview');self.assertEqual(r.status_code,200,r.json);self.assertEqual(r.json['counts']['total'],3)
        self.assertEqual(self.client.get('/api/admin/guides?status=public').json['total'],1)
        self.assertEqual(self.client.get('/api/admin/guides?tag=秋天').json['total'],3)
        self.assertEqual(self.client.get('/api/admin/guides?page=-1').json['page'],1)

    def import_fixture(self):
        image=io.BytesIO();Image.new('RGB',(100,70),'blue').save(image,'PNG')
        return ('''<!doctype html><html><head><meta charset="utf-8"><title>测试旅行</title>
        <meta name="travel:destination" content="测试城市"><meta name="travel:days" content="4">
        <style>body{color:green}</style><script>window.bad=1</script></head><body>
        <h1>测试城市四天三晚</h1><p>这是一篇用于验证导入、图片存档、表格以及访问权限的旅行攻略。</p>
        <h2>第一天</h2><table><tr><th>时间</th><th>路线</th></tr><tr><td>上午</td><td>看展</td></tr></table>
        <img src="data:image/png;base64,'''+base64.b64encode(image.getvalue()).decode()+'''" alt="旅行照片" onerror="alert(1)">
        <a href="javascript:alert(1)">不执行</a></body></html>''').encode()

    def stage_import(self,source=None):
        raw=source or self.import_fixture()
        response=self.client.post('/api/admin/html-imports',data={'file':(io.BytesIO(raw),'trip.html')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,201,response.json)
        token=response.json['token'];preview=self.client.get('/api/admin/html-imports/'+token)
        self.assertEqual(preview.status_code,200,preview.json)
        return token,preview.json

    def test_html_import_preview_requires_admin_csrf_and_same_session(self):
        self.assertEqual(self.visitor.post('/api/admin/html-imports').status_code,401)
        self.login();self.assertEqual(self.client.post('/api/admin/html-imports').status_code,403)
        token,preview=self.stage_import();self.assertEqual(preview['stats']['images'],1)
        self.assertEqual(preview['guide']['days'],4);self.assertIn('<table>',preview['html'])
        self.assertNotIn('<script',preview['html']);self.assertNotIn('onerror',preview['html'])
        image='/api/admin/html-imports/'+token+'/images/'+preview['guide']['cover'].split('/')[-1]
        self.assertEqual(self.client.get(image,buffered=True).status_code,200)
        self.assertEqual(self.visitor.get(image).status_code,401)
        other=app.test_client();self.login(other)
        self.assertEqual(other.get('/api/admin/html-imports/'+token).status_code,404)
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM guides').fetchone()['n'],0)
            self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],0)
        self.assertEqual(self.mutate('DELETE','/api/admin/html-imports/'+token).status_code,200)
        self.assertEqual(self.client.get(image).status_code,404)

    def test_html_import_archive_images_and_source_follow_guide_visibility(self):
        self.login();token,preview=self.stage_import();data=preview['guide'];data['status']='private'
        response=self.mutate('POST','/api/admin/html-imports/'+token+'/save',data)
        self.assertEqual(response.status_code,201,response.json);gid=response.json['id'];url='/api/guides/'+str(gid)
        guide=self.client.get(url).json['guide'];self.assertIn('下载上传源文件',guide['body'])
        handbook=f'/guides/{gid}/handbook';filename=guide['cover'].split('/')[-1]
        paths=[handbook,handbook+'?download=1',handbook+'?download=source',handbook+'/images/'+filename,guide['cover']]
        for path in paths:
            self.assertEqual(self.visitor.get(path).status_code,404,path)
            self.assertEqual(self.client.get(path,buffered=True).status_code,200,path)
        response=self.client.get(handbook,buffered=True)
        self.assertIn("script-src 'none'",response.headers['Content-Security-Policy'])
        self.assertNotIn('<script',response.get_data(as_text=True));self.assertNotIn('onerror',response.get_data(as_text=True))
        self.assertIn('data:image/webp;base64,',self.client.get(handbook+'?download=1',buffered=True).get_data(as_text=True))
        source=self.client.get(handbook+'?download=source',buffered=True)
        self.assertEqual(source.data,self.import_fixture());self.assertIn('attachment',source.headers['Content-Disposition'])
        self.assertEqual(source.mimetype,'application/octet-stream')
        guide['status']='public';self.assertEqual(self.mutate('PUT',url,guide).status_code,200)
        for path in paths:self.assertEqual(self.visitor.get(path,buffered=True).status_code,200,path)
        self.mutate('DELETE',url)
        for path in paths:self.assertEqual(self.visitor.get(path).status_code,404,path)

    def test_html_import_is_idempotent_and_rejects_duplicate_upload(self):
        self.login();token,preview=self.stage_import();path='/api/admin/html-imports/'+token+'/save'
        first=self.mutate('POST',path,preview['guide']);self.assertEqual(first.status_code,201,first.json)
        retry=self.mutate('POST',path,preview['guide']);self.assertEqual(retry.status_code,200,retry.json)
        self.assertEqual(first.json['id'],retry.json['id'])
        duplicate=self.client.post('/api/admin/html-imports',data={'file':(io.BytesIO(self.import_fixture()),'trip.html')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(duplicate.status_code,409,duplicate.json)
        self.assertEqual(duplicate.json['existing']['id'],first.json['id'])
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM guides').fetchone()['n'],1)

    def test_html_import_invalid_save_rolls_back_images_and_can_retry(self):
        self.login();token,preview=self.stage_import();data=preview['guide'].copy();data['destination']=''
        path='/api/admin/html-imports/'+token+'/save'
        self.assertEqual(self.mutate('POST',path,data).status_code,400)
        image=Path(TEMP.name)/'uploads'/preview['guide']['cover'].split('/')[-1]
        self.assertFalse(image.exists())
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM guides').fetchone()['n'],0)
            self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],0)
        self.assertEqual(self.mutate('POST',path,preview['guide']).status_code,201)

if __name__=='__main__':unittest.main()
