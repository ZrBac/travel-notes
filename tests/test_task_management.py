import unittest
from unittest.mock import patch
from psycopg.types.json import Jsonb
import test_app
from database import connect


class TaskManagementTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_app.AppTests();self.fixture.setUp();self.fixture.login();self.client=self.fixture.client

    def seed(self,scope='agent',parent=None,status='done'):
        with connect() as c:
            return c.execute("INSERT INTO agent_tasks(kind,prompt,status,parent_id,request) VALUES('chat','任务管理测试',%s,%s,%s) RETURNING id",(status,parent,Jsonb({'assistant':'travel'} if scope=='travel-agent' else {}))).fetchone()['id']

    def post(self,scope,action,data):return self.fixture.mutate('POST',f'/api/admin/{scope}/tasks/'+action,data)
    def preview(self,scope,ids):return self.post(scope,'delete-preview',{'ids':ids})
    def delete(self,scope,ids,plan):return self.post(scope,'bulk-delete',{'ids':ids,'confirmation':plan['confirmation']})

    def test_branch_preview_and_atomic_delete_both_assistants(self):
        for scope in ('agent','travel-agent'):
            with self.subTest(scope=scope):
                root=self.seed(scope);child=self.seed(scope,root);leaf=self.seed(scope,child);sibling=self.seed(scope,root);keep=self.seed(scope)
                preview=self.preview(scope,[root,child]);self.assertEqual(preview.status_code,200,preview.json)
                plan=preview.json;self.assertEqual(set(plan['ids']),{root,child,leaf,sibling});self.assertEqual(plan['added_count'],2);self.assertTrue(plan['can_delete'])
                self.assertEqual(self.client.get(f'/api/admin/{scope}/tasks/{root}').status_code,200,'preview must not delete')
                response=self.delete(scope,[root,child],plan);self.assertEqual(response.status_code,200,response.json);self.assertEqual(response.json['count'],4)
                self.assertEqual(self.client.get(f'/api/admin/{scope}/tasks/{keep}').status_code,200)
                for task in plan['ids']:self.assertEqual(self.client.get(f'/api/admin/{scope}/tasks/{task}').status_code,404)
                with connect() as c:self.assertEqual(c.execute('SELECT details FROM audit_log WHERE action=%s ORDER BY id DESC LIMIT 1',(('travel_agent' if scope=='travel-agent' else 'agent')+'.bulk_delete',)).fetchone()['details']['ids'],plan['ids'])

    def test_active_descendant_blocks_whole_group(self):
        for scope in ('agent','travel-agent'):
            for status in ('queued','running','testing','publishing'):
                root=self.seed(scope);child=self.seed(scope,root,status);other=self.seed(scope)
                plan=self.preview(scope,[root,other]).json;self.assertFalse(plan['can_delete']);self.assertEqual(plan['blocked_ids'],[child])
                self.assertEqual(self.delete(scope,[root,other],plan).status_code,409)
                with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM agent_tasks WHERE id=ANY(%s)',([root,child,other],)).fetchone()['n'],3)

    def test_new_descendant_or_changed_task_requires_new_confirmation(self):
        for scope in ('agent','travel-agent'):
            root=self.seed(scope);plan=self.preview(scope,[root]).json;child=self.seed(scope,root)
            self.assertEqual(self.delete(scope,[root],plan).status_code,409)
            plan=self.preview(scope,[root]).json
            with connect() as c:c.execute("UPDATE agent_tasks SET status='failed',updated_at=now() WHERE id=%s",(child,))
            self.assertEqual(self.delete(scope,[root],plan).status_code,409)
            plan=self.preview(scope,[root]).json;self.assertEqual(self.delete(scope,[root],plan).status_code,200)

    def test_scope_and_confirmation_cannot_be_changed(self):
        a=self.seed();b=self.seed('travel-agent');plan=self.preview('agent',[a]).json
        self.assertEqual(self.preview('agent',[b]).status_code,404)
        self.assertEqual(self.preview('travel-agent',[a]).status_code,404)
        self.assertEqual(self.delete('travel-agent',[b],plan).status_code,409)
        self.assertEqual(self.post('agent','bulk-delete',{'ids':[a],'confirmation':'forged'}).status_code,409)
        self.assertEqual(self.delete('agent',[self.seed()],plan).status_code,409)
        with self.client.session_transaction() as s:s['version']+=1
        self.assertEqual(self.delete('agent',[a],plan).status_code,401)

    def test_auth_csrf_validation_and_expiry(self):
        task=self.seed();url='/api/admin/agent/tasks/delete-preview'
        self.assertEqual(self.fixture.visitor.post(url,json={'ids':[task]}).status_code,401)
        self.assertEqual(self.client.post(url,json={'ids':[task]}).status_code,403)
        for ids in ([],[True],['1'],[task,task],[-1],list(range(1,102))):self.assertEqual(self.preview('agent',ids).status_code,400)
        self.assertEqual(self.preview('agent',[999999]).status_code,404)
        for token in (None,{},[],17,''):
            self.assertEqual(self.post('agent','bulk-delete',{'ids':[task],'confirmation':token}).status_code,409)
        plan=self.preview('agent',[task]).json
        import time
        with patch('itsdangerous.timed.time.time',return_value=time.time()+601):self.assertEqual(self.delete('agent',[task],plan).status_code,409)

    def test_rollback_and_archives_are_untouched(self):
        guide=self.fixture.create();root=self.seed('travel-agent');child=self.seed('travel-agent',root)
        with connect() as c:c.execute('UPDATE agent_tasks SET request=request || %s WHERE id=%s',(Jsonb({'guide_id':guide['id']}),root))
        plan=self.preview('travel-agent',[root]).json
        from psycopg import Connection
        execute=Connection.execute
        def audit_failure(connection,query,*args,**kwargs):
            if isinstance(query,str) and query.startswith('INSERT INTO audit_log'):raise RuntimeError('simulate audit failure after deletion')
            return execute(connection,query,*args,**kwargs)
        with patch.object(Connection,'execute',audit_failure):
            self.assertEqual(self.delete('travel-agent',[root],plan).status_code,500)
        self.assertEqual(self.client.get(f'/api/admin/travel-agent/tasks/{child}').status_code,200)
        self.assertEqual(self.delete('travel-agent',[root],plan).status_code,200)
        self.assertEqual(self.client.get('/api/guides/'+str(guide['id'])).status_code,200)

    def test_website_history_pagination(self):
        ids=[self.seed() for _ in range(53)]
        data=self.client.get('/api/admin/agent').json;self.assertEqual(len(data['tasks']),50);self.assertEqual(data['next_before'],ids[3])
        older=self.client.get('/api/admin/agent?before='+str(data['next_before'])).json;self.assertEqual([t['id'] for t in older['tasks']],ids[2::-1]);self.assertIsNone(older['next_before'])
        self.assertEqual(self.client.get('/api/admin/agent?before=invalid').status_code,400)

    def test_branch_delete_and_followup_serialize_without_unconfirmed_deletion(self):
        import time
        import test_task_delete_concurrency
        helper=test_task_delete_concurrency.TaskDeleteConcurrencyTests();helper.fixture=self.fixture
        with connect() as c:c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)",(Jsonb({'heartbeat':time.time(),'authenticated':True}),))
        for scope in ('agent','travel-agent'):
            for delete_first in (True,False):
                with self.subTest(scope=scope,delete_first=delete_first):
                    parent=self.seed(scope);plan=self.preview(scope,[parent]).json
                    delete=('POST',f'/api/admin/{scope}/tasks/bulk-delete',{'ids':[parent],'confirmation':plan['confirmation']})
                    create=('POST',f'/api/admin/{scope}/tasks',{'prompt':'继续补充需求','parent_id':parent})
                    first,second=(delete,create) if delete_first else (create,delete)
                    a,b=helper.race(parent,first,second,'%FOR UPDATE%' if delete_first else 'INSERT INTO agent_tasks%')
                    self.assertEqual((a.status_code,b.status_code),(200,404) if delete_first else (201,409),(a.json,b.json))
