"""Private journey lifecycle, real plan adoption and concurrent-save boundaries."""
import copy
import io
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from threading import Barrier
from unittest.mock import patch
from PIL import Image
from psycopg.types.json import Jsonb
import test_app as base
from database import connect, initialize
from app import app
from test_travel_publication import comparison


def itinerary(destination='南京',days=2):
    return [{'destination':destination,'day':day,'theme':'老城慢游 '+str(day),'stops':[destination+'老街',destination+'博物馆'],
             'transport':'地铁与步行','lunch':'地方小吃','dinner':'家常菜','stay':'老城酒店','pace':'适中',
             'slots':[{'period':period,'plan':destination+'游玩 '+period,'transport':'地铁约 20 分钟',
                       'reservation':'博物馆需提前预约' if period=='上午' else '无需预约'} for period in ('上午','下午','晚上')]}
            for day in range(1,days+1)]


class TripTests(unittest.TestCase):
    setUp=base.AppTests.setUp
    login=base.AppTests.login
    mutate=base.AppTests.mutate
    create_guide=base.AppTests.create

    def new_trip(self,**extra):
        data={'destination':'南京','start_date':'2026-11-06','end_date':'2026-11-07','people':3,**extra}
        response=self.mutate('POST','/api/admin/trips',data)
        self.assertEqual(response.status_code,201,response.json)
        return self.get(response.json['id'])

    def get(self,trip_id):
        response=self.client.get('/api/admin/trips/'+str(trip_id));self.assertEqual(response.status_code,200,response.json)
        return response.json

    def task(self,guide=None):
        guide=guide or {'title':'南京家庭慢游','destination':'南京','country':'中国','days':2,'summary':'轻松出行','budget':'人均参考 1500 元',
                       'season':'秋季','sources':'[资料](https://example.com/)','body':'## 出发准备\n核实开放时间。','itinerary':itinerary()}
        with connect() as c:
            return c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','测试旅行','done',%s,%s) RETURNING id",
                             (Jsonb({'assistant':'travel','trip':{'destination':'南京','days':2,'people':3,'companions':'三位成人','rooms':'两间房'}}),Jsonb({'travel_guide':guide}))).fetchone()['id']

    def adopt(self,trip_id,source,**extra):
        data=self.get(trip_id)
        return self.mutate('POST',f'/api/admin/trips/{trip_id}/plan',{'revision':data['trip']['revision'],'source':source,**extra})

    def test_authentication_csrf_and_private_visibility_for_every_operation(self):
        self.login();data=self.new_trip();tid=data['trip']['id'];self.adopt(tid,{'task_id':self.task()})
        paths=['/api/admin/trips','/api/admin/trips/source?task_id=1',f'/api/admin/trips/{tid}',f'/api/admin/trips/{tid}/plans/1']
        for path in paths:
            self.assertEqual(self.visitor.get(path).status_code,401)
            self.assertEqual(self.client.get(path).headers['Cache-Control'],'no-store')
        for method,path in [('POST','/api/admin/trips'),('PUT',f'/api/admin/trips/{tid}'),('POST',f'/api/admin/trips/{tid}/plan'),
                            ('POST',f'/api/admin/trips/{tid}/checklist'),('POST',f'/api/admin/trips/{tid}/progress')]:
            self.assertEqual(self.visitor.open(path,method=method,json={}).status_code,401)
            self.assertEqual(self.client.open(path,method=method,json={}).status_code,403)
        self.assertNotIn('trips',self.visitor.get('/api/bootstrap').json)
        self.assertNotIn('南京 · 11月06日出发',str(self.visitor.get('/api/bootstrap').json))
        self.assertEqual(self.visitor.get('/api/trips/'+str(tid)).status_code,404)

    def test_creation_defaults_idempotency_and_additive_schema(self):
        self.login();key='a'*32;data=self.new_trip(request_key=key);tid=data['trip']['id']
        self.assertEqual(data['trip']['title'],'南京 · 11月06日出发');self.assertEqual(len(data['trip']['checklist']),6)
        self.assertTrue(all(not item['done'] for item in data['trip']['checklist']))
        again=self.mutate('POST','/api/admin/trips',{'destination':'不覆盖','request_key':key})
        self.assertEqual(again.status_code,200);self.assertEqual(again.json['id'],tid);self.assertTrue(again.json['already_saved'])
        self.assertEqual(self.get(tid)['trip']['destination'],'南京')
        initialize();initialize();self.assertEqual(self.get(tid)['trip']['people'],3)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],1)

    def test_creation_rejects_invalid_dates_types_and_unknown_sources_atomically(self):
        self.login();valid={'destination':'南京','start_date':'2026-11-06','end_date':'2026-11-07','people':3}
        for extra in [{'destination':''},{'start_date':'2026-02-30'},{'end_date':'2026-11-05'},{'end_date':'2026-12-06'},
                      {'people':True},{'people':'3'},{'people':0},{'state':'public'},{'notes':'x'*4001},{'request_key':'bad'},
                      {'source':{}},{'source':{'task_id':True}},{'source':{'task_id':999999}}]:
            response=self.mutate('POST','/api/admin/trips',{**valid,**extra});self.assertIn(response.status_code,(400,404))
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],0)

    def test_source_destination_mismatch_does_not_create_a_partial_trip(self):
        self.login();task=self.task()
        response=self.mutate('POST','/api/admin/trips',{'destination':'泉州','start_date':'2026-11-06','source':{'task_id':task}})
        self.assertEqual(response.status_code,400)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],0)

    def test_task_adoption_is_independent_and_survives_source_deletion(self):
        self.login();task_id=self.task();preview=self.client.get(f'/api/admin/trips/source?task_id={task_id}').json
        self.assertNotIn('reference_body',preview['plan']);self.assertEqual(preview['plan']['days'],2)
        data=self.new_trip(source=preview['source']);tid=data['trip']['id']
        self.assertEqual(data['plan']['version'],1);self.assertEqual(len(data['plan']['snapshot']['itinerary']),2)
        reservations=[i for i in data['trip']['checklist'] if i['kind']=='reservation'];self.assertEqual(len(reservations),2)
        self.assertTrue(all(not item['done'] for item in reservations))
        with connect() as c:c.execute("UPDATE agent_tasks SET report='{}'::jsonb WHERE id=%s",(task_id,))
        self.assertEqual(self.get(tid)['plan']['snapshot']['title'],'南京家庭慢游')
        self.assertEqual(self.mutate('DELETE',f'/api/admin/travel-agent/tasks/{task_id}').status_code,200)
        data=self.get(tid);self.assertIsNone(data['plan']['source_task_id']);self.assertEqual(data['plan']['snapshot']['itinerary'][0]['lunch'],'地方小吃')
        self.assertIn('核实开放时间',self.client.get(f'/api/admin/trips/{tid}/plans/1').json['html'])

    def test_comparison_requires_selection_and_copies_only_selected_candidate(self):
        self.login();guide=comparison();guide['itinerary']=[day for name in ['泉州','景德镇','南京','西双版纳'] for day in itinerary(name)]
        tid=self.task(guide)
        self.assertEqual(self.client.get(f'/api/admin/trips/source?task_id={tid}').status_code,400)
        self.assertEqual(self.client.get(f'/api/admin/trips/source?task_id={tid}&destination=错误').status_code,400)
        preview=self.client.get(f'/api/admin/trips/source?task_id={tid}&destination=南京');self.assertEqual(preview.status_code,200,preview.json)
        data=self.new_trip(source=preview.json['source']);trip_id=data['trip']['id']
        self.assertEqual(data['plan']['snapshot']['destination'],'南京')
        self.assertEqual({d['destination'] for d in data['plan']['snapshot']['itinerary']},{'南京'})
        html=self.client.get(f'/api/admin/trips/{trip_id}/plans/1').json['html']
        for other in ('泉州','景德镇','西双版纳'):self.assertNotIn(other,html)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM guides').fetchone()['n'],0)

    def test_stale_source_or_incomplete_task_cannot_be_adopted(self):
        self.login();task_id=self.task();preview=self.client.get(f'/api/admin/trips/source?task_id={task_id}').json
        with connect() as c:c.execute('UPDATE agent_tasks SET updated_at=now(),status=\'running\' WHERE id=%s',(task_id,))
        response=self.mutate('POST','/api/admin/trips',{'start_date':'2026-11-06','source':preview['source']});self.assertEqual(response.status_code,409)
        with connect() as c:c.execute("UPDATE agent_tasks SET status='done',updated_at=now() WHERE id=%s",(task_id,))
        response=self.mutate('POST','/api/admin/trips',{'start_date':'2026-11-06','source':preview['source']});self.assertEqual(response.status_code,409)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],0)

    def test_existing_guide_adoption_extracts_daily_html_and_keeps_reference(self):
        self.login();body='''<div class="trip-day"><h3>D1 · 老城</h3><div class="trip-route"><span class="trip-stop">1 · 南京老街</span></div><p><strong>怎么走：</strong>地铁</p><div class="trip-table-wrap"><table><tbody><tr><td>上午</td><td>逛老街</td><td>步行</td><td>无需预约</td></tr></tbody></table></div><p><strong>午餐：</strong>鸭血粉丝汤</p></div><div class="trip-day"><h3>D2 · 返程</h3></div>'''
        g=self.create_guide(days=2,body=body)
        data=self.new_trip(source={'guide_id':g['id']});trip_id=data['trip']['id']
        self.assertEqual(data['plan']['snapshot']['itinerary'][0]['stops'],['南京老街'])
        self.assertEqual(data['plan']['snapshot']['itinerary'][0]['lunch'],'鸭血粉丝汤')
        self.assertEqual(data['plan']['snapshot']['itinerary'][0]['slots'][0]['plan'],'逛老街')
        self.mutate('DELETE','/api/guides/'+str(g['id']))
        with connect() as c:c.execute('DELETE FROM guides WHERE id=%s',(g['id'],))
        self.assertIsNone(self.get(trip_id)['plan']['source_guide_id'])
        self.assertIn('逛老街',self.client.get(f'/api/admin/trips/{trip_id}/plans/1').json['html'])

    def test_legacy_reference_does_not_invent_daily_visits(self):
        self.login();guide=self.create_guide(days=2,body='## 收藏资料\n有空看看博物馆。')
        data=self.new_trip(source={'guide_id':guide['id']})
        self.assertTrue(all(not d['stops'] for d in data['plan']['snapshot']['itinerary']))
        self.assertTrue(all(d['theme']=='待安排' for d in data['plan']['snapshot']['itinerary']))

    def test_versions_preserve_bookings_notes_and_unchanged_visit_marks(self):
        self.login();data=self.new_trip(source={'task_id':self.task()});tid=data['trip']['id'];rev=data['trip']['revision']
        saved=self.mutate('PUT',f'/api/admin/trips/{tid}',{'revision':rev,'lodging':'已订酒店','transport':'已买车票'})
        self.assertEqual(saved.status_code,200);rev=saved.json['revision']
        check=data['trip']['checklist'][0]
        result=self.mutate('POST',f'/api/admin/trips/{tid}/checklist',{'revision':rev,'action':'update','id':check['id'],'done':True,'note':'已确认'})
        rev=result.json['revision'];result=self.mutate('POST',f'/api/admin/trips/{tid}/progress',{'revision':rev,'plan_version':1,'day':1,'index':0,'status':'done'})
        self.assertEqual(result.status_code,200);rev=result.json['revision']
        days=copy.deepcopy(data['plan']['snapshot']['itinerary']);days[1]['lunch']='换一家吃'
        saved=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':rev,'itinerary':days});self.assertEqual(saved.status_code,200,saved.json)
        changed=self.get(tid);self.assertEqual(changed['plan']['version'],2);self.assertEqual(changed['plan']['snapshot']['itinerary'][1]['lunch'],'换一家吃')
        self.assertEqual(changed['trip']['lodging'],'已订酒店');self.assertEqual(changed['trip']['transport'],'已买车票')
        item=next(i for i in changed['trip']['checklist'] if i['id']==check['id']);self.assertTrue(item['done']);self.assertEqual(item['note'],'已确认')
        self.assertEqual(changed['trip']['progress']['2:1:0'],'done')
        old=self.client.get(f'/api/admin/trips/{tid}/plans/1').json;self.assertEqual(old['plan']['snapshot']['itinerary'][1]['lunch'],'地方小吃')
        restored=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':changed['trip']['revision'],'restore_version':1});self.assertEqual(restored.status_code,200)
        self.assertEqual(self.get(tid)['plan']['version'],3);self.assertEqual(self.get(tid)['plan']['snapshot']['itinerary'][1]['lunch'],'地方小吃')
        self.assertEqual(self.get(tid)['trip']['lodging'],'已订酒店')

    def test_different_plan_keeps_prior_booking_with_review_label(self):
        self.login();data=self.new_trip(source={'task_id':self.task()});tid=data['trip']['id']
        old=next(c for c in data['trip']['checklist'] if c['kind']=='reservation')
        r=self.mutate('POST',f'/api/admin/trips/{tid}/checklist',{'revision':data['trip']['revision'],'action':'update','id':old['id'],'done':True})
        days=data['plan']['snapshot']['itinerary'];days[0]['slots'][0]['reservation']='剧院演出需预约'
        r=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':r.json['revision'],'itinerary':days});self.assertEqual(r.status_code,200)
        items=self.get(tid)['trip']['checklist'];old=next(c for c in items if c['id']==old['id']);self.assertTrue(old['done']);self.assertEqual(old['plan_version'],1)
        new=next(c for c in items if '剧院' in c['title']);self.assertFalse(new['done']);self.assertEqual(new['plan_version'],2)

    def test_concurrent_metadata_updates_have_one_winner(self):
        self.login();data=self.new_trip();tid=data['trip']['id'];barrier=Barrier(2)
        clients=[app.test_client(),app.test_client()]
        for client in clients:self.login(client)
        def update(pair):
            index,client=pair;token=client.get('/api/session').json['csrf'];barrier.wait()
            return client.put(f'/api/admin/trips/{tid}',json={'revision':1,'notes':'并发 '+str(index)},headers={'X-CSRF-Token':token}).status_code
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(update,enumerate(clients)))
        self.assertEqual(sorted(results),[200,409]);self.assertEqual(self.get(tid)['trip']['revision'],2)

    def test_wrong_revision_or_invalid_plan_never_partially_updates(self):
        self.login();data=self.new_trip(source={'task_id':self.task()});tid=data['trip']['id'];rev=data['trip']['revision']
        for bad in [{'itinerary':[]},{'restore_version':999},{'source':{'guide_id':999}},{'itinerary':[{}]*2}]:
            response=self.mutate('POST',f'/api/admin/trips/{tid}/plan',{'revision':rev,**bad});self.assertIn(response.status_code,(400,404))
        self.assertEqual(self.mutate('PUT',f'/api/admin/trips/{tid}',{'revision':False,'notes':'错误'}).status_code,409)
        self.assertEqual(self.mutate('PUT',f'/api/admin/trips/{tid}',{'revision':rev,'end_date':'2026-11-09'}).status_code,400)
        self.assertEqual(self.get(tid)['trip']['revision'],rev);self.assertEqual(len(self.get(tid)['versions']),1)

    def test_adopt_to_existing_requires_matching_dates_and_keeps_fields(self):
        self.login();data=self.new_trip(lodging='已确认住宿',notes='家庭备忘');tid=data['trip']['id']
        r=self.adopt(tid,{'task_id':self.task()});self.assertEqual(r.status_code,200,r.json)
        current=self.get(tid);self.assertEqual(current['trip']['notes'],'家庭备忘');self.assertEqual(current['trip']['lodging'],'已确认住宿')
        other=self.new_trip(end_date='2026-11-08');r=self.adopt(other['trip']['id'],{'task_id':self.task()});self.assertEqual(r.status_code,400)
        self.assertIsNone(self.get(other['trip']['id'])['plan'])

    def test_checklist_edit_remove_validation_and_stale_save(self):
        self.login();data=self.new_trip();tid=data['trip']['id'];url=f'/api/admin/trips/{tid}/checklist';rev=data['trip']['revision']
        add=self.mutate('POST',url,{'revision':rev,'action':'add','title':'带相机','kind':'packing'});self.assertEqual(add.status_code,200)
        item=add.json['checklist'][-1]
        self.assertEqual(self.mutate('POST',url,{'revision':rev,'action':'remove','id':item['id']}).status_code,409)
        for bad in [{'action':'add','title':''},{'action':'add','title':'测试','kind':'public'},
                    {'action':'update','id':item['id'],'done':'true'},{'action':'remove','id':'unknown'}]:
            self.assertIn(self.mutate('POST',url,{'revision':add.json['revision'],**bad}).status_code,(400,404))
        updated=self.mutate('POST',url,{'revision':add.json['revision'],'action':'update','id':item['id'],'title':'相机和充电器','note':'已充电','done':True})
        self.assertEqual(updated.status_code,200);removed=self.mutate('POST',url,{'revision':updated.json['revision'],'action':'remove','id':item['id']});self.assertEqual(removed.status_code,200)
        self.assertFalse(any(c['id']==item['id'] for c in removed.json['checklist']))

    def test_visit_progress_bounds_and_cross_version_protection(self):
        self.login();data=self.new_trip(source={'task_id':self.task()});tid=data['trip']['id'];url=f'/api/admin/trips/{tid}/progress';rev=data['trip']['revision']
        for bad in [{'day':0},{'index':-1},{'index':2},{'status':'public'},{'plan_version':True}]:
            result=self.mutate('POST',url,{'revision':rev,'plan_version':1,'day':1,'index':0,'status':'done',**bad});self.assertIn(result.status_code,(400,409))
        r=self.mutate('POST',url,{'revision':rev,'plan_version':1,'day':1,'index':0,'status':'skipped'});self.assertEqual(r.status_code,200)
        self.assertEqual(r.json['progress']['1:1:0'],'skipped')
        r=self.mutate('POST',url,{'revision':r.json['revision'],'plan_version':1,'day':1,'index':0,'status':''});self.assertEqual(r.json['progress'],{})

    def test_china_date_phase_focus_archive_and_filter(self):
        self.login();past=self.new_trip(start_date='2026-10-01',end_date='2026-10-02');next_trip=self.new_trip(start_date='2026-10-12',end_date='2026-10-13');active=self.new_trip(start_date='2026-10-10',end_date='2026-10-11')
        with patch('trip_api.today',return_value=date(2026,10,11)):
            page=self.client.get('/api/admin/trips').json;self.assertEqual(page['focus']['id'],active['trip']['id']);self.assertEqual(page['focus']['today_day'],2)
            self.assertEqual(self.client.get('/api/admin/overview').json['trip']['phase'],'travelling')
            r=self.mutate('PUT',f"/api/admin/trips/{active['trip']['id']}",{'revision':1,'state':'archived'});self.assertEqual(r.status_code,200)
            self.assertEqual(self.client.get('/api/admin/trips').json['focus']['id'],next_trip['trip']['id'])
            self.assertEqual(self.client.get('/api/admin/trips?state=archived').json['total'],1)
            self.assertEqual(self.get(past['trip']['id'])['trip']['phase'],'completed')
        for query in ('page=0','page=bad','page=999999999','state=public','q='+('x'*121)):
            self.assertEqual(self.client.get('/api/admin/trips?'+query).status_code,400)

    def test_export_keeps_private_journeys_and_version_history(self):
        self.login();data=self.new_trip(source={'task_id':self.task()},notes='私人家庭备忘')
        response=self.client.get('/api/admin/export',buffered=True);self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['trips'][0]['notes'],'私人家庭备忘');self.assertEqual(response.json['trip_plans'][0]['version'],1)
        self.assertEqual(self.visitor.get('/api/admin/export').status_code,401)

    def test_reference_html_is_sanitized_and_images_remain_in_use(self):
        self.login();image=io.BytesIO();Image.new('RGB',(40,30),'green').save(image,'JPEG');image.seek(0)
        upload=self.client.post('/api/upload',data={'image':(image,'trip.jpg')},headers={'X-CSRF-Token':self.csrf});url=upload.json['url']
        guide={'title':'私人旅行参考','destination':'南京','country':'中国','days':2,'summary':'测试','budget':'待核实','season':'秋季','sources':'',
               'itinerary':itinerary(),'body':'<script>alert(1)</script><img src="'+url+'" onerror="alert(1)"><a href="javascript:alert(1)">链接</a>'}
        task=self.task(guide);data=self.new_trip(source={'task_id':task});tid=data['trip']['id']
        self.mutate('DELETE',f'/api/admin/travel-agent/tasks/{task}')
        response=self.client.get(f'/api/admin/trips/{tid}/plans/1');html=response.json['html'];self.assertNotIn('<script',html);self.assertNotIn('onerror',html);self.assertNotIn('href="javascript:',html)
        self.assertEqual(self.visitor.get(url).status_code,404)
        media=self.client.get('/api/admin/media').json['media'][0];self.assertEqual(media['references'][0]['kind'],'trip')
        delete=self.mutate('POST','/api/admin/media/'+url.split('/')[-1],{'action':'trash'});self.assertEqual(delete.status_code,409)
