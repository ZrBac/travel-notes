"""Batched reference results must preserve privacy, trash and assistant links."""
import unittest
from unittest.mock import patch
import test_app as base
from psycopg.types.json import Jsonb

class MediaBatchTests(unittest.TestCase):
    setUp=base.AppTests.setUp
    login=base.AppTests.login
    mutate=base.AppTests.mutate

    def test_all_reference_kinds_duplicates_and_query_bound(self):
        self.login()
        filenames=[str(i).zfill(32)+'.webp' for i in range(1,26)]
        urls=['/media/'+n for n in filenames]
        with base.connect() as c:
            for name in filenames:
                c.execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,100,10,10)',(name,name))
            c.execute("INSERT INTO guides(title,destination,cover,body,status,deleted_at) VALUES('私密归档攻略','测试',%s,%s,'private',now())",(urls[0],urls[0]+' '+urls[1]))
            c.execute("INSERT INTO travel_records(title,destination,start_date,cover,body,photos,status,deleted_at) VALUES('回收站足迹','测试','2026-09-23',%s,%s,%s,'private',now())",(urls[0],urls[1],Jsonb([{'url':urls[0]},{'url':urls[2]}])))
            c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','测试','done',%s,%s)",(Jsonb({'assistant':'travel'}),Jsonb({'travel_guide':{'title':'候选攻略','body':urls[0]+' '+urls[3]}})))
            c.execute("INSERT INTO agent_tasks(kind,prompt,status,report) VALUES('chat','非旅行任务','done',%s)",(Jsonb({'travel_guide':{'body':urls[4]}}),))
        import app as module
        real_db=module.db;queries=[]
        class Counted:
            def __init__(self,connection):self.connection=connection
            def execute(self,sql,*args,**kwargs):queries.append(sql);return self.connection.execute(sql,*args,**kwargs)
        with patch('app.db',side_effect=lambda:Counted(real_db())):
            response=self.client.get('/api/admin/media')
        self.assertEqual(response.status_code,200,response.json)
        self.assertLessEqual(len(queries),5) # user + media + three reference batches
        rows={r['filename']:r for r in response.json['media']}
        self.assertEqual([r['kind'] for r in rows[filenames[0]]['references']],['guide','record','travel-agent'])
        self.assertTrue(rows[filenames[0]]['references'][0]['deleted_at'])
        self.assertTrue(rows[filenames[0]]['references'][1]['deleted_at'])
        self.assertEqual([r['kind'] for r in rows[filenames[1]]['references']],['guide','record'])
        self.assertEqual([r['kind'] for r in rows[filenames[2]]['references']],['record'])
        self.assertEqual([r['kind'] for r in rows[filenames[3]]['references']],['travel-agent'])
        self.assertEqual(rows[filenames[4]]['references'],[])
        self.assertEqual(self.visitor.get('/api/admin/media').status_code,401)
        self.assertEqual(response.headers['Cache-Control'],'no-store')

    def seed_media(self):
        from pathlib import Path
        names=[str(i).zfill(32)+'.webp' for i in range(1,4)]
        with base.connect() as c:
            for name in names:
                c.execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,10,1,1)',(name,'测试图片'))
                (Path(base.TEMP.name)/'uploads'/name).write_bytes(b'kept-file')
        return names

    def test_bulk_delete_restore_keeps_files_and_audits(self):
        from pathlib import Path
        self.login();names=self.seed_media()
        response=self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names[:2]})
        self.assertEqual(response.status_code,200,response.json);self.assertEqual(response.json['count'],2)
        with base.connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM media WHERE deleted_at IS NOT NULL').fetchone()['n'],2)
            self.assertEqual(c.execute("SELECT count(*) n FROM audit_log WHERE action='media.bulk_trash'").fetchone()['n'],1)
        for name in names:self.assertEqual((Path(base.TEMP.name)/'uploads'/name).read_bytes(),b'kept-file')
        self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names[:2]}).json['count'],0)
        restored=self.mutate('POST','/api/admin/media/bulk',{'action':'restore','filenames':names[:2]})
        self.assertEqual(restored.json['count'],2)
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media WHERE deleted_at IS NOT NULL').fetchone()['n'],0)

    def test_bulk_used_image_prevents_partial_deletion(self):
        self.login();names=self.seed_media()
        with base.connect() as c:c.execute("INSERT INTO guides(title,destination,cover,status,deleted_at) VALUES('回收站仍在使用','测试',%s,'private',now())",('/media/'+names[1],))
        response=self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names})
        self.assertEqual(response.status_code,409);self.assertIn('未删除任何图片',response.json['error'])
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media WHERE deleted_at IS NOT NULL').fetchone()['n'],0)

    def test_bulk_auth_csrf_validation_and_missing_images(self):
        names=self.seed_media();payload={'action':'trash','filenames':names}
        self.assertEqual(self.visitor.post('/api/admin/media/bulk',json=payload).status_code,401)
        self.login();self.assertEqual(self.client.post('/api/admin/media/bulk',json=payload).status_code,403)
        for values in [[],[names[0],names[0]],['../bad'],[1],None,names*40]:
            self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':values}).status_code,400)
        self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'purge','filenames':names}).status_code,409)
        self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':[names[0],'f'*32+'.webp']}).status_code,404)
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media WHERE deleted_at IS NOT NULL').fetchone()['n'],0)

    def test_purge_removes_files_variants_metadata_and_cannot_restore(self):
        from pathlib import Path
        import app as module
        from performance import image_variant_path
        self.login();names=self.seed_media();paths=[]
        for name in names[:2]:
            source=Path(base.TEMP.name)/'uploads'/name;paths.append(source)
            for width in (320,480,640,1280):
                cache=image_variant_path(source,width);cache.parent.mkdir(exist_ok=True);cache.write_bytes(b'cached');paths.append(cache)
        self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names[:2]}).status_code,200)
        response=self.mutate('POST','/api/admin/media/bulk',{'action':'purge','filenames':names[:2]})
        self.assertEqual(response.status_code,200,response.json);self.assertEqual(response.json['count'],2);self.assertFalse(response.json['cleanup_pending'])
        for path in paths:self.assertFalse(path.exists(),str(path))
        self.assertTrue((Path(base.TEMP.name)/'uploads'/names[2]).exists())
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],1)
        self.assertEqual(self.mutate('POST','/api/admin/media/bulk',{'action':'restore','filenames':names[:2]}).status_code,404)
        self.assertEqual(list((Path(base.TEMP.name)/'media-purge').iterdir()),[])

    def test_single_purge_protects_used_trash_and_missing_files(self):
        self.login();names=self.seed_media()
        self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names})
        with base.connect() as c:c.execute("INSERT INTO agent_tasks(kind,prompt,status,request,report) VALUES('chat','保留图片','done',%s,%s)",(Jsonb({'assistant':'travel'}),Jsonb({'travel_guide':{'body':'/media/'+names[0]}})))
        self.assertEqual(self.mutate('POST','/api/admin/media/'+names[0],{'action':'purge'}).status_code,409)
        self.assertEqual(self.mutate('POST','/api/admin/media/'+names[1],{'action':'purge'}).status_code,200)
        from pathlib import Path
        (Path(base.TEMP.name)/'uploads'/names[2]).unlink()
        self.assertEqual(self.mutate('POST','/api/admin/media/'+names[2],{'action':'purge'}).status_code,200)

    def test_purge_rolls_back_metadata_and_files_on_database_failure(self):
        from pathlib import Path
        import app as module
        self.login();names=self.seed_media();self.mutate('POST','/api/admin/media/bulk',{'action':'trash','filenames':names})
        with patch('app.audit',side_effect=RuntimeError('simulated audit failure')):
            response=self.mutate('POST','/api/admin/media/bulk',{'action':'purge','filenames':names})
        self.assertEqual(response.status_code,500)
        for name in names:self.assertEqual((Path(base.TEMP.name)/'uploads'/name).read_bytes(),b'kept-file')
        with base.connect() as c:self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],3)
        self.assertEqual(list((Path(base.TEMP.name)/'media-purge').iterdir()),[])
