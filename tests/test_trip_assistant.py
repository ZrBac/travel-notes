"""Real-trip assistant snapshots, explicit adoption and private photo evidence."""
import copy
import io
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from psycopg.types.json import Jsonb
import test_app as base
from database import connect
import test_trips as trips
itinerary=trips.itinerary


class TripAssistantTests(unittest.TestCase):
    setUp=base.AppTests.setUp
    login=base.AppTests.login
    mutate=base.AppTests.mutate
    new_trip=trips.TripTests.new_trip
    get=trips.TripTests.get
    task=trips.TripTests.task
    adopt=trips.TripTests.adopt

    def setup_trip(self,plan=True):
        self.login()
        with connect() as c:
            c.execute("INSERT INTO settings(key,value) VALUES('agent_service',%s)",(Jsonb({'heartbeat':time.time(),'authenticated':True}),))
        trip=self.new_trip(lodging='已订老城酒店两间双床房',transport='周五高铁 10:30 到达',companions='一家三口',notes='下午留休息时间')
        self.tid=trip['trip']['id'];self.url=f'/api/admin/trips/{self.tid}'
        if plan:self.assertEqual(self.adopt(self.tid,{'task_id':self.task()}).status_code,200)
        return self.get(self.tid)

    def submit(self,action='adjust_day',**extra):
        data={'action':action,'prompt':'下雨了，减少户外活动','revision':self.get(self.tid)['trip']['revision']}
        if action=='adjust_day':data['day']=1
        return self.mutate('POST',self.url+'/assistant',{**data,**extra})

    def done(self,task_id,action='adjust_day',**extra):
        result={'summary':'只修改剩余路线','body':'## 建议\n保留已经发生的安排。','sources':'','warnings':[]}
        if action=='adjust_day':
            day=itinerary()[0];day['stops']=['南京老街','南京博物馆','室内展馆'];day['theme']='下雨慢游';result['day_plan']=day
        elif action=='check_departure':result['checks']=[{'kind':'reservation','title':'核对博物馆预约','note':'官方入口检查时段'},{'kind':'packing','title':'手机、充电器及充电宝','note':'不要重复已有项'}]
        elif action=='recap':result.update(title='南京的真实记忆',body='## 11 月 6 日\n老街很舒服，下午想多休息。')
        else:result['suggestions']=[{'field':'walking','value':'午后安排休息，少连续步行','reason':'随记提到走累了','note_ids':[self.note_id]}]
        result.update(extra)
        with connect() as c:c.execute("UPDATE agent_tasks SET status='done',report=%s,result=%s,updated_at=now() WHERE id=%s",(Jsonb({'workflow_result':result}),result['body'],task_id))
        return result

    def photo(self):
        data=io.BytesIO();Image.new('RGB',(80,60),'green').save(data,'JPEG');data.seek(0)
        response=self.client.post('/api/upload',data={'image':(data,'真实照片.jpeg')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,201,response.json);return response.json['url']

    def note(self,**extra):
        data={'captured_date':'2026-11-06','place':'老街','note':'走累了，喜欢午后多休息','photos':[],'request_key':'a'*32,'revision':self.get(self.tid)['trip']['revision'],**extra}
        response=self.mutate('POST',self.url+'/notes',data);self.assertEqual(response.status_code,201,response.json)
        self.note_id=response.json['id'];return response

    def apply(self,task_id,**extra):
        return self.mutate('POST',self.url+f'/assistant/{task_id}/apply',{'revision':self.get(self.tid)['trip']['revision'],**extra})

    def test_context_is_actual_private_and_attached_planning_forces_actual_conditions(self):
        trip=self.setup_trip();response=self.client.get(self.url+'/assistant-context');context=response.json['context']
        self.assertEqual(response.headers['Cache-Control'],'no-store');self.assertEqual(context['trip']['lodging'],'已订老城酒店两间双床房')
        self.assertEqual(context['plan']['version'],1);self.assertEqual(context['trip']['start_date'],'2026-11-06')
        for path in ('/assistant-context','/notes','/assistant'):
            self.assertEqual(self.visitor.get(self.url+path).status_code,401)
        self.assertEqual(self.client.post(self.url+'/assistant',json={}).status_code,403)
        response=self.mutate('POST','/api/admin/travel-agent/tasks',{'prompt':'继续规划室内方案','attached_trip_id':self.tid,'trip':{'destination':'乱改城市','days':30,'people':9,'dates':'错误日期'}})
        self.assertEqual(response.status_code,201,response.json)
        with connect() as c:info=c.execute('SELECT request FROM agent_tasks WHERE id=%s',(response.json['id'],)).fetchone()['request']
        self.assertEqual(info['trip']['destination'],'南京');self.assertEqual(info['trip']['days'],2);self.assertEqual(info['trip']['people'],3)
        self.assertEqual(info['trip']['dates'],'2026-11-06 至 2026-11-07');self.assertEqual(info['context']['trip']['transport'],trip['trip']['transport'])
        self.mutate('PUT',self.url,{'revision':trip['trip']['revision'],'lodging':'后来修改的酒店'})
        with connect() as c:self.assertEqual(c.execute('SELECT request FROM agent_tasks WHERE id=%s',(response.json['id'],)).fetchone()['request']['context']['trip']['lodging'],trip['trip']['lodging'])

    def test_job_validation_queue_auth_dates_and_submission_idempotency(self):
        trip=self.setup_trip(plan=False)
        for extra in ({'day':True},{'day':3},{'request_key':'bad'},{'revision':0},{'action':'shell'}):
            self.assertIn(self.submit(**extra).status_code,(400,409))
        self.assertEqual(self.submit().status_code,400)
        self.assertEqual(self.submit('recap').status_code,400)
        self.assertEqual(self.submit('preferences').status_code,400)
        self.adopt(self.tid,{'task_id':self.task()})
        with patch('trip_assistant_api.today',return_value=__import__('datetime').date(2026,11,7)):
            self.assertEqual(self.submit().status_code,400)
        first=self.submit(request_key='b'*32);self.assertEqual(first.status_code,201,first.json)
        repeat=self.submit(request_key='b'*32);self.assertEqual(first.json['id'],repeat.json['id']);self.assertTrue(repeat.json['already_saved'])
        self.assertEqual(self.submit('check_departure').status_code,201)
        for _ in range(3):self.assertEqual(self.submit().status_code,201)
        self.assertEqual(self.submit().status_code,429)
        with connect() as c:c.execute("UPDATE settings SET value=%s WHERE key='agent_service'",(Jsonb({'heartbeat':time.time(),'authenticated':False}),))
        self.assertEqual(self.submit().status_code,503)

    def test_day_adjustment_creates_version_preserves_history_and_is_idempotent(self):
        data=self.setup_trip();self.assertEqual(self.mutate('POST',self.url+'/progress',{'revision':data['trip']['revision'],'plan_version':1,'day':1,'index':0,'status':'done'}).status_code,200)
        before=self.get(self.tid);job=self.submit().json['id'];self.done(job)
        response=self.mutate('POST',self.url+'/plan',{'revision':before['trip']['revision'],'assistant_task':job})
        self.assertEqual(response.status_code,200,response.json);after=self.get(self.tid)
        self.assertEqual(after['plan']['version'],2);self.assertEqual(after['plan']['snapshot']['itinerary'][1],before['plan']['snapshot']['itinerary'][1])
        for name in ('start_date','end_date','people','lodging','transport','notes'):self.assertEqual(after['trip'][name],before['trip'][name])
        self.assertEqual(after['trip']['progress']['2:1:0'],'done')
        again=self.mutate('POST',self.url+'/plan',{'revision':before['trip']['revision'],'assistant_task':job});self.assertTrue(again.json['already_saved'])
        self.assertEqual(self.get(self.tid)['plan']['version'],2)
        self.assertEqual(self.mutate('POST',self.url+'/plan',{'revision':after['trip']['revision'],'assistant_task':job,'restore_version':1}).status_code,400)

    def test_adjustment_conflicts_never_overwrite_history_or_newer_data(self):
        data=self.setup_trip();self.mutate('POST',self.url+'/progress',{'revision':data['trip']['revision'],'plan_version':1,'day':1,'index':1,'status':'skipped'})
        job=self.submit().json['id'];result=self.done(job);result['day_plan']['stops']=['篡改已去路线']
        self.done(job,day_plan=result['day_plan'])
        self.assertEqual(self.mutate('POST',self.url+'/plan',{'revision':self.get(self.tid)['trip']['revision'],'assistant_task':job}).status_code,409)
        self.assertEqual(self.get(self.tid)['plan']['version'],1)
        job=self.submit().json['id'];self.done(job);current=self.get(self.tid)
        self.mutate('PUT',self.url,{'revision':current['trip']['revision'],'notes':'新要求：提前返程'})
        response=self.mutate('POST',self.url+'/plan',{'revision':self.get(self.tid)['trip']['revision'],'assistant_task':job})
        self.assertEqual(response.status_code,409);self.assertEqual(self.get(self.tid)['trip']['notes'],'新要求：提前返程')
        self.assertEqual(self.get(self.tid)['plan']['version'],1)

    def test_notes_jpeg_privacy_validation_revision_and_media_references(self):
        self.setup_trip();url=self.photo();first=self.note(photos=[{'url':url,'caption':'老街照片 <script>alert(1)</script>'}]);nid=first.json['id']
        repeat=self.mutate('POST',self.url+'/notes',{'request_key':'a'*32});self.assertTrue(repeat.json['already_saved'])
        row=self.client.get(self.url+'/notes').json['notes'][0];self.assertEqual(row['photos'][0]['url'],url)
        for path in (url,url+'?w=320'):self.assertEqual(self.visitor.get(path).status_code,404)
        self.assertEqual(self.client.get(url,buffered=True).status_code,200)
        for extra in ({'captured_date':'2026-11-05'},{'captured_date':'2026-11-08'},{'photos':[{'url':'https://fake.test/p.jpg'}]},{'note':'','photos':[]}):
            data={'request_key':'d'*32,'captured_date':'2026-11-06','note':'感受','revision':self.get(self.tid)['trip']['revision'],**extra}
            self.assertEqual(self.mutate('POST',self.url+'/notes',data).status_code,400)
        media=self.client.get('/api/admin/media').json['media'][0];self.assertEqual([r['kind'] for r in media['references']],['trip'])
        self.assertEqual(self.mutate('PUT',self.url+f'/notes/{nid}',{'revision':0,'note':'覆盖'}).status_code,409)
        saved=self.mutate('PUT',self.url+f'/notes/{nid}',{'revision':1,'note':'编辑后的真实感受'});self.assertEqual(saved.status_code,200,saved.json)
        job=self.submit('recap').json['id'];self.done(job,'recap')
        self.assertEqual(self.mutate('DELETE',self.url+f'/notes/{nid}',{'revision':1}).status_code,409)
        self.assertEqual(self.mutate('DELETE',self.url+f'/notes/{nid}',{'revision':2}).status_code,200)
        refs=self.client.get('/api/admin/media').json['media'][0]['references'];self.assertEqual([r['kind'] for r in refs],['travel-agent'])
        self.assertEqual(self.client.get(url,buffered=True).status_code,200)
        self.assertEqual(self.apply(job).status_code,409)

    def test_recap_saves_real_album_private_linked_once_and_preserves_edits(self):
        self.setup_trip();url=self.photo();self.note(photos=[{'url':url,'caption':'真实老街'}]);job=self.submit('recap').json['id'];self.done(job,'recap')
        before=self.get(self.tid);response=self.apply(job);self.assertEqual(response.status_code,200,response.json);rid=response.json['record_id']
        record=self.client.get('/api/records/'+str(rid)).json['record'];self.assertEqual(record['status'],'private');self.assertIn(url,record['body']);self.assertIn('真实老街',record['body'])
        self.assertEqual(record['photos'],[{'url':url,'caption':'真实老街'}]);self.assertEqual(self.visitor.get('/api/records/'+str(rid)).status_code,404)
        self.assertEqual(self.client.get(self.url+'/notes').json['records'][0]['id'],rid)
        self.assertEqual(self.get(self.tid)['plan'],before['plan'])
        self.assertEqual(self.apply(job).json['record_id'],rid)
        record.update(body='回来后自己补充的游记');self.assertEqual(self.mutate('PUT','/api/records/'+str(rid),record).status_code,200)
        self.assertTrue(self.apply(job).json['already_saved']);self.assertEqual(self.client.get('/api/records/'+str(rid)).json['record']['body'],'回来后自己补充的游记')
        self.assertEqual(self.mutate('POST',f'/api/admin/records/{rid}/action',{'action':'trash'}).status_code,200)
        self.assertEqual(self.apply(job).status_code,409)

    def test_departure_selected_new_checks_preserve_done_and_do_not_duplicate(self):
        data=self.setup_trip();item=data['trip']['checklist'][0]
        self.mutate('POST',self.url+'/checklist',{'action':'update','id':item['id'],'done':True,'revision':data['trip']['revision']})
        job=self.submit('check_departure').json['id'];self.done(job,'check_departure');before=self.get(self.tid)
        self.assertEqual(self.apply(job,indices=[True]).status_code,400)
        self.assertEqual(self.apply(job,indices=[]).status_code,400)
        response=self.apply(job,indices=[0,0,1]);self.assertEqual(response.status_code,200,response.json)
        checks=self.get(self.tid)['trip']['checklist'];self.assertEqual(len(checks),len(before['trip']['checklist'])+1)
        self.assertTrue(checks[0]['done']);self.assertFalse(checks[-1]['done']);self.assertEqual(checks[-1]['title'],'核对博物馆预约')
        self.assertTrue(self.apply(job,indices=[0]).json['already_saved']);self.assertEqual(self.get(self.tid)['plan']['version'],1)

    def test_preferences_are_confirmed_account_specific_and_preserve_unselected_fields(self):
        self.setup_trip();self.note()
        original={'origin':'上海','food':'少辣','walking':'普通散步'}
        self.assertEqual(self.mutate('PUT','/api/admin/travel-agent/preferences',{'preferences':original}).status_code,200)
        job=self.submit('preferences').json['id'];self.done(job,'preferences')
        self.assertEqual(self.apply(job,fields=['password']).status_code,400)
        response=self.apply(job,fields=['walking']);self.assertEqual(response.status_code,200,response.json)
        prefs=self.client.get('/api/admin/travel-agent/preferences').json['preferences'];self.assertEqual(prefs['origin'],'上海');self.assertEqual(prefs['food'],'少辣');self.assertIn('休息',prefs['walking'])
        job=self.submit('preferences').json['id'];self.done(job,'preferences')
        self.mutate('PUT','/api/admin/travel-agent/preferences',{'preferences':{'origin':'北京','food':'清淡'}})
        self.assertEqual(self.apply(job,fields=['walking']).status_code,409)
        self.assertEqual(self.client.get('/api/admin/travel-agent/preferences').json['preferences']['origin'],'北京')
        with connect() as c:info=c.execute('SELECT request FROM agent_tasks WHERE id=%s',(job,)).fetchone()['request'];info['created_by']=999;c.execute('UPDATE agent_tasks SET request=%s WHERE id=%s',(Jsonb(info),job))
        self.assertEqual(self.apply(job,fields=['walking']).status_code,403)

    def test_history_is_small_single_result_filter_and_pagination_never_send_snapshots(self):
        self.setup_trip();self.note();ids=[]
        for action in ('recap','check_departure','preferences'):
            job=self.submit(action).json['id'];self.done(job,action);ids.append(job)
        response=self.client.get(self.url+'/assistant');self.assertEqual(len(response.json['tasks']),3)
        for job in response.json['tasks']:
            for field in ('html','result','context','report','photos'):self.assertNotIn(field,job)
        detail=self.client.get(self.url+'/assistant?task_id='+str(ids[0]));self.assertEqual(len(detail.json['tasks']),1);self.assertEqual(detail.json['tasks'][0]['id'],ids[0]);self.assertIn('11 月 6 日',detail.json['tasks'][0]['html'])
        self.assertEqual(self.client.get(self.url+'/assistant?task_id=bad').status_code,400)
        self.assertEqual(self.client.get(self.url+'/assistant?task_id=999999').status_code,404)
        self.assertNotIn('context',self.client.get('/api/admin/travel-agent').json['tasks'][0])
        with connect() as c:
            for _ in range(25):c.execute("INSERT INTO trip_notes(trip_id,captured_date,note) VALUES(%s,'2026-11-06','测试随记')",(self.tid,))
        first=self.client.get(self.url+'/notes');self.assertEqual(len(first.json['notes']),20);self.assertEqual(first.json['next_page'],2)
        second=self.client.get(self.url+'/notes?page=2');self.assertEqual(len(second.json['notes']),6);self.assertIsNone(second.json['next_page'])
        self.assertFalse(set(n['id'] for n in first.json['notes'])&set(n['id'] for n in second.json['notes']))

    def test_adjustment_preserves_marked_repeated_names_at_their_actual_positions(self):
        data=self.setup_trip();days=itinerary();days[0]['stops']=['老街','老街','博物馆']
        self.assertEqual(self.mutate('POST',self.url+'/plan',{'revision':data['trip']['revision'],'itinerary':days}).status_code,200)
        data=self.get(self.tid);self.mutate('POST',self.url+'/progress',{'revision':data['trip']['revision'],'plan_version':2,'day':1,'index':1,'status':'done'})
        task=self.submit().json['id'];proposal=copy.deepcopy(days[0]);proposal['stops'].append('室内展馆');self.done(task,day_plan=proposal)
        response=self.mutate('POST',self.url+'/plan',{'revision':self.get(self.tid)['trip']['revision'],'assistant_task':task})
        self.assertEqual(response.status_code,200,response.json);self.assertEqual(self.get(self.tid)['trip']['progress']['3:1:1'],'done')

    def test_reading_planning_or_recap_links_never_transfers_private_note_albums(self):
        self.setup_trip();self.note(photos=[{'url':self.photo(),'caption':'真实照片'}])
        context=self.client.get(self.url+'/assistant-context?view=planning').json['context'];self.assertNotIn('notes',context);self.assertNotIn('preferences',context)
        self.assertEqual(context['trip']['people'],3);self.assertEqual(context['plan']['version'],1);self.assertNotIn('itinerary',context['plan'])
        linked=self.client.get(self.url+'/notes?view=links').json;self.assertEqual(linked['notes'],[])
        self.assertEqual(len(self.client.get(self.url+'/notes').json['notes']),1)
