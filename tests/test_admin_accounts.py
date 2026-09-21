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

if __name__=='__main__':unittest.main()
