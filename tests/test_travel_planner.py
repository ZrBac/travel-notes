import time
import unittest
from psycopg.types.json import Jsonb
import test_app
from database import connect


class TravelPlannerTests(unittest.TestCase):
    def setUp(self):
        self.fixture=test_app.AppTests();self.fixture.setUp();self.client=self.fixture.client
        self.fixture.login()
        with connect() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)",(Jsonb({'heartbeat':time.time(),'authenticated':True}),))
    def post(self,path,data=None): return self.fixture.mutate('POST','/api/admin/travel-agent'+path,data or {})
    def create(self,**extra):
        r=self.post('/tasks',{'prompt':'规划南京四天三晚，9 人各住一间','trip':{'destination':'南京','days':4,'people':9,'rooms':'9 间'},**extra})
        self.assertEqual(r.status_code,201,r.json);return r.json['id']
    def complete(self,task_id):
        guide={'title':'南京文化之旅','destination':'南京','country':'中国','days':4,'summary':'城市漫步','season':'秋季','budget':'参考估算',
               'body':'## 第一天\n游览城市，注意预约。<script>alert(1)</script>\n[危险](javascript:alert(1))','sources':'[文旅资料](https://example.com/)'}
        with connect() as c:c.execute("UPDATE agent_tasks SET status='done',result=%s,report=%s WHERE id=%s",(guide['body'],Jsonb({'travel_guide':guide,'web_search_count':2}),task_id))
        return guide
    def test_private_auth_csrf_and_kind_isolation(self):
        task_id=self.create(kind='change',request={'assistant':'website'})
        for path in ('','/tasks/'+str(task_id)):
            self.assertEqual(self.fixture.visitor.get('/api/admin/travel-agent'+path).status_code,401)
        self.assertEqual(self.client.post('/api/admin/travel-agent/tasks',json={'prompt':'南京旅游'}).status_code,403)
        with connect() as c:
            row=c.execute('SELECT kind,request FROM agent_tasks WHERE id=%s',(task_id,)).fetchone()
            self.assertEqual(row['kind'],'chat');self.assertEqual(row['request']['assistant'],'travel')
        data=self.client.get('/api/admin/travel-agent')
        self.assertEqual(data.headers['Cache-Control'],'no-store');self.assertEqual(len(data.json['tasks']),1)
        self.assertEqual(self.client.get('/api/admin/agent').json['tasks'],[])
        self.assertEqual(self.client.get('/api/admin/agent/tasks/'+str(task_id)).status_code,404)
        for action in ('cancel','publish'):
            self.assertEqual(self.fixture.mutate('POST',f'/api/admin/agent/tasks/{task_id}/{action}',{}).status_code,404)
    def test_followup_context_and_cross_scope_rejected(self):
        first=self.create()
        self.assertEqual(self.post('/tasks',{'prompt':'改成轻松一些','parent_id':first}).status_code,409)
        self.complete(first)
        second=self.post('/tasks',{'prompt':'改成轻松一些','parent_id':first})
        self.assertEqual(second.status_code,201)
        detail=self.client.get('/api/admin/travel-agent/tasks/'+str(second.json['id'])).json['task']
        self.assertEqual(detail['trip']['people'],9);self.assertEqual(detail['trip']['rooms'],'9 间')
        website=self.fixture.mutate('POST','/api/admin/agent/tasks',{'prompt':'只读诊断','kind':'chat'}).json['id']
        self.assertEqual(self.post('/tasks',{'prompt':'错误关联','parent_id':website}).status_code,404)
        self.assertEqual(self.fixture.mutate('POST','/api/admin/agent/tasks',{'prompt':'错误关联','parent_id':first}).status_code,404)
        self.assertEqual(self.post(f'/tasks/{website}/cancel').status_code,404)
    def test_save_is_private_atomic_idempotent_and_requires_completion(self):
        first=self.create()
        self.assertEqual(self.post(f'/tasks/{first}/save').status_code,409)
        guide=self.complete(first)
        saved=self.post(f'/tasks/{first}/save',{'status':'public'})
        self.assertEqual(saved.status_code,201,saved.json);gid=saved.json['id']
        again=self.post(f'/tasks/{first}/save');self.assertEqual(again.status_code,200);self.assertEqual(again.json['id'],gid)
        current=self.client.get('/api/guides/'+str(gid)).json['guide']
        self.assertEqual(current['status'],'draft');self.assertEqual(current['body'],guide['body']);self.assertEqual(current['verified_at'],'')
        self.assertEqual(self.fixture.visitor.get('/api/guides/'+str(gid)).status_code,404)
        self.assertEqual(self.client.get('/api/admin/overview').json['counts']['total'],1)
        self.fixture.mutate('DELETE','/api/guides/'+str(gid))
        self.assertEqual(self.post(f'/tasks/{first}/save').status_code,409)
    def test_rendering_sanitizes_model_content_and_hides_internal_request(self):
        first=self.create();self.complete(first)
        detail=self.client.get('/api/admin/travel-agent/tasks/'+str(first)).json['task']
        self.assertNotIn('<script',detail['html']);self.assertNotIn('href="javascript:',detail['html']);self.assertNotIn('request',detail)
        self.assertEqual(detail['web_search_count'],2)
    def test_validation_queue_limit_and_cancel(self):
        for data in ({'prompt':'x'},{'prompt':'南京攻略','trip':[]},{'prompt':'南京攻略','trip':{'people':True}},
                     {'prompt':'南京攻略','trip':{'days':31}},{'prompt':'南京攻略','trip':{'mode':'deploy'}},{'prompt':'南京攻略','parent_id':True}):
            self.assertEqual(self.post('/tasks',data).status_code,400)
        first=self.create()
        for _ in range(4):self.create()
        self.assertEqual(self.post('/tasks',{'prompt':'排队任务'}).status_code,429)
        self.assertEqual(self.post(f'/tasks/{first}/cancel').status_code,200)
        with connect() as c:self.assertTrue(c.execute('SELECT cancel_requested FROM agent_tasks WHERE id=%s',(first,)).fetchone()['cancel_requested'])
        for before in ('-1','0','invalid','1'*40,'１２'):
            self.assertEqual(self.client.get('/api/admin/travel-agent?before='+before).status_code,400)
    def test_service_unavailable_and_older_tasks(self):
        with connect() as c:c.execute("UPDATE settings SET value=%s WHERE key='agent_service'",(Jsonb({'heartbeat':time.time(),'authenticated':False}),))
        self.assertEqual(self.post('/tasks',{'prompt':'旅行攻略'}).status_code,503)
        with connect() as c:
            c.execute("UPDATE settings SET value=%s WHERE key='agent_service'",(Jsonb({'heartbeat':0,'authenticated':True}),))
            for _ in range(53):c.execute("INSERT INTO agent_tasks(kind,prompt,status,request) VALUES('chat','历史攻略','done',%s)",(Jsonb({'assistant':'travel','trip':{}}),))
        self.assertEqual(self.post('/tasks',{'prompt':'旅行攻略'}).status_code,503)
        page=self.client.get('/api/admin/travel-agent').json;self.assertEqual(len(page['tasks']),50)
        older=self.client.get('/api/admin/travel-agent?before='+str(page['next_before'])).json
        self.assertEqual(len(older['tasks']),3);self.assertIsNone(older['next_before'])

    def test_template_and_separate_queue_capacity(self):
        for _ in range(5):self.create()
        website=self.fixture.mutate('POST','/api/admin/agent/tasks',{'prompt':'网站只读任务','kind':'chat'})
        self.assertEqual(website.status_code,201)
        self.assertEqual(self.post('/tasks',{'prompt':'错误模板','trip':{'template':'unknown'}}).status_code,400)

    def test_export_supports_sixteen_bounded_local_images(self):
        import io
        from PIL import Image
        photo=io.BytesIO();Image.new('RGB',(16,16),'green').save(photo,'JPEG');photo.seek(0)
        upload=self.client.post('/api/upload',data={'image':(photo,'scene.jpg')},headers={'X-CSRF-Token':self.fixture.csrf},content_type='multipart/form-data')
        url=upload.json['url']
        path=test_app.Path(test_app.TEMP.name)/'uploads'/url.rsplit('/',1)[1]
        # Valid WebP with bounded trailing bytes exercises the aggregate byte limit.
        raw=path.read_bytes();path.write_bytes(raw+b'\0'*(490000-len(raw)))
        task=self.create();guide=self.complete(task)
        guide['body']=''.join('<p><img src="'+url+'" alt="scene"></p>' for _ in range(17))
        with connect() as c:c.execute('UPDATE agent_tasks SET report=%s WHERE id=%s',(Jsonb({'travel_guide':guide}),task))
        response=self.client.get(f'/api/admin/travel-agent/tasks/{task}/export',buffered=True)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.data.count(b'data:image/webp;base64,'),16)

    def test_visual_export_embeds_private_photos_and_preserves_cards(self):
        import io
        from PIL import Image
        photo=io.BytesIO();Image.new('RGB',(400,300),'green').save(photo,'JPEG');photo.seek(0)
        upload=self.client.post('/api/upload',data={'image':(photo,'scene.jpg')},headers={'X-CSRF-Token':self.fixture.csrf},content_type='multipart/form-data')
        url=upload.json['url'];first=self.create();guide=self.complete(first)
        guide['body']='<div class="trip-grid"><div class="trip-card"><figure class="trip-photo"><img src="'+url+'" alt="景点"><figcaption>测试作者 / 许可</figcaption></figure><div class="trip-card-copy"><h3>地方菜</h3><p>特色口味</p></div></div></div>'
        guide['cover']=url
        with connect() as c:c.execute('UPDATE agent_tasks SET report=%s WHERE id=%s',(Jsonb({'travel_guide':guide,'photo_count':1}),first))
        detail=self.client.get('/api/admin/travel-agent/tasks/'+str(first)).json['task'];self.assertIn('class="trip-card"',detail['html']);self.assertEqual(detail['photo_count'],1)
        self.assertEqual(self.fixture.visitor.get(url).status_code,404)
        export=self.client.get(f'/api/admin/travel-agent/tasks/{first}/export',buffered=True)
        self.assertEqual(export.status_code,200);self.assertIn(b'data:image/webp;base64,',export.data);self.assertNotIn(b'src="/media/',export.data)
        self.assertIn('attachment',export.headers['Content-Disposition']);self.assertEqual(export.headers['Cache-Control'],'no-store')
        self.assertEqual(self.fixture.visitor.get(f'/api/admin/travel-agent/tasks/{first}/export').status_code,401)
        self.assertEqual(self.fixture.mutate('POST','/api/admin/media/'+url.split('/')[-1],{'action':'trash'}).status_code,409)
        saved=self.post(f'/tasks/{first}/save');self.assertEqual(saved.status_code,201,saved.json)
        archived=self.client.get('/api/guides/'+str(saved.json['id'])).json['guide'];self.assertEqual(archived['cover'],url);self.assertIn('trip-card',archived['html'])

    def test_smart_template_is_automatic_and_old_followups_upgrade(self):
        for value in ('auto','culture','nature','food'):
            task_id=self.create(trip={'template':value,'destination':'南京','days':4,'people':9})
            detail=self.client.get('/api/admin/travel-agent/tasks/'+str(task_id)).json['task']
            self.assertEqual(detail['trip']['template'],'auto')
            self.complete(task_id)
        with connect() as c:c.execute("UPDATE agent_tasks SET request=jsonb_set(request,'{trip,template}',%s) WHERE id=%s",(Jsonb('nature'),task_id))
        next_task=self.post('/tasks',{'prompt':'按照目的地自动融合安排','parent_id':task_id})
        detail=self.client.get('/api/admin/travel-agent/tasks/'+str(next_task.json['id'])).json['task']
        self.assertEqual(detail['trip']['template'],'auto');self.assertEqual(detail['trip']['people'],9)

    def test_route_and_table_classes_are_sanitized_and_kept(self):
        task_id=self.create();guide=self.complete(task_id)
        guide['body']='<div class="trip-day" onclick="alert(1)"><h3>D1</h3><div class="trip-route"><span class="trip-stop">1 · 老街</span><span class="trip-arrow">→</span><span class="trip-stop">2 · 河岸</span></div><div class="trip-table-wrap"><table><thead><tr><th>时段</th></tr></thead><tbody><tr><td>上午</td></tr></tbody></table></div></div>'
        with connect() as c:c.execute('UPDATE agent_tasks SET report=%s WHERE id=%s',(Jsonb({'travel_guide':guide}),task_id))
        html=self.client.get('/api/admin/travel-agent/tasks/'+str(task_id)).json['task']['html']
        self.assertIn('class="trip-stop"',html);self.assertIn('class="trip-table-wrap"',html);self.assertNotIn('onclick',html)
        saved=self.post(f'/tasks/{task_id}/save');self.assertEqual(saved.status_code,201)
        archived=self.client.get('/api/guides/'+str(saved.json['id'])).json['guide']
        self.assertIn('class="trip-route"',archived['html'])

    def test_delete_permissions_scope_active_and_dependencies(self):
        first=self.create();path=f'/api/admin/travel-agent/tasks/{first}'
        self.assertEqual(self.fixture.visitor.delete(path).status_code,401)
        self.assertEqual(self.client.delete(path).status_code,403)
        for status in ('queued','running','testing','publishing'):
            with connect() as c:c.execute('UPDATE agent_tasks SET status=%s WHERE id=%s',(status,first))
            self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        self.complete(first)
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/agent/tasks/{first}').status_code,404)
        website=self.fixture.mutate('POST','/api/admin/agent/tasks',{'prompt':'网站咨询','kind':'chat'}).json['id']
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/travel-agent/tasks/{website}').status_code,404)
        child=self.create(parent_id=first)
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        self.complete(child)
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,409)
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/travel-agent/tasks/{child}').status_code,200)
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,200)
        self.assertEqual(self.fixture.mutate('DELETE',path).status_code,404)
        self.assertEqual(self.client.get(path).status_code,404)
        self.assertEqual(self.client.get(path+'/export').status_code,404)
        self.assertEqual(self.post(f'/tasks/{first}/save').status_code,404)
        self.assertEqual(self.post('/tasks',{'prompt':'继续完善','parent_id':first}).status_code,404)
        self.assertEqual(self.client.get('/api/admin/travel-agent').json['tasks'],[])

    def test_delete_retains_saved_guide_and_media(self):
        import io
        from PIL import Image
        photo=io.BytesIO();Image.new('RGB',(40,30),'green').save(photo,'JPEG');photo.seek(0)
        upload=self.client.post('/api/upload',data={'image':(photo,'scene.jpg')},headers={'X-CSRF-Token':self.fixture.csrf},content_type='multipart/form-data')
        self.assertEqual(upload.status_code,201)
        url=upload.json['url'];task_id=self.create();guide=self.complete(task_id)
        guide['body']+='\n![参考照片]('+url+')'
        with connect() as c:c.execute('UPDATE agent_tasks SET report=%s WHERE id=%s',(Jsonb({'travel_guide':guide}),task_id))
        gid=self.post(f'/tasks/{task_id}/save').json['id']
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/travel-agent/tasks/{task_id}').status_code,200)
        saved=self.client.get('/api/guides/'+str(gid)).json['guide']
        self.assertEqual(saved['status'],'draft');self.assertEqual(saved['body'],guide['body'])
        self.assertEqual(self.client.get(url).status_code,200)
        self.assertEqual(self.fixture.visitor.get(url).status_code,404)
        with connect() as c:
            self.assertEqual(c.execute("SELECT count(*) AS n FROM audit_log WHERE action='travel_agent.delete'").fetchone()['n'],1)

    def test_delete_unsaved_result_releases_only_task_media_reference(self):
        import io
        from PIL import Image
        photo=io.BytesIO();Image.new('RGB',(40,30),'blue').save(photo,'JPEG');photo.seek(0)
        upload=self.client.post('/api/upload',data={'image':(photo,'scene.jpg')},headers={'X-CSRF-Token':self.fixture.csrf},content_type='multipart/form-data')
        self.assertEqual(upload.status_code,201)
        url=upload.json['url'];task_id=self.create();guide=self.complete(task_id)
        guide['body']+='\n![参考照片]('+url+')'
        with connect() as c:c.execute('UPDATE agent_tasks SET report=%s WHERE id=%s',(Jsonb({'travel_guide':guide}),task_id))
        media_path='/api/admin/media/'+url.split('/')[-1]
        self.assertEqual(self.fixture.mutate('POST',media_path,{'action':'trash'}).status_code,409)
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/travel-agent/tasks/{task_id}').status_code,200)
        self.assertEqual(self.client.get(url).status_code,200)
        self.assertEqual(self.fixture.visitor.get(url).status_code,404)
        self.assertEqual(self.fixture.mutate('POST',media_path,{'action':'trash'}).status_code,200)


    def save_family(self, **values):
        return self.fixture.mutate('PUT', '/api/admin/travel-agent/preferences', {'preferences':values})

    def test_family_preferences_persist_privately_across_sessions(self):
        empty=self.client.get('/api/admin/travel-agent/preferences')
        self.assertIsNone(empty.json['updated_at']);self.assertIsNone(empty.json['preferences']['people'])
        response=self.save_family(origin='  家庭偏好测试城市  ',people=3,rooms='一间家庭房',budget='人均 3000 元，不含往返',
                                  companions='两位成人和一位孩子',pace='relaxed',walking='每天少于 6000 步',
                                  transport='公共交通为主',food='不吃花生',preferences='博物馆与美食',excluded='测试目的地')
        self.assertEqual(response.status_code,200,response.json);self.assertEqual(response.headers['Cache-Control'],'no-store')
        saved=response.json;self.assertEqual(saved['preferences']['origin'],'家庭偏好测试城市');self.assertTrue(saved['updated_at'])
        other_session=test_app.app.test_client();self.fixture.login(other_session)
        self.assertEqual(other_session.get('/api/admin/travel-agent/preferences').json,saved)
        self.assertEqual(self.client.get('/api/admin/travel-agent').json['family_preferences'],saved)
        self.assertEqual(self.fixture.visitor.get('/api/admin/travel-agent/preferences').status_code,401)
        self.assertEqual(self.fixture.visitor.put('/api/admin/travel-agent/preferences',json={'preferences':{}}).status_code,401)
        self.assertEqual(self.client.put('/api/admin/travel-agent/preferences',json={'preferences':{}}).status_code,403)
        for client in (self.client,self.fixture.visitor):
            self.assertNotIn('家庭偏好测试城市',client.get('/api/bootstrap').get_data(as_text=True))
        exported=self.client.get('/api/admin/export').get_data(as_text=True)
        self.assertNotIn('travel_family_preferences:',exported);self.assertNotIn('家庭偏好测试城市',exported)

    def test_new_plans_use_family_preferences_and_trip_changes_are_snapshots(self):
        self.assertEqual(self.save_family(origin='上海',people=3,rooms='一间家庭房',pace='relaxed',walking='每天 6000 步以内',food='不吃花生').status_code,200)
        first=self.post('/tasks',{'prompt':'规划南京家庭旅行','trip':{'destination':'南京','dates':'秋季','people':4,'origin':''}})
        self.assertEqual(first.status_code,201,first.json);first_id=first.json['id']
        snapshot=self.client.get(f'/api/admin/travel-agent/tasks/{first_id}').json['task']['trip']
        self.assertEqual(snapshot['people'],4);self.assertEqual(snapshot['origin'],'');self.assertEqual(snapshot['food'],'不吃花生')
        self.assertEqual(snapshot['rooms'],'一间家庭房');self.assertEqual(snapshot['walking'],'每天 6000 步以内')
        self.assertEqual(snapshot['planning_style'],'family');self.assertEqual(snapshot['template'],'auto')
        self.assertEqual(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['people'],3)
        self.complete(first_id)
        self.assertEqual(self.save_family(origin='北京',people=2,pace='active',food='少辣').status_code,200)
        followup=self.post('/tasks',{'prompt':'第二天安排轻松一点','parent_id':first_id})
        self.assertEqual(followup.status_code,201,followup.json)
        current=self.client.get('/api/admin/travel-agent/tasks/'+str(followup.json['id'])).json['task']['trip']
        self.assertEqual(current,snapshot,'changed defaults must not alter an existing trip')
        partial=self.post('/tasks',{'prompt':'改成三天，取消忌口条件','parent_id':first_id,'trip':{'days':3,'food':''}})
        self.assertEqual(partial.status_code,201,partial.json)
        current=self.client.get('/api/admin/travel-agent/tasks/'+str(partial.json['id'])).json['task']['trip']
        self.assertEqual(current['days'],3);self.assertEqual(current['people'],4);self.assertEqual(current['origin'],'');self.assertEqual(current['food'],'')
        new=self.post('/tasks',{'prompt':'规划下一次家庭旅行','trip':{'destination':'泉州'}})
        self.assertEqual(new.status_code,201,new.json)
        next_trip=self.client.get('/api/admin/travel-agent/tasks/'+str(new.json['id'])).json['task']['trip']
        self.assertEqual(next_trip['people'],2);self.assertEqual(next_trip['origin'],'北京');self.assertEqual(next_trip['pace'],'active')
        self.assertEqual(self.client.get(f'/api/admin/travel-agent/tasks/{first_id}').json['task']['trip'],snapshot)

    def test_old_followup_does_not_inherit_current_family_defaults(self):
        first=self.create();self.complete(first)
        self.assertEqual(self.save_family(origin='上海',people=2,companions='两位成人',rooms='一间双床房',food='不吃海鲜').status_code,200)
        followup=self.post('/tasks',{'prompt':'继续原来的九人行程','parent_id':first})
        self.assertEqual(followup.status_code,201,followup.json)
        trip=self.client.get('/api/admin/travel-agent/tasks/'+str(followup.json['id'])).json['task']['trip']
        self.assertEqual(trip['people'],9);self.assertEqual(trip['rooms'],'9 间');self.assertEqual(trip['food'],'');self.assertEqual(trip['companions'],'')

    def test_family_preferences_validation_and_reset(self):
        self.assertEqual(self.save_family(origin='已保存城市',people=3).status_code,200)
        for values in (None,[],{'people':True},{'people':0},{'people':51},{'people':'3'},
                       {'origin':None},{'companions':'x'*301},{'food':'x'*301},
                       {'pace':'fast'},{'pace':[]},{'admin_id':99}):
            response=self.fixture.mutate('PUT','/api/admin/travel-agent/preferences',{'preferences':values})
            self.assertEqual(response.status_code,400,response.json)
        self.assertEqual(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['origin'],'已保存城市')
        self.assertEqual(self.save_family().status_code,200)
        self.assertIsNone(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['people'])
        for trip in ({'pace':'fast'},{'companions':'x'*301},{'walking':False},{'transport':None},{'food':'x'*301}):
            self.assertEqual(self.post('/tasks',{'prompt':'家庭出游规划','trip':trip}).status_code,400)

    def test_family_preferences_are_account_scoped_and_removed_with_account(self):
        self.assertEqual(self.save_family(origin='账号一城市',people=3).status_code,200)
        account=self.fixture.mutate('POST','/api/admin/accounts',{'username':'family_two','display_name':'家庭二',
            'password':'family-pass-8','confirm_password':'family-pass-8','current_password':'testing-password-123'})
        self.assertEqual(account.status_code,201,account.json);account_id=account.json['account']['id']
        other=test_app.app.test_client();token=self.fixture.login(other,password='family-pass-8',username='family_two')
        self.assertEqual(other.get('/api/admin/travel-agent/preferences').json['preferences']['origin'],'')
        saved=other.put('/api/admin/travel-agent/preferences',json={'preferences':{'origin':'账号二城市','people':2}},headers={'X-CSRF-Token':token})
        self.assertEqual(saved.status_code,200,saved.json)
        self.assertEqual(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['origin'],'账号一城市')
        self.assertEqual(other.get('/api/admin/travel-agent/preferences?admin_id=1').json['preferences']['origin'],'账号二城市')
        self.assertEqual(self.fixture.mutate('DELETE',f'/api/admin/accounts/{account_id}',{'current_password':'testing-password-123'}).status_code,200)
        with connect() as c:self.assertIsNone(c.execute('SELECT value FROM settings WHERE key=%s',('travel_family_preferences:'+str(account_id),)).fetchone())
        self.assertEqual(other.get('/api/admin/travel-agent/preferences').status_code,401)
        self.assertEqual(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['origin'],'账号一城市')
