"""Batched reference results must preserve privacy, trash and assistant links."""
import unittest
from unittest.mock import patch
import test_app as base
from psycopg.types.json import Jsonb

class MediaBatchTests(unittest.TestCase):
    setUp=base.AppTests.setUp
    login=base.AppTests.login

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
