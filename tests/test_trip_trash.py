"""Reversible trip deletion, related material and deleted-trip mutation boundaries."""
import io
import unittest
from PIL import Image
from psycopg.types.json import Jsonb
from database import connect, initialize
import test_trips as trips_fixture


class TripTrashTests(unittest.TestCase):
    setUp = trips_fixture.TripTests.setUp
    login = trips_fixture.TripTests.login
    mutate = trips_fixture.TripTests.mutate
    new_trip = trips_fixture.TripTests.new_trip
    get = trips_fixture.TripTests.get
    task = trips_fixture.TripTests.task

    def trash(self, trip):
        return self.mutate('DELETE', '/api/admin/trips/'+str(trip['id']), {'revision':trip['revision']})

    def test_authentication_csrf_and_stale_delete_restore(self):
        self.login();trip=self.new_trip()['trip'];path='/api/admin/trips/'+str(trip['id'])
        for method, url in [('DELETE',path),('POST',path+'/restore')]:
            self.assertEqual(self.visitor.open(url,method=method,json={'revision':1}).status_code,401)
            self.assertEqual(self.client.open(url,method=method,json={'revision':1}).status_code,403)
        for revision in (None,True,0,99):
            self.assertEqual(self.mutate('DELETE',path,{'revision':revision}).status_code,409)
        self.assertIsNone(self.get(trip['id'])['trip']['deleted_at'])
        deleted=self.trash(trip);self.assertEqual(deleted.status_code,200,deleted.json)
        self.assertEqual(deleted.headers['Cache-Control'],'no-store')
        self.assertEqual(self.mutate('POST',path+'/restore',{'revision':trip['revision']}).status_code,409)
        self.assertEqual(self.client.get('/api/admin/trips?state=trash').json['total'],1)

    def test_delete_hides_focus_and_restore_keeps_original_archive_state(self):
        self.login();trip=self.new_trip()['trip'];tid=trip['id']
        self.assertEqual(self.client.get('/api/admin/trips').json['focus']['id'],tid)
        self.assertEqual(self.trash(trip).status_code,200)
        for state in ('','active','archived'):
            data=self.client.get('/api/admin/trips?state='+state).json
            self.assertEqual(data['total'],0);self.assertIsNone(data['focus'])
        self.assertEqual(self.client.get('/api/admin/trips/'+str(tid)).status_code,404)
        initialize();initialize()
        recycled=self.client.get('/api/admin/trips?state=trash').json['trips'][0]
        self.assertEqual(recycled['phase'],'trash')
        self.assertEqual(self.mutate('POST',f'/api/admin/trips/{tid}/restore',{'revision':recycled['revision']}).status_code,200)
        restored=self.get(tid)['trip'];self.assertEqual(restored['people'],trip['people'])
        self.assertEqual(restored['start_date'],trip['start_date']);self.assertEqual(restored['end_date'],trip['end_date'])
        self.assertEqual(restored['checklist'],trip['checklist']);self.assertIsNone(restored['deleted_at'])
        updated=self.mutate('PUT',f'/api/admin/trips/{tid}',{'revision':restored['revision'],'state':'archived'}).json['trip']
        self.assertEqual(self.trash(updated).status_code,200)
        recycled=self.client.get('/api/admin/trips?state=trash').json['trips'][0]
        self.assertEqual(self.mutate('POST',f'/api/admin/trips/{tid}/restore',{'revision':recycled['revision']}).status_code,200)
        self.assertEqual(self.get(tid)['trip']['state'],'archived')

    def test_related_plans_notes_public_records_and_photo_references_survive(self):
        self.login();task_id=self.task();trip=self.new_trip(source={'task_id':task_id})['trip'];tid=trip['id']
        image=io.BytesIO();Image.new('RGB',(80,60),'green').save(image,'PNG');image.seek(0)
        uploaded=self.client.post('/api/upload',data={'image':(image,'trip.png')},headers={'X-CSRF-Token':self.csrf},content_type='multipart/form-data')
        self.assertEqual(uploaded.status_code,201);url=uploaded.json['url'];filename=url.split('/')[-1]
        record=self.mutate('POST','/api/records',{'title':'独立公开足迹','destination':'南京','start_date':'2026-11-06','status':'public','body':'<p>实际旅行记录</p>'})
        self.assertEqual(record.status_code,201,record.json);rid=record.json['id']
        with connect() as c:
            c.execute('INSERT INTO trip_notes(trip_id,captured_date,note,photos) VALUES(%s,%s,%s,%s)',(tid,'2026-11-06','旅行随记',Jsonb([{'url':url,'caption':'手写说明'}])))
            c.execute('INSERT INTO trip_records(trip_id,record_id) VALUES(%s,%s)',(tid,rid))
            tables=('trip_plans','trip_notes','trip_records','travel_records','media','agent_tasks')
            before={name:c.execute('SELECT * FROM '+name+' ORDER BY 1').fetchall() for name in tables}
        self.assertEqual(self.trash(trip).status_code,200)
        self.assertEqual(self.visitor.get('/api/records/'+str(rid)).status_code,200)
        references=next(m for m in self.client.get('/api/admin/media').json['media'] if m['filename']==filename)['references']
        self.assertTrue(any(r['kind']=='trip' and r['id']==tid and r['deleted_at'] for r in references))
        self.assertEqual(self.mutate('POST','/api/admin/media/'+filename,{'action':'trash'}).status_code,409)
        recycled=self.client.get('/api/admin/trips?state=trash').json['trips'][0]
        self.assertEqual(self.mutate('POST',f'/api/admin/trips/{tid}/restore',{'revision':recycled['revision']}).status_code,200)
        with connect() as c:
            after={name:c.execute('SELECT * FROM '+name+' ORDER BY 1').fetchall() for name in tables}
        self.assertEqual(before,after)
        self.assertEqual(self.get(tid)['plan']['version'],1)
        self.assertEqual(self.client.get(f'/api/admin/trips/{tid}/notes').json['notes'][0]['photos'][0]['caption'],'手写说明')

    def test_deleted_trip_rejects_writes_and_idempotent_replays(self):
        self.login();create_key='a'*32;note_key='b'*32;task_key='c'*32
        trip=self.new_trip(request_key=create_key)['trip'];tid=trip['id'];path=f'/api/admin/trips/{tid}'
        note_data={'request_key':note_key,'revision':trip['revision'],'captured_date':'2026-11-06','note':'真实随记'}
        note=self.mutate('POST',path+'/notes',note_data);self.assertEqual(note.status_code,201);note_id=note.json['id']
        with connect() as c:
            task=c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','复核','done',%s,%s) RETURNING id",
                           (Jsonb({'assistant':'travel','workflow':'check_departure','attached_trip_id':tid,'request_key':task_key,'created_by':1,'applied':{'revision':1}}),Jsonb({'workflow_result':{}}))).fetchone()['id']
            adjusted=c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','调行程','done',%s,%s) RETURNING id",
                           (Jsonb({'assistant':'travel','workflow':'adjust_day','attached_trip_id':tid,'applied':{'revision':1,'version':1}}),Jsonb({'workflow_result':{}}))).fetchone()['id']
        trip=self.get(tid)['trip'];self.assertEqual(self.trash(trip).status_code,200)
        for suffix in ('','/plans/1','/notes','/assistant','/assistant-context','/assistant-context?view=planning'):
            self.assertEqual(self.client.get(path+suffix).status_code,404,path+suffix)
        mutations=[('PUT','',{'revision':trip['revision'],'title':'不能修改'}),
                   ('POST','/checklist',{'revision':trip['revision'],'action':'add','title':'事项'}),
                   ('POST','/progress',{'revision':trip['revision']}),('POST','/plan',{'revision':trip['revision']}),
                   ('POST','/plan',{'revision':trip['revision'],'assistant_task':adjusted}),
                   ('POST','/notes',note_data),('PUT',f'/notes/{note_id}',{'revision':1,'note':'不能修改'}),
                   ('DELETE',f'/notes/{note_id}',{'revision':1}),
                   ('POST','/assistant',{'action':'check_departure','request_key':task_key,'revision':trip['revision']}),
                   ('POST',f'/assistant/{task}/apply',{'revision':trip['revision']})]
        for method,suffix,data in mutations:
            self.assertEqual(self.mutate(method,path+suffix,data).status_code,404,(method,suffix))
        self.assertEqual(self.mutate('POST','/api/admin/trips',{'request_key':create_key}).status_code,409)
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM trips').fetchone()['n'],1)
            self.assertEqual(c.execute('SELECT note FROM trip_notes WHERE id=%s',(note_id,)).fetchone()['note'],'真实随记')


if __name__=='__main__':
    unittest.main()
