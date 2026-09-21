import copy
import os
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from psycopg.types.json import Jsonb
import test_app
from database import connect
from app import app
import test_travel_planner


def comparison():
    names=['泉州','景德镇','南京','西双版纳']
    guide={'title':'四地对比','destination':'、'.join(names),'country':'中国','days':2,'summary':'两天一晚候选','season':'秋季','budget':'估算','sources':'','itinerary':[],'highlights':[],'foods':[]}
    rows=[];days=[];chapters=[];cards={'highlights':[],'foods':[]}
    for name in names:
        for day in (1,2):
            guide['itinerary'].append({'destination':name,'day':day})
            rows.append(f'<tr><th>D{day} · {name}</th><td>{name}路线</td></tr>')
            days.append(f'<div class="trip-day"><h3>D{day} · {name}</h3><div class="trip-route"><span class="trip-stop">{name}老街</span></div><p>午餐：{name}美食</p></div>')
        for field,label in (('highlights','景点'),('foods','美食')):
            guide[field].append({'name':name+'｜'+label,'description':name+'特色介绍'})
            cards[field].append(f'<div class="trip-card"><div class="trip-card-copy"><h3>{name}｜{label}</h3><p>{name}特色介绍</p></div></div>')
        chapters.append(f'## {name}：两日慢游\n\n### 住宿和预算\n\n| 区域｜合计 |\n|---|---|\n| {name}老城｜900元 |\n\n9人各住一间。[{name}资料](https://example.com/{names.index(name)})\n\n### 天气与预约\n\n{name}天气及开放时间待核实。')
    guide['body']='<h2>行程一览</h2><div class="trip-table-wrap"><table><thead><tr><th>天数</th><th>路线</th></tr></thead><tbody>'+''.join(rows)+'</tbody></table></div>\n\n'
    guide['body']+='<h2>景点</h2><div class="trip-grid">'+''.join(cards['highlights'])+'</div>\n\n<h2>每天怎么走</h2>'+''.join(days)+'\n\n<h2>美食</h2><div class="trip-grid">'+''.join(cards['foods'])+'</div>\n\n'+'\n\n'.join(chapters)
    return guide


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.helper=test_travel_planner.TravelPlannerTests();self.helper.setUp();self.fixture=self.helper.fixture;self.client=self.helper.client
        self.task=self.helper.create();self.guide=comparison()
        self.set_report(self.guide)
        self.path=f'/api/admin/travel-agent/tasks/{self.task}'
    def set_report(self,guide):
        with connect() as c:c.execute("UPDATE agent_tasks SET status='done',report=%s WHERE id=%s",(Jsonb({'travel_guide':guide}),self.task))
    def publish(self,**data):return self.fixture.mutate('POST',self.path+'/publish',{'mode':'split','status':'public',**data})
    def test_preview_splits_days_cards_budget_and_sources_without_writing(self):
        response=self.client.get(self.path+'/publication?mode=split');self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        names=['泉州','景德镇','南京','西双版纳']
        for i,g in enumerate(response.json['guides']):
            self.assertEqual(g['destination'],names[i]);self.assertEqual(g['body'].count('class="trip-day"'),2)
            self.assertIn('<td>900元</td>',g['html']);self.assertIn('9人各住一间',g['html'])
            self.assertIn(f'https://example.com/{i}',g['sources'])
            for other in names:
                if other!=names[i]:self.assertNotIn(other,g['body']);self.assertNotIn(other,g['sources'])
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM guides').fetchone()['n'],0)
    def test_publication_auth_validation_scope_and_active(self):
        self.assertEqual(self.fixture.visitor.get(self.path+'/publication?mode=split').status_code,401)
        self.assertEqual(self.fixture.visitor.post(self.path+'/publish').status_code,401)
        self.assertEqual(self.client.post(self.path+'/publish',json={'mode':'split','status':'public'}).status_code,403)
        self.assertEqual(self.publish(mode='invalid').status_code,400)
        self.assertEqual(self.publish(status='private').status_code,400)
        self.assertEqual(self.client.get(self.path+'/publication?mode=invalid').status_code,400)
        with connect() as c:c.execute("UPDATE agent_tasks SET status='running' WHERE id=%s",(self.task,))
        self.assertEqual(self.publish().status_code,409)
        with connect() as c:c.execute("UPDATE agent_tasks SET request='{}'::jsonb WHERE id=%s",(self.task,))
        self.assertEqual(self.publish().status_code,404)
    def test_publication_visible_idempotent_and_does_not_overwrite_edits(self):
        r=self.publish();self.assertEqual(r.status_code,201,r.json);ids=[g['id'] for g in r.json['guides']]
        for gid in ids:self.assertEqual(self.fixture.visitor.get('/api/guides/'+str(gid)).status_code,200)
        with connect() as c:
            c.execute("UPDATE guides SET body='管理员修改',status='private' WHERE id=%s",(ids[0],))
        again=self.publish();self.assertEqual(again.status_code,200);self.assertTrue(again.json['already_saved'])
        self.assertEqual(again.json['guides'][0]['status'],'private')
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) AS n FROM guides').fetchone()['n'],4)
            self.assertEqual(c.execute('SELECT body FROM guides WHERE id=%s',(ids[0],)).fetchone()['body'],'管理员修改')
            self.assertEqual(c.execute("SELECT count(*) AS n FROM audit_log WHERE action='travel_agent.publish'").fetchone()['n'],4)
        self.fixture.mutate('DELETE','/api/guides/'+str(ids[1]));self.assertEqual(self.publish().status_code,409)
    def test_drafts_private_then_delete_task_retains_archives(self):
        r=self.publish(status='draft');self.assertEqual(r.status_code,201,r.json)
        for g in r.json['guides']:self.assertEqual(self.fixture.visitor.get('/api/guides/'+str(g['id'])).status_code,404)
        detail=self.client.get(self.path).json['task'];self.assertEqual(len(detail['publications']['split']),4)
        self.assertEqual(self.fixture.mutate('DELETE',self.path).status_code,200)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM guides').fetchone()['n'],4)
    def test_missing_chapters_and_invalid_media_cannot_partially_publish(self):
        bad=copy.deepcopy(self.guide);bad['body']=bad['body'].replace('## 南京：两日慢游','## 未归属章节')
        self.set_report(bad);self.assertEqual(self.publish().status_code,409)
        bad=copy.deepcopy(self.guide);bad['body']=bad['body'].replace('西双版纳特色介绍</p>', '西双版纳特色介绍</p><img src="/media/'+('f'*32)+'.webp">')
        self.set_report(bad);self.assertEqual(self.publish().status_code,400)
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM guides').fetchone()['n'],0)
    def test_single_can_publish_existing_edited_draft(self):
        self.helper.complete(self.task)
        gid=self.helper.post(f'/tasks/{self.task}/save').json['id']
        with connect() as c:c.execute("UPDATE guides SET body='编辑后的正文' WHERE id=%s",(gid,))
        r=self.publish(mode='single');self.assertEqual(r.status_code,201,r.json);self.assertEqual(r.json['guides'][0]['id'],gid)
        g=self.fixture.visitor.get('/api/guides/'+str(gid)).json['guide'];self.assertEqual(g['body'],'编辑后的正文')
        self.assertEqual(self.publish(mode='single').status_code,200)
    def test_parallel_publication_creates_only_four(self):
        with self.client.session_transaction() as s:session_data=dict(s)
        barrier=Barrier(2)
        def submit():
            client=app.test_client()
            with client.session_transaction() as s:s.update(session_data)
            barrier.wait()
            return client.post(self.path+'/publish',json={'mode':'split','status':'public'},headers={'X-CSRF-Token':self.fixture.csrf})
        with ThreadPoolExecutor(2) as pool:responses=list(pool.map(lambda _:submit(),range(2)))
        self.assertEqual(sorted(r.status_code for r in responses),[200,201])
        self.assertEqual(responses[0].json['guides'],responses[1].json['guides'])
        with connect() as c:self.assertEqual(c.execute('SELECT count(*) AS n FROM guides').fetchone()['n'],4)
    def test_existing_draft_must_still_be_valid_to_publish(self):
        self.helper.complete(self.task)
        gid=self.helper.post(f'/tasks/{self.task}/save').json['id']
        with connect() as c:c.execute("UPDATE guides SET body='' WHERE id=%s",(gid,))
        self.assertEqual(self.publish(mode='single').status_code,400)
        with connect() as c:self.assertEqual(c.execute('SELECT status FROM guides WHERE id=%s',(gid,)).fetchone()['status'],'draft')
    def test_backup_lock_blocks_publication(self):
        import fcntl
        with Path(os.environ['TRAVEL_WRITE_LOCK']).open('rb') as guard:
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertEqual(self.publish().status_code,503)
        self.assertEqual(self.publish().status_code,201)
