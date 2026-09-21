import time
import unittest
from psycopg.types.json import Jsonb
import test_app
from database import connect


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_app.AppTests();self.fixture.setUp();self.client=self.fixture.client
    def login(self):
        self.fixture.login()
        with connect() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)",(Jsonb({'heartbeat':time.time(),'versions':['version-1']}),))
    def mutate(self,path,data):return self.fixture.mutate('POST',path,data)
    def test_auth_csrf_and_private_data(self):
        self.assertEqual(self.client.get('/api/admin/agent').status_code,401)
        self.assertEqual(self.client.get('/api/admin/agent/tasks/1').status_code,401)
        self.login()
        self.assertEqual(self.client.post('/api/admin/agent/tasks',json={'prompt':'测试需求'}).status_code,403)
        response=self.mutate('/api/admin/agent/tasks',{'prompt':'<script>unsafe</script>','kind':'chat'})
        self.assertEqual(response.status_code,201)
        detail=self.client.get('/api/admin/agent/tasks/'+str(response.json['id'])).json['task']
        self.assertNotIn('request',detail);self.assertEqual(detail['status'],'queued')
        self.assertEqual(self.fixture.visitor.get('/api/admin/agent').status_code,401)
    def test_limits_types_followups_and_cancellation(self):
        self.login()
        for data in ({'prompt':'x'},{'prompt':'有效需求','kind':'shell'},{'prompt':'有效需求','parent_id':'1'}):
            self.assertEqual(self.mutate('/api/admin/agent/tasks',data).status_code,400)
        first=self.mutate('/api/admin/agent/tasks',{'prompt':'正常需求','kind':'diagnose'}).json['id']
        self.assertEqual(self.mutate('/api/admin/agent/tasks',{'prompt':'补充需求','parent_id':first}).status_code,409)
        for _ in range(4):self.assertEqual(self.mutate('/api/admin/agent/tasks',{'prompt':'队列需求'}).status_code,201)
        self.assertEqual(self.mutate('/api/admin/agent/tasks',{'prompt':'队列已满'}).status_code,429)
        self.assertEqual(self.mutate(f'/api/admin/agent/tasks/{first}/cancel',{}).status_code,200)
        with connect() as c:self.assertTrue(c.execute('SELECT cancel_requested FROM agent_tasks WHERE id=%s',(first,)).fetchone()['cancel_requested'])
    def test_publish_requires_matching_reviewed_artifact(self):
        self.login()
        first=self.mutate('/api/admin/agent/tasks',{'prompt':'功能需求'}).json['id']
        self.assertEqual(self.mutate(f'/api/admin/agent/tasks/{first}/publish',{'artifact':'a'*64}).status_code,409)
        with connect() as c:c.execute("UPDATE agent_tasks SET status='ready',report=%s WHERE id=%s",(Jsonb({'publishable':True,'artifact':'a'*64}),first))
        self.assertEqual(self.mutate(f'/api/admin/agent/tasks/{first}/publish',{'artifact':'b'*64}).status_code,409)
        self.assertEqual(self.mutate(f'/api/admin/agent/tasks/{first}/publish',{'artifact':'a'*64}).status_code,201)
        self.assertEqual(self.mutate(f'/api/admin/agent/tasks/{first}/publish',{'artifact':'a'*64}).status_code,409)
        for version in ('../../root','missing'):
            self.assertIn(self.mutate('/api/admin/agent/rollback',{'version':version}).status_code,(400,409))
        self.assertEqual(self.mutate('/api/admin/agent/rollback',{'version':'version-1'}).status_code,201)
    def test_offline_stops_new_model_requests(self):
        self.fixture.login()
        self.assertEqual(self.mutate('/api/admin/agent/tasks',{'prompt':'正常需求'}).status_code,503)

    def test_delete_permissions_statuses_and_audit(self):
        self.login()
        task_id=self.mutate('/api/admin/agent/tasks',{'prompt':'可删除记录'}).json['id']
        path=f'/api/admin/agent/tasks/{task_id}'
        self.assertEqual(self.fixture.visitor.delete(path).status_code,401)
        self.assertEqual(self.client.delete(path).status_code,403)
        for status in ('queued','running','testing','publishing'):
            with connect() as c:c.execute('UPDATE agent_tasks SET status=%s WHERE id=%s',(status,task_id))
            self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        for status in ('done','failed','cancelled','ready','published','manual'):
            with connect() as c:
                row=c.execute('INSERT INTO agent_tasks(kind,prompt,status) VALUES(%s,%s,%s) RETURNING id',('chat','历史记录',status)).fetchone()
            deleted=f"/api/admin/agent/tasks/{row['id']}"
            self.assertEqual(self.fixture.mutate('DELETE',deleted).status_code,200)
            self.assertEqual(self.client.get(deleted).status_code,404)
            self.assertEqual(self.fixture.mutate('DELETE',deleted).status_code,404)
            self.assertNotIn(row['id'],[t['id'] for t in self.client.get('/api/admin/agent').json['tasks']])
        with connect() as c:
            self.assertEqual(c.execute("SELECT count(*) AS n FROM audit_log WHERE action='agent.delete'").fetchone()['n'],6)

    def test_delete_preserves_publish_and_followup_dependencies(self):
        self.login()
        parent=self.mutate('/api/admin/agent/tasks',{'prompt':'功能建设'}).json['id']
        with connect() as c:c.execute("UPDATE agent_tasks SET status='ready',report=%s WHERE id=%s",(Jsonb({'publishable':True,'artifact':'a'*64}),parent))
        child=self.mutate(f'/api/admin/agent/tasks/{parent}/publish',{'artifact':'a'*64}).json['id']
        path=f'/api/admin/agent/tasks/{parent}'
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        with connect() as c:c.execute("UPDATE agent_tasks SET status='published' WHERE id=%s",(child,))
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/agent/tasks/{child}').status_code,200)
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,200)
        self.assertEqual(self.mutate(f'{path}/publish',{'artifact':'a'*64}).status_code,404)
        self.assertEqual(self.mutate('/api/admin/agent/tasks',{'prompt':'继续修改','parent_id':parent}).status_code,404)
