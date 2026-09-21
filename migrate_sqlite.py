"""One-time migration into an empty PostgreSQL database. Never changes SQLite."""
import argparse
import json
import os
import sqlite3
from pathlib import Path
from PIL import Image
from psycopg.types.json import Jsonb
from database import connect, initialize


def migrate(source, uploads, password_hash, dsn=None):
    initialize(dsn)
    old = sqlite3.connect(f'file:{Path(source).resolve()}?mode=ro', uri=True)
    old.row_factory = sqlite3.Row
    rows = [dict(row) for row in old.execute('SELECT * FROM guides ORDER BY id')]
    old.close()
    with connect(dsn) as conn:
        conn.execute('LOCK TABLE guides,admins IN ACCESS EXCLUSIVE MODE')
        if conn.execute('SELECT count(*) AS n FROM guides').fetchone()['n'] or conn.execute('SELECT count(*) AS n FROM admins').fetchone()['n']:
            raise RuntimeError('Destination is not empty; migration cancelled.')
        conn.execute('INSERT INTO admins(username,password_hash) VALUES(%s,%s)', ('admin',password_hash))
        cats={}
        for name in ['国内旅行','海外旅行']:
            cats[name]=conn.execute('INSERT INTO categories(name) VALUES(%s) RETURNING id',(name,)).fetchone()['id']
        for original in rows:
            row=dict(original); row['tags']=Jsonb(json.loads(row['tags'])); row['sample']=bool(row['sample'])
            row['category_id']=cats['国内旅行' if row['country']=='中国' else '海外旅行']
            conn.execute('INSERT INTO guides('+','.join(row)+') VALUES('+','.join('%s' for _ in row)+')',list(row.values()))
            for tag in json.loads(original['tags']):
                conn.execute('INSERT INTO tags(name) VALUES(%s) ON CONFLICT DO NOTHING',(tag,))
        conn.execute("SELECT setval(pg_get_serial_sequence('guides','id'), GREATEST(COALESCE((SELECT max(id) FROM guides),0),1), EXISTS(SELECT 1 FROM guides))")
        count=0
        for path in Path(uploads).glob('*.webp'):
            with Image.open(path) as im:
                conn.execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,%s,%s,%s)',(path.name,path.name,path.stat().st_size,im.width,im.height))
                count+=1
        # Verify all original guide fields before committing; retain IDs and timestamps.
        for original in rows:
            new=conn.execute('SELECT * FROM guides WHERE id=%s',(original['id'],)).fetchone()
            for key,value in original.items():
                actual=new[key]
                if key=='tags': value=json.loads(value)
                if key=='sample': value=bool(value)
                if key in ('created_at','updated_at','deleted_at') and value:
                    from datetime import datetime
                    value=datetime.fromisoformat(value)
                if actual!=value: raise RuntimeError(f'Verification failed for guide {original["id"]}, field {key}')
        conn.execute('INSERT INTO audit_log(actor,action,details) VALUES(%s,%s,%s)',('system','database.migrate',Jsonb({'guides':len(rows),'media':count,'source':'SQLite','destination':'PostgreSQL'})))
    return {'guides':len(rows),'media':count,'verified':True}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--uploads',required=True);a=p.parse_args()
    print(json.dumps(migrate(a.source,a.uploads,os.environ['TRAVEL_ADMIN_HASH']),ensure_ascii=False))
