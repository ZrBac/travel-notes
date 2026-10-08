import unittest
from werkzeug.security import check_password_hash
import test_app
from database import connect

class AdminAccountTests(unittest.TestCase):
 def setUp(self):
  self.fixture=test_app.AppTests();self.fixture.setUp();self.fixture.login();self.client=self.fixture.client
 def create(self,**values):
  data={'username':'second_admin','display_name':'第二位管理员','password':'eight123','confirm_password':'eight123','current_password':'testing-password-123',**values}
  return self.fixture.mutate('POST','/api/admin/accounts',data)
 def test_create_login_existing_session_and_audit_without_secrets(self):
  r=self.create();self.assertEqual(r.status_code,201,r.json);self.assertEqual(r.json['account']['username'],'second_admin')
  listing=self.client.get('/api/admin/accounts');self.assertEqual(listing.headers['Cache-Control'],'no-store');self.assertEqual(len(listing.json['accounts']),2)
  self.assertNotIn('password',listing.get_data(as_text=True));self.assertTrue(self.client.get('/api/session').json['authenticated'])
  with connect() as c:
   saved=c.execute("SELECT * FROM admins WHERE username='second_admin'").fetchone();self.assertTrue(check_password_hash(saved['password_hash'],'eight123'))
   audit=c.execute("SELECT actor,details FROM audit_log WHERE action='account.create'").fetchone();self.assertEqual(audit['actor'],'admin');self.assertEqual(audit['details'],{'username':'second_admin'})
   self.assertEqual(c.execute('SELECT count(*) AS n FROM agent_tasks').fetchone()['n'],0)
  visitor=test_app.app.test_client();self.fixture.login(client=visitor,username='second_admin',password='eight123');self.assertEqual(visitor.get('/api/admin/accounts').status_code,200)
 def test_auth_csrf_reauthentication_and_no_overwrite(self):
  self.assertEqual(self.fixture.visitor.get('/api/admin/accounts').status_code,401)
  self.assertEqual(self.fixture.visitor.post('/api/admin/accounts',json={}).status_code,401)
  self.assertEqual(self.client.post('/api/admin/accounts',json={}).status_code,403)
  self.assertEqual(self.create(current_password='wrongpass').status_code,400)
  self.assertEqual(self.create(username='admin').status_code,409)
  with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM admins').fetchone()['n'],1)
 def test_validation(self):
  for values in ({'username':'ab'},{'username':'<script>'},{'username':[]},{'display_name':''},{'display_name':[]},{'password':'1234567'},{'password':[]},{'confirm_password':'mismatch'},{'current_password':None}):
   with self.subTest(fields=list(values)):self.assertEqual(self.create(**values).status_code,400)
 def test_revoked_creator_session_cannot_add_account(self):
  with connect() as c:c.execute("UPDATE admins SET session_version=session_version+1 WHERE username='admin'")
  self.assertEqual(self.create().status_code,401)

 def remove(self,account_id,**values):
  return self.fixture.mutate('DELETE',f'/api/admin/accounts/{account_id}',{'current_password':'testing-password-123',**values})
 def test_remove_revokes_sessions_preserves_content_and_audits(self):
  target=self.create().json['account']['id'];other=test_app.app.test_client()
  csrf=self.fixture.login(client=other,username='second_admin',password='eight123')
  guide=self.fixture.create(status='private')
  with connect() as c:
   c.execute("INSERT INTO travel_records(title,destination,start_date,body) VALUES('保留足迹','泉州','2026-10-08','手记')")
   c.execute("INSERT INTO media(filename,name,bytes,width,height) VALUES('retained.webp','保留图片',100,10,10)")
   c.execute("INSERT INTO agent_tasks(kind,prompt) VALUES('chat','保留任务')")
   before={table:c.execute('SELECT count(*) AS n FROM '+table).fetchone()['n'] for table in ('guides','travel_records','media','agent_tasks')}
  response=self.remove(target);self.assertEqual(response.status_code,200,response.json)
  self.assertEqual(response.headers['Cache-Control'],'no-store')
  self.assertEqual(other.get('/api/admin/accounts').status_code,401)
  self.assertEqual(other.get('/api/guides/'+str(guide['id'])).status_code,404)
  self.assertEqual(other.post('/api/admin/accounts',json={},headers={'X-CSRF-Token':csrf}).status_code,401)
  self.assertEqual(self.client.get('/api/admin/accounts').status_code,200)
  with connect() as c:
   after={table:c.execute('SELECT count(*) AS n FROM '+table).fetchone()['n'] for table in before};self.assertEqual(before,after)
   event=c.execute("SELECT actor,target,details FROM audit_log WHERE action='account.delete'").fetchone()
   self.assertEqual(event,{'actor':'admin','target':str(target),'details':{'username':'second_admin'}})
  # Reusing a removed username must never reactivate its old cookie.
  stale=test_app.app.test_client();self.fixture.login(client=stale)
  with stale.session_transaction() as session:session['admin_id']=target
  self.assertEqual(self.create().status_code,201)
  self.assertEqual(stale.get('/api/admin/accounts').status_code,401)
 def test_remove_requires_auth_csrf_password_and_other_account(self):
  target=self.create().json['account']['id'];url=f'/api/admin/accounts/{target}'
  self.assertEqual(self.fixture.visitor.delete(url,json={}).status_code,401)
  self.assertEqual(self.client.delete(url,json={}).status_code,403)
  for value in ('',None,[],123,'x'*257,'wrongpass'):
   with self.subTest(value_type=type(value).__name__):self.assertEqual(self.remove(target,current_password=value).status_code,400)
  self.assertEqual(self.remove(1).status_code,400)
  self.assertEqual(self.remove(999999).status_code,404)
  with connect() as c:
   self.assertEqual(c.execute('SELECT count(*) AS n FROM admins').fetchone()['n'],2)
   self.assertEqual(c.execute("SELECT count(*) AS n FROM audit_log WHERE action='account.delete'").fetchone()['n'],0)
  self.assertEqual(self.remove(target).status_code,200)
  self.assertEqual(self.remove(target).status_code,404)
  self.assertEqual(self.remove(1).status_code,400)
  with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM admins').fetchone()['n'],1)
 def test_mutual_removal_keeps_one_account_and_rechecks_waiting_session(self):
  from concurrent.futures import ThreadPoolExecutor
  from threading import Barrier
  from unittest.mock import patch
  import app as module
  target=self.create().json['account']['id'];other=test_app.app.test_client()
  other_csrf=self.fixture.login(client=other,username='second_admin',password='eight123')
  gate=Barrier(2);original=module.locked_admin_account
  def synchronized_lock():
   gate.wait(timeout=5)
   return original()
  def remove(client,account_id,password,csrf):
   return client.delete(f'/api/admin/accounts/{account_id}',json={'current_password':password},headers={'X-CSRF-Token':csrf}).status_code
  with patch('app.locked_admin_account',synchronized_lock),ThreadPoolExecutor(max_workers=2) as pool:
   a=pool.submit(remove,self.client,target,'testing-password-123',self.fixture.csrf)
   b=pool.submit(remove,other,1,'eight123',other_csrf)
   self.assertEqual(sorted([a.result(timeout=10),b.result(timeout=10)]),[200,401])
  with connect() as c:
   self.assertEqual(c.execute('SELECT count(*) AS n FROM admins').fetchone()['n'],1)
   self.assertEqual(c.execute("SELECT count(*) AS n FROM audit_log WHERE action='account.delete'").fetchone()['n'],1)

if __name__=='__main__':unittest.main()
