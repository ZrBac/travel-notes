"""Footprint AI against an isolated DB: no publication, stale writes or fake images."""
import copy
import importlib.util
import io
import json
import time
import unittest
from pathlib import Path

from PIL import Image
from psycopg.types.json import Jsonb
import test_app as base
from database import connect
from app import render_markdown


class RecordAssistantTests(unittest.TestCase):
    setUp = base.AppTests.setUp
    login = base.AppTests.login
    mutate = base.AppTests.mutate
    endpoint = '/api/admin/record-assistant/tasks'

    def prepare(self):
        self.login()
        with connect() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)", (Jsonb({'heartbeat':time.time(),'authenticated':True}),))

    def snapshot(self, **extra):
        return {'id':None,'revision':None,'title':'','destination':'南京','start_date':'2026-11-06','end_date':'2026-11-07',
                'summary':'','body':'','actual_cost':'','photos':[],**extra}

    def submit(self, snapshot=None, **extra):
        return self.mutate('POST', self.endpoint, {'record':snapshot or self.snapshot(),'action':'record_generate',
                           'prompt':'逛了老街，吃了鸭血粉丝汤，下午走累了就回酒店休息','request_key':__import__('secrets').token_hex(16),**extra})

    def photo(self, color='green'):
        buf=io.BytesIO();Image.new('RGB',(80,60),color).save(buf,'JPEG');buf.seek(0)
        r=self.client.post('/api/upload',data={'image':(buf,'真实旅行.jpeg')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(r.status_code,201,r.json);return r.json['url']

    def done(self, task_id, **extra):
        result={'title':'南京老街的慢时光','summary':'和家人逛老街，下午歇一歇。','body':'## 古城慢游\n老街走累了就休息。','warnings':[],**extra}
        with connect() as c:
            c.execute("UPDATE agent_tasks SET status='done',result=%s,report=%s WHERE id=%s",(result['body'],Jsonb({'workflow_result':result}),task_id))
        return result

    def detail(self, task_id):
        r=self.client.get(self.endpoint+'/'+str(task_id));self.assertEqual(r.status_code,200,r.json);return r.json['task']

    def preview(self, task_id, snapshot):
        return self.mutate('POST',self.endpoint+'/'+str(task_id)+'/preview',{'record':snapshot})

    def test_admin_only_csrf_no_store_and_standalone_creation_without_trip(self):
        for path in (self.endpoint,self.endpoint+'/1',self.endpoint+'/1/preview'):
            r=self.visitor.get(path) if not path.endswith('preview') else self.visitor.post(path,json={})
            self.assertEqual(r.status_code,401);self.assertEqual(r.headers['Cache-Control'],'no-store')
        self.prepare();self.assertEqual(self.client.post(self.endpoint,json={}).status_code,403)
        photo=self.photo();snapshot=self.snapshot(photos=[{'url':photo,'caption':'家人一起走过的老街'}])
        r=self.submit(snapshot,request_key='a'*32);self.assertEqual(r.status_code,201,r.json);tid=r.json['id']
        again=self.submit(snapshot,request_key='a'*32);self.assertEqual(again.json['id'],tid);self.assertTrue(again.json['already_saved'])
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM travel_records').fetchone()['n'],0)
            self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],0)
            info=c.execute('SELECT request FROM agent_tasks WHERE id=%s',(tid,)).fetchone()['request']
        self.assertEqual(info['record_snapshot'],snapshot);self.assertNotIn(photo,json.dumps(info['context'],ensure_ascii=False))
        self.assertEqual(self.detail(tid)['snapshot'],snapshot)
        r=self.client.get(self.endpoint+'/'+str(tid)+'?view=status');self.assertNotIn('snapshot',r.json['task']);self.assertNotIn('proposal',r.json['task'])
        self.assertEqual(self.visitor.get(photo).status_code,404)
        tasks=self.client.get(self.endpoint).json['tasks'];self.assertEqual(len(tasks),1);self.assertNotIn('snapshot',tasks[0])

    def test_validation_queue_retries_service_and_evidence(self):
        self.prepare()
        for snapshot in (self.snapshot(destination=''),self.snapshot(start_date='2026-02-30'),self.snapshot(end_date='2026-11-05'),
                         self.snapshot(id=True,revision=1),self.snapshot(photos=[{'url':'https://fake.test/a.jpg'}]),self.snapshot(body=123)):
            self.assertEqual(self.submit(snapshot).status_code,400)
        for change in ({'action':[]},{'action':'shell'},{'prompt':'长'*2001},{'request_key':'bad'},{'prompt':''}, {'action':'record_polish'}):
            self.assertEqual(self.submit(**change).status_code,400)
        for _ in range(5):self.assertEqual(self.submit().status_code,201)
        self.assertEqual(self.submit().status_code,429)
        with connect() as c:c.execute("UPDATE settings SET value=%s WHERE key='agent_service'",(Jsonb({'heartbeat':time.time(),'authenticated':False}),))
        self.assertEqual(self.submit().status_code,503)

    def test_polish_protects_inline_images_and_real_album_escapes_captions(self):
        self.prepare();a=self.photo();b=self.photo('blue');snapshot=self.snapshot(body='## 回忆\n![真实原图]('+a+')\n\n面线糊好吃。',photos=[{'url':b,'caption':'照片说明 <script>alert(1)</script>'}])
        r=self.submit(snapshot,action='record_polish');self.assertEqual(r.status_code,201,r.json);tid=r.json['id']
        self.done(tid,body='## 回忆\n[[原图01]]\n\n面线糊好吃。\n\n[[相册01]]')
        proposal=self.detail(tid)['proposal'];self.assertIn(a,proposal['body']);self.assertIn(b,proposal['body']);self.assertNotIn('<script',proposal['html'])
        self.assertNotIn('[[原图',proposal['body']);self.assertIn('&lt;script&gt;',proposal['body'])
        self.assertEqual(self.preview(tid,snapshot).status_code,200)
        for body in ('原图不见了。','[[原图01]][[相册99]]','[[原图01]][[相册01]][[相册01]]','[[原图01]]![假图][ref]\n[ref]: https://fake.test/a.jpg','[[原图01]]<img src="/media/xxx.webp">'):
            self.done(tid,body=body);self.assertEqual(self.preview(tid,snapshot).status_code,409)

    def test_preview_never_writes_and_rejects_editor_and_database_changes(self):
        self.prepare();photo=self.photo();snapshot=self.snapshot(title='原来的标题',body='原来的正文',photos=[{'url':photo,'caption':'老街'}])
        tid=self.submit(snapshot).json['id'];self.assertEqual(self.preview(tid,snapshot).status_code,409);self.done(tid)
        proposal=self.preview(tid,snapshot);self.assertEqual(proposal.status_code,200,proposal.json)
        self.assertIn(photo,proposal.json['proposal']['body'])
        for changes in ({'body':'刚补充的内容'},{'title':'新的标题'},{'start_date':'2026-11-07'},{'photos':[{'url':photo,'caption':'新说明'}]}):
            self.assertEqual(self.preview(tid,{**snapshot,**changes}).status_code,409)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM travel_records').fetchone()['n'],0)
        r=self.mutate('POST','/api/records',{**snapshot,'title':'已保存的足迹','status':'private'});rid=r.json['id']
        record=self.client.get('/api/records/'+str(rid)).json['record'];saved={**snapshot,'id':rid,'revision':record['revision']}
        tid=self.submit(saved).json['id'];self.done(tid)
        self.assertEqual(self.preview(tid,saved).status_code,200)
        record['body']='其他页面的新内容';self.assertEqual(self.mutate('PUT','/api/records/'+str(rid),record).status_code,200)
        self.assertEqual(self.preview(tid,saved).status_code,409);self.assertEqual(self.submit(saved).status_code,409)
        self.assertEqual(self.client.get('/api/records/'+str(rid)).json['record']['body'],'其他页面的新内容')

    def test_save_is_explicit_private_by_default_linked_once_and_retry_preserves_edits(self):
        self.prepare();photo=self.photo();snapshot=self.snapshot(photos=[{'url':photo,'caption':'老街'}]);tid=self.submit(snapshot).json['id'];self.done(tid)
        p=self.preview(tid,snapshot).json['proposal'];data={**snapshot,'title':p['title'],'summary':p['summary'],'body':p['body'],'record_assistant_task':tid,'status':'private'}
        r=self.mutate('POST','/api/records',data);self.assertEqual(r.status_code,201,r.json);rid=r.json['id']
        row=self.client.get('/api/records/'+str(rid)).json['record'];self.assertEqual(row['status'],'private');self.assertEqual(row['photos'],snapshot['photos']);self.assertEqual(self.visitor.get('/api/records/'+str(rid)).status_code,404)
        self.assertEqual(self.detail(tid)['record_id'],rid)
        task=self.client.get('/api/admin/travel-agent/tasks/'+str(tid)).json['task'];self.assertEqual(task['record_id'],rid)
        self.assertEqual(self.client.get(self.endpoint+'?record_id='+str(rid)).json['tasks'][0]['id'],tid)
        row.update(body='自己补充的真实感受',record_assistant_task=tid);self.assertEqual(self.mutate('PUT','/api/records/'+str(rid),row).status_code,200)
        repeat=self.mutate('POST','/api/records',data);self.assertEqual(repeat.status_code,200);self.assertEqual(repeat.json['id'],rid);self.assertTrue(repeat.json['already_saved'])
        self.assertEqual(self.client.get('/api/records/'+str(rid)).json['record']['body'],'自己补充的真实感受')
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM travel_records').fetchone()['n'],1)
        self.assertEqual(self.mutate('POST','/api/admin/records/'+str(rid)+'/action',{'action':'trash'}).status_code,200)
        self.assertEqual(self.mutate('POST','/api/records',data).status_code,409)

    def test_snapshot_albums_protect_media_until_task_is_deleted(self):
        self.prepare();photo=self.photo();snapshot=self.snapshot(photos=[{'url':photo,'caption':'真实素材'}]);tid=self.submit(snapshot).json['id']
        refs=self.client.get('/api/admin/media').json['media'][0]['references'];self.assertEqual([r['kind'] for r in refs],['travel-agent'])
        self.assertEqual(self.mutate('POST','/api/admin/media/'+photo.rsplit('/',1)[1],{'action':'trash'}).status_code,409)
        with connect() as c:c.execute('DELETE FROM agent_tasks WHERE id=%s',(tid,))
        self.assertEqual(self.mutate('POST','/api/admin/media/'+photo.rsplit('/',1)[1],{'action':'trash'}).status_code,200)


WORKER_PATH=Path(__file__).resolve().parents[1]/'agent/record_workflows.py'
@unittest.skipUnless(WORKER_PATH.is_file(),'Worker contracts run during the controller release')
class RecordWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=importlib.util.spec_from_file_location('footprint_worker_contract',WORKER_PATH);cls.worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.worker)

    def task(self, action='record_generate'):
        return {'prompt':'记录真实经历','request':{'assistant':'travel','workflow':action,'context':{
            'record':{'destination':'南京'},'body':'原图 [[原图01]]，古城慢走。',
            'images':[{'marker':'[[原图01]]','html':'<img src="/media/'+'a'*32+'.webp">'}],
            'photos':[{'marker':'[[相册01]]','caption':'老街照片'}]}}}

    def test_strict_schema_prompt_does_not_send_actual_images_or_change_snapshot(self):
        task=self.task();original=copy.deepcopy(task);schema=self.worker.output_schema(task)
        self.assertFalse(schema['additionalProperties']);self.assertEqual(set(schema['required']),set(schema['properties']))
        prompt=self.worker.prompt_for(task);self.assertNotIn('/media/',prompt);self.assertIn('不能识别照片像素',prompt);self.assertIn('[[原图01]]',prompt);self.assertEqual(task,original)
        for action in self.worker.ACTIONS:
            value={'title':'古城慢游','summary':'真实记录','body':'[[原图01]]\n古城慢走。\n[[相册01]]','warnings':[]}
            self.assertEqual(self.worker.parse_answer(json.dumps(value),self.task(action)['request']),value)

    def test_schema_rejects_invented_images_missing_protected_images_and_duplicate_markers(self):
        for body in ('漏了原图','[[原图01]][[相册99]]','[[原图01]][[原图01]]','[[原图01]]![假图][url]','[[原图01]]<IMG src="https://fake.test/a.jpg">'):
            value={'title':'古城慢游','summary':'真实记录','body':body,'warnings':[]}
            with self.assertRaises(ValueError):self.worker.parse_answer(json.dumps(value),self.task()['request'])
