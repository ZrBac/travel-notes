"""Real PostgreSQL contention: deletion must serialize with references and saves."""
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from psycopg.types.json import Jsonb
import test_app
from database import connect


class TaskDeleteConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_app.AppTests();self.fixture.setUp();self.fixture.login()
        with connect() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)",
                      (Jsonb({'heartbeat':time.time(),'authenticated':True}),))

    def request(self,method,path,data=None):
        client=test_app.app.test_client()
        client.set_cookie('session',self.fixture.client.get_cookie('session').value)
        return client.open(path,method=method,json=data,headers={'X-CSRF-Token':self.fixture.csrf})

    def waiting(self,pattern):
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            with connect() as c:
                row=c.execute("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE %s",(pattern,)).fetchone()
            if row['n']:return
            time.sleep(.02)
        self.fail('Expected database contention was not reached: '+pattern)

    def seed(self,travel=False):
        guide={'title':'南京文化之旅','destination':'南京','country':'中国','days':4,'summary':'城市漫步','season':'秋季','budget':'参考估算','body':'## 第一天\n游览城市，注意预约。','sources':''}
        with connect() as c:
            return c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','并发删除测试',%s,%s,%s) RETURNING id",
                ('done' if travel else 'ready',Jsonb({'assistant':'travel'} if travel else {}),
                 Jsonb({'travel_guide':guide} if travel else {'artifact':'a'*64,'publishable':True}))).fetchone()['id']

    def race(self,task_id,first,second,first_wait):
        # Keep the parent locked until the first request and then the second are waiting.
        # Running requests use separate Flask clients and separate DB connections.
        with ThreadPoolExecutor(max_workers=2) as pool:
            with connect() as blocker:
                blocker.execute('SELECT id FROM agent_tasks WHERE id=%s FOR UPDATE',(task_id,))
                a=pool.submit(self.request,*first);self.waiting(first_wait)
                b=pool.submit(self.request,*second)
                self.waiting('%pg_advisory_xact_lock%' if first[0]!='DELETE' else '%pg_advisory_xact_lock%')
            return a.result(timeout=5),b.result(timeout=5)

    def test_deletion_and_followup_or_publication_serialize_in_both_orders(self):
        for scope,publication in (('agent',False),('travel-agent',False),('agent',True)):
            for delete_first in (True,False):
                with self.subTest(scope=scope,publication=publication,delete_first=delete_first):
                    parent=self.seed(scope=='travel-agent');path=f'/api/admin/{scope}/tasks/{parent}'
                    delete=('DELETE',path)
                    create=('POST',path+'/publish',{'artifact':'a'*64}) if publication else ('POST',f'/api/admin/{scope}/tasks',{'prompt':'继续修改这份任务','parent_id':parent})
                    first,second=(delete,create) if delete_first else (create,delete)
                    a,b=self.race(parent,first,second,'%FOR UPDATE' if delete_first else 'INSERT INTO agent_tasks%')
                    self.assertEqual((a.status_code,b.status_code),(200,404) if delete_first else (201,409),(a.json,b.json))

    def test_save_and_delete_preserve_archived_guide(self):
        for save_first in (True,False):
            with self.subTest(save_first=save_first):
                parent=self.seed(True);path=f'/api/admin/travel-agent/tasks/{parent}'
                first=('POST',path+'/save',{}) if save_first else ('DELETE',path)
                second=('DELETE',path) if save_first else ('POST',path+'/save',{})
                with ThreadPoolExecutor(max_workers=2) as pool:
                    with connect() as blocker:
                        blocker.execute('SELECT id FROM agent_tasks WHERE id=%s FOR UPDATE',(parent,))
                        a=pool.submit(self.request,*first);self.waiting('%FOR UPDATE')
                        b=pool.submit(self.request,*second)
                        deadline=time.monotonic()+3
                        while time.monotonic()<deadline:
                            with connect() as c:
                                n=c.execute("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE'").fetchone()['n']
                            if n>=2:break
                            time.sleep(.02)
                        else:self.fail('Both requests should wait for the same task row')
                    ar,br=a.result(timeout=5),b.result(timeout=5)
                self.assertEqual((ar.status_code,br.status_code),(201,200) if save_first else (200,404),(ar.json,br.json))
                if save_first:
                    guide=self.fixture.client.get('/api/guides/'+str(ar.json['id']))
                    self.assertEqual(guide.status_code,200);self.assertEqual(guide.json['guide']['status'],'draft')

    def test_backup_guard_blocks_deletion_for_both_assistants(self):
        import fcntl,os
        for scope in ('agent','travel-agent'):
            task_id=self.seed(scope=='travel-agent');path=f'/api/admin/{scope}/tasks/{task_id}'
            with open(os.environ['TRAVEL_WRITE_LOCK'],'rb') as lock:
                fcntl.flock(lock,fcntl.LOCK_EX)
                self.assertEqual(self.request('DELETE',path).status_code,503)
                self.assertEqual(self.fixture.client.get(path).status_code,200)
            self.assertEqual(self.request('DELETE',path).status_code,200)
