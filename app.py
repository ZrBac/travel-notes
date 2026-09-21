import functools
import fcntl
import base64
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import bleach
import markdown
import psycopg
from psycopg.types.json import Jsonb
from flask import Flask, Response, abort, g, jsonify, request, send_file, session
from flask.json.provider import DefaultJSONProvider
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.exceptions import HTTPException
from database import connect
from handbooks import HANDBOOK_CSP
from performance import fingerprint, image_variant, lazy_image, page_html
from html_imports import ImportProblem, MAX_UPLOAD, STATIC_HANDBOOK_CSP, parse_upload

BASE = Path(__file__).parent
DATA = Path(os.environ.get('TRAVEL_DATA', '/var/lib/travel-notes'))
WRITE_LOCK = Path(os.environ.get('TRAVEL_WRITE_LOCK','/run/travel-notes-write.lock'))
MAX_IMAGE_UPLOAD = 50 * 1024 * 1024
MAX_JPEG_PIXELS = 80_000_000
(DATA / 'uploads').mkdir(parents=True, exist_ok=True)
app = Flask(__name__, static_folder='static')
app.config.update(SECRET_KEY=os.environ['TRAVEL_SECRET'], MAX_CONTENT_LENGTH=10*1024*1024,
    SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.environ.get('TRAVEL_HTTPS')=='1',
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12))

class ISOJSON(DefaultJSONProvider):
    @staticmethod
    def default(value):
        if isinstance(value, (datetime, date)): return value.isoformat()
        return DefaultJSONProvider.default(value)
app.json = ISOJSON(app)


def db():
    if 'db' not in g: g.db = connect()
    return g.db

@app.teardown_appcontext
def close_db(_error):
    connection = g.pop('db', None)
    if connection: connection.close()
    write_lock = g.pop('write_lock', None)
    if write_lock: write_lock.close()

def now(): return datetime.now(timezone.utc)
def ip(): return request.headers.get('X-Real-IP', request.remote_addr or '')[:100]
def payload():
    value=request.get_json(silent=True)
    if not isinstance(value,dict): abort(400,description='请求内容需要是 JSON 对象')
    return value

def user():
    if 'user' not in g:
        g.user=None
        if session.get('admin_id'):
            row=db().execute('SELECT * FROM admins WHERE id=%s',(session['admin_id'],)).fetchone()
            if row and row['session_version']==session.get('version'): g.user=row
            else: session.clear()
    return g.user

def require_admin():
    if not user(): abort(401,description='请登录管理后台')

def admin_required(fn):
    @functools.wraps(fn)
    def wrapped(*args,**kwargs):
        require_admin()
        return fn(*args,**kwargs)
    return wrapped

@app.before_request
def protect_changes():
    if request.path.startswith('/api/') and request.method not in ('GET','HEAD','OPTIONS'):
        try:
            guard=WRITE_LOCK.open('rb')
        except FileNotFoundError:
            abort(503,description='写入保护尚未就绪，请稍后重试')
        try:
            fcntl.flock(guard,fcntl.LOCK_SH|fcntl.LOCK_NB)
        except BlockingIOError:
            guard.close()
            abort(503,description='正在备份，浏览不受影响，请稍后重新保存')
        g.write_lock=guard
    if request.path.startswith('/api/admin'): require_admin()
    if request.path.startswith('/api/') and request.method not in ('GET','HEAD','OPTIONS'):
        user()
        expected=session.get('csrf','');provided=request.headers.get('X-CSRF-Token','')
        if not expected or not secrets.compare_digest(expected,provided): abort(403,description='页面会话已过期，请刷新后重试')

@app.after_request
def headers(response):
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Referrer-Policy']='same-origin'
    response.headers.setdefault('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
    if request.path.startswith(('/api/','/admin')): response.headers['Cache-Control']='no-store'
    elif request.path.startswith('/media/'):
        response.headers['Cache-Control']='private, no-cache' if response.status_code in (200,304) else 'no-store'
    elif request.path.startswith('/static/') and response.status_code in (200,304):
        if request.path.startswith('/static/optimized/'):
            response.headers['Cache-Control']='public, max-age=31536000, immutable'
        else:
            path=BASE/request.path.lstrip('/')
            versioned=request.args.get('v') and path.is_file() and request.args['v']==fingerprint(path)
            response.headers['Cache-Control']='public, max-age=31536000, immutable' if versioned else 'public, no-cache'
    return response

@app.errorhandler(HTTPException)
def http_error(error):
    if request.path.startswith(('/api/','/media/')): return jsonify(error=error.description),error.code
    return error

@app.errorhandler(psycopg.IntegrityError)
def integrity_error(error):
    db().rollback()
    return jsonify(error='名称已存在或数据有关联，请检查后重试'),409

@app.get('/')
def index(): return Response(page_html('index.html'),mimetype='text/html',headers={'Cache-Control':'no-cache'})

@app.get('/api/health')
def health():
    try:
        connection=db()
        connection.execute("SET LOCAL statement_timeout='2000ms'")
        connection.execute('SELECT id FROM guides LIMIT 1')
        return jsonify(ok=True)
    except psycopg.Error:
        return jsonify(ok=False),503

@app.get('/admin')
@app.get('/admin/')
def admin_index(): return Response(page_html('admin.html'),mimetype='text/html',headers={'Cache-Control':'no-store'})

@app.get('/api/session')
def get_session():
    account=user()
    if 'csrf' not in session: session['csrf']=secrets.token_urlsafe(32)
    return jsonify(authenticated=bool(account),csrf=session['csrf'],user={k:account[k] for k in ('id','username','display_name','last_login')} if account else None)

def audit(action,target='',details=None):
    account=user()
    db().execute('INSERT INTO audit_log(actor,action,target,details,ip) VALUES(%s,%s,%s,%s,%s)',
        (account['username'] if account else 'anonymous',action,str(target),Jsonb(details or {}),ip()))

@app.post('/api/login')
def login():
    data=payload();username=data.get('username','');password=data.get('password','')
    if not isinstance(username,str) or not isinstance(password,str) or len(username)>80 or len(password)>256: abort(400,description='账号或密码格式不正确')
    username=username.strip()
    conn=db()
    conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('login:'+ip(),))
    conn.execute('DELETE FROM login_attempts WHERE created < %s',(time.time()-900,))
    count=conn.execute('SELECT count(*) AS n FROM login_attempts WHERE ip=%s',(ip(),)).fetchone()['n']
    if count>=8:
        conn.commit();abort(429,description='尝试次数过多，请 15 分钟后再试')
    account=conn.execute('SELECT * FROM admins WHERE username=%s',(username,)).fetchone()
    if not account or not check_password_hash(account['password_hash'],password):
        conn.execute('INSERT INTO login_attempts(ip,created) VALUES(%s,%s)',(ip(),time.time()))
        conn.commit();abort(401,description='账号或密码不正确')
    conn.execute('DELETE FROM login_attempts WHERE ip=%s',(ip(),))
    conn.execute('UPDATE admins SET last_login=now() WHERE id=%s',(account['id'],))
    session.clear();session.update(admin_id=account['id'],version=account['session_version'],csrf=secrets.token_urlsafe(32));session.permanent=True
    g.user=account;audit('account.login');conn.commit()
    return jsonify(authenticated=True,csrf=session['csrf'],user={k:account[k] for k in ('id','username','display_name')})

@app.post('/api/logout')
def logout():
    if user(): audit('account.logout');db().commit()
    session.clear();session['csrf']=secrets.token_urlsafe(32)
    return jsonify(authenticated=False,csrf=session['csrf'])

SITE_KEYS=('site_name','tagline','footer','show_samples')
def site_settings():
    return {row['key']:row['value'] for row in db().execute('SELECT key,value FROM settings WHERE key=ANY(%s)',(list(SITE_KEYS),)).fetchall()}
@app.get('/api/site')
def site(): return jsonify(site_settings())

@app.put('/api/admin/settings')
def update_settings():
    data=payload()
    limits={'site_name':20,'tagline':150,'footer':100}
    for key,limit in limits.items():
        if not isinstance(data.get(key),str) or not 1<=len(data[key].strip())<=limit: abort(400,description='请填写有效的站点名称、简介和页脚')
    if not isinstance(data.get('show_samples'),bool): abort(400,description='请选择示例攻略展示状态')
    for key in SITE_KEYS:
        value=data[key].strip() if isinstance(data[key],str) else data[key]
        db().execute('INSERT INTO settings(key,value) VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,Jsonb(value)))
    audit('settings.update',details={'fields':list(SITE_KEYS)});db().commit()
    return jsonify(ok=True)

@app.put('/api/admin/account')
def update_account():
    data=payload();current=data.get('current_password','');new=data.get('new_password','');name=data.get('display_name',user()['display_name'])
    if not isinstance(current,str) or len(current)>256 or not isinstance(new,str) or not isinstance(name,str) or not 1<=len(name.strip())<=40: abort(400,description='账号信息格式不正确')
    account=db().execute('SELECT * FROM admins WHERE id=%s FOR UPDATE',(user()['id'],)).fetchone()
    if account['session_version']!=session.get('version'): abort(401,description='登录信息已更新，请重新登录')
    if not check_password_hash(account['password_hash'],current): abort(400,description='当前密码不正确')
    username=data.get('username',account['username'])
    if not isinstance(username,str) or not re.fullmatch(r'[A-Za-z0-9_]{3,32}',username.strip()): abort(400,description='登录账号需要 3～32 位字母、数字或下划线')
    username=username.strip()
    renamed=username!=account['username']
    if renamed and db().execute('SELECT id FROM admins WHERE username=%s AND id<>%s',(username,account['id'])).fetchone(): abort(409,description='这个登录账号已被使用，请换一个')
    if new and not 8<=len(new)<=256: abort(400,description='新密码需要 8～256 个字符')
    if new and new!=data.get('confirm_password'): abort(400,description='两次新密码不一致')
    if new or renamed:
        db().execute('UPDATE admins SET username=%s,display_name=%s,password_hash=%s,session_version=session_version+1 WHERE id=%s',
            (username,name.strip(),generate_password_hash(new) if new else account['password_hash'],account['id']))
        if renamed: audit('account.username_change',account['id'],{'old_username':account['username'],'new_username':username})
        if new: audit('account.password_change')
        db().commit();session.clear();session['csrf']=secrets.token_urlsafe(32)
        return jsonify(ok=True,reauthenticate=True,csrf=session['csrf'],username=username)
    db().execute('UPDATE admins SET display_name=%s WHERE id=%s',(name.strip(),account['id']))
    audit('account.profile_update');db().commit();return jsonify(ok=True,reauthenticate=False)


def serialize(row,full=False):
    item=dict(row)
    if full: item['html']=render_markdown(item['body'])
    else:
        item.pop('body',None);item.pop('sources',None)
    return item

@functools.lru_cache(maxsize=128)
def render_markdown(body):
    html=bleach.clean(markdown.markdown(body,extensions=['extra','sane_lists']),
        tags={'p','br','h1','h2','h3','h4','strong','em','ul','ol','li','blockquote','a','img','hr','code','pre','table','thead','tbody','tr','td','th','div','figure','figcaption','span'},
        attributes={'div':lambda tag,name,value: name=='class' and value in ('trip-overview','trip-grid','trip-card','trip-card-copy','trip-day','trip-route','trip-table-wrap','trip-meals'),'span':lambda tag,name,value:name=='class' and value in ('trip-arrow','trip-stop'),'figure':lambda tag,name,value:name=='class' and value=='trip-photo','a':['href','title'],'img':['src','alt','title'],'th':['align'],'td':['align']},protocols={'http','https'},strip=True)
    return re.sub(r'<img\b[^>]*>',lazy_image,html)

@app.post('/api/admin/preview')
def preview():
    body=payload().get('body','')
    if not isinstance(body,str) or len(body)>100000: abort(400,description='正文格式不正确')
    return jsonify(html=render_markdown(body))

def guide_row(guide_id,lock=False):
    row=db().execute('SELECT * FROM guides WHERE id=%s'+(' FOR UPDATE' if lock else ''),(guide_id,)).fetchone()
    if not row or (not user() and (row['status']!='public' or row['deleted_at'] or (row['sample'] and not site_settings()['show_samples']))): abort(404,description='这篇攻略不存在或暂未公开')
    return row

@app.get('/api/guides')
def guides():
    trash=request.args.get('trash')=='1'
    if trash: require_admin()
    conditions=['deleted_at IS NOT NULL' if trash else 'deleted_at IS NULL']
    if not user():
        conditions.append("status='public'")
        if not site_settings()['show_samples']: conditions.append('NOT sample')
    rows=db().execute('SELECT * FROM guides WHERE '+' AND '.join(conditions)+' ORDER BY updated_at DESC,id DESC').fetchall()
    return jsonify(guides=[serialize(row) for row in rows])

@app.get('/api/guides/<int:guide_id>')
def detail(guide_id):
    guide=serialize(guide_row(guide_id),True)
    if request.args.get('view')=='read': guide.pop('body',None)
    return jsonify(guide=guide)

@app.get('/api/bootstrap')
def bootstrap():
    account=get_session().get_json()
    recent=record_listing(limit=3)
    return jsonify(site=site_settings(),session=account,guides=guides().get_json()['guides'],records=recent['records'],record_count=recent['total'])

def record_row(record_id,lock=False):
    row=db().execute('SELECT * FROM travel_records WHERE id=%s'+(' FOR UPDATE' if lock else ''),(record_id,)).fetchone()
    if not row or (not user() and (row['status']!='public' or row['deleted_at'])):
        abort(404,description='这篇旅行足迹不存在或暂未公开')
    return row

def serialize_record(row,full=False):
    item=dict(row)
    item['photo_count']=len(item['photos'])
    if not item['guide_id']: item['guide_day']=None
    if full: item['html']=render_markdown(item['body'])
    else:
        item.pop('body',None);item.pop('photos',None);item.pop('guide_id',None);item.pop('guide_day',None)
    return item

def record_listing(limit=12):
    trash=request.args.get('trash')=='1'
    if trash: require_admin()
    conditions=['deleted_at IS NOT NULL' if trash else 'deleted_at IS NULL'];params=[]
    if not user(): conditions.append("status='public'")
    elif request.args.get('status') in ('public','private','draft'):
        conditions.append('status=%s');params.append(request.args['status'])
    q=request.args.get('q','').strip()[:200]
    if q:
        conditions.append('(title ILIKE %s OR destination ILIKE %s OR summary ILIKE %s)');params.extend(['%'+q+'%']*3)
    destination=request.args.get('destination','').strip()[:80]
    if destination:conditions.append('destination=%s');params.append(destination)
    year=request.args.get('year','')
    if re.fullmatch(r'[1-9][0-9]{3}',year):
        conditions.append('extract(year from start_date)=%s');params.append(int(year))
    guide=request.args.get('guide','')
    if guide:
        try: guide=int(guide)
        except ValueError: abort(400,description='攻略编号格式不正确')
        guide_row(guide)
        conditions.append('guide_id=%s');params.append(guide)
    where=' AND '.join(conditions)
    total=db().execute('SELECT count(*) AS n FROM travel_records WHERE '+where,params).fetchone()['n']
    try:page=max(1,int(request.args.get('page',1)))
    except ValueError:page=1
    pages=max(1,(total+limit-1)//limit);page=min(page,pages)
    rows=db().execute('SELECT * FROM travel_records WHERE '+where+' ORDER BY start_date DESC,id DESC LIMIT %s OFFSET %s',params+[limit,(page-1)*limit]).fetchall()
    # Only visible records contribute to filter options; hidden destinations are not disclosed.
    visible="deleted_at IS NULL"+('' if user() else " AND status='public'")
    options=db().execute('SELECT DISTINCT destination,extract(year from start_date)::int AS year FROM travel_records WHERE '+visible).fetchall()
    return dict(records=[serialize_record(r) for r in rows],total=total,page=page,pages=pages,
                destinations=sorted({r['destination'] for r in options}),years=sorted({r['year'] for r in options},reverse=True))

@app.get('/api/records')
def records(): return jsonify(record_listing())

@app.get('/api/records/<int:record_id>')
def record_detail(record_id):
    record=serialize_record(record_row(record_id),True)
    guide=None
    if record['guide_id']:
        linked=db().execute('SELECT id,title,status,deleted_at,sample,days FROM guides WHERE id=%s',(record['guide_id'],)).fetchone()
        if linked and not linked['deleted_at'] and (user() or (linked['status']=='public' and (not linked['sample'] or site_settings()['show_samples']))):
            guide={key:linked[key] for key in ('id','title','days')}
        elif not user():record['guide_id']=None;record['guide_day']=None
    if request.args.get('view')=='read':record.pop('body',None)
    return jsonify(record=record,guide=guide)

def validate_record(data):
    values={}
    for key,limit in {'title':100,'destination':80,'summary':300,'body':100000,'actual_cost':100}.items():
        value=data.get(key,'')
        if not isinstance(value,str) or len(value)>limit:abort(400,description='记录内容过长或格式不正确')
        values[key]=value.strip()
    if not values['title'] or not values['destination']:abort(400,description='请填写记录标题和地点')
    for key in ('start_date','end_date'):
        raw=data.get(key,'')
        if key=='end_date' and raw in ('',None):values[key]=None;continue
        try:
            if not isinstance(raw,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',raw):raise ValueError()
            values[key]=date.fromisoformat(raw)
        except (TypeError,ValueError):abort(400,description='请填写有效的游玩日期')
    if values['end_date'] and values['end_date']<values['start_date']:abort(400,description='结束日期不能早于开始日期')
    photos=data.get('photos',[])
    if not isinstance(photos,list) or len(photos)>30:abort(400,description='每篇记录最多 30 张照片')
    cleaned=[];urls=set()
    for photo in photos:
        if not isinstance(photo,dict):abort(400,description='照片格式不正确')
        url=photo.get('url','');caption=photo.get('caption','')
        if not isinstance(url,str) or not re.fullmatch(r'/media/[a-f0-9]{32}\.webp',url):abort(400,description='请先上传照片或从素材库选择')
        if not isinstance(caption,str) or len(caption)>200:abort(400,description='每张照片说明最多 200 字')
        if url in urls:abort(400,description='同一篇记录不能重复添加同一张照片')
        urls.add(url);cleaned.append({'url':url,'caption':caption.strip()})
    values['photos']=Jsonb(cleaned)
    cover=data.get('cover') or (cleaned[0]['url'] if cleaned else '/static/assets/lake.jpg')
    if not isinstance(cover,str):abort(400,description='封面格式不正确')
    if cleaned and cover not in urls:abort(400,description='请从本篇照片中选择封面')
    if not cleaned and cover!='/static/assets/lake.jpg':abort(400,description='没有相册照片时请使用默认封面')
    values['cover']=cover
    filenames={url.rsplit('/',1)[1] for url in urls}
    filenames.update(re.findall(r'/media/([a-f0-9]{32}\.webp)',values['body']))
    for filename in sorted(filenames):
        image=db().execute('SELECT filename FROM media WHERE filename=%s AND deleted_at IS NULL FOR SHARE',(filename,)).fetchone()
        if not image or not (DATA/'uploads'/filename).is_file():abort(400,description='照片不存在或已移入素材回收站，请重新选择')
    for key in ('guide_id','guide_day'):
        raw=data.get(key)
        if raw in ('',None):values[key]=None;continue
        if type(raw)!=int or not 1<=raw<=2147483647:abort(400,description='关联攻略和行程天数格式不正确')
        values[key]=raw
    if values['guide_day'] and (values['guide_day']>365 or not values['guide_id']):abort(400,description='请先选择关联攻略，行程日为 1～365')
    if values['guide_id'] and not db().execute('SELECT id FROM guides WHERE id=%s AND deleted_at IS NULL FOR KEY SHARE',(values['guide_id'],)).fetchone():abort(400,description='关联攻略不存在或已在回收站')
    values['status']=data.get('status','draft')
    if values['status'] not in ('public','private','draft'):abort(400,description='请选择正确的可见范围')
    if values['status']=='public' and not values['body'] and not cleaned:abort(400,description='公开前请添加游记正文或照片')
    values['updated_at']=now()
    return values

@app.post('/api/records')
@admin_required
def create_record():
    values=validate_record(payload())
    row=db().execute('INSERT INTO travel_records('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()
    audit('record.create',row['id'],{'title':values['title'],'status':values['status']});db().commit()
    return jsonify(id=row['id']),201

@app.put('/api/records/<int:record_id>')
@admin_required
def update_record(record_id):
    row=record_row(record_id,True);data=payload()
    if row['deleted_at']:abort(400,description='请先恢复回收站中的记录')
    if data.get('revision')!=row['revision']:abort(409,description='记录已在其他页面修改，请保留当前内容并刷新后再试')
    values=validate_record(data);values['revision']=row['revision']+1
    db().execute('UPDATE travel_records SET '+','.join(k+'=%s' for k in values)+' WHERE id=%s',list(values.values())+[record_id])
    audit('record.update',record_id,{'title':values['title'],'status':values['status']});db().commit()
    return jsonify(id=record_id,revision=values['revision'])

@app.post('/api/admin/records/<int:record_id>/action')
def record_action(record_id):
    row=record_row(record_id,True);action=payload().get('action')
    if action=='trash':db().execute('UPDATE travel_records SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=%s',(record_id,))
    elif action=='restore':db().execute('UPDATE travel_records SET deleted_at=NULL,updated_at=now(),revision=revision+1 WHERE id=%s',(record_id,))
    elif action=='purge':
        if not row['deleted_at']:abort(400,description='只能彻底删除回收站中的记录')
        db().execute('DELETE FROM travel_records WHERE id=%s',(record_id,))
    else:abort(400,description='不支持的记录操作')
    audit('record.'+action,record_id,{'title':row['title']});db().commit();return jsonify(ok=True)

def handbook_path(guide_id):
    row=guide_row(guide_id)
    path=DATA/'uploads'/'handbooks'/f'{guide_id}.html'
    if f'/guides/{guide_id}/handbook' not in row['body'] or not path.is_file(): abort(404)
    return path

@app.get('/guides/<int:guide_id>/handbook')
def handbook(guide_id):
    path=handbook_path(guide_id)
    imported=path.with_suffix('.import.json').is_file()
    if request.args.get('download')=='source' and imported:
        info=json.loads(path.with_suffix('.import.json').read_text())
        source=path.with_suffix('.source'+info['extension'])
        if not source.is_file(): abort(404)
        response=send_file(source,mimetype='application/octet-stream',as_attachment=True,download_name=info['filename'],conditional=False)
        response.headers['Content-Security-Policy']=STATIC_HANDBOOK_CSP
        response.headers['Cache-Control']='no-store'
        return response
    download=request.args.get('download')=='1'
    if download:
        path=path.with_suffix('.original.html')
        if not path.is_file(): abort(404)
    response=send_file(path,mimetype='text/html',conditional=False,as_attachment=download,download_name=f'travel-handbook-{guide_id}.html')
    response.headers['Content-Security-Policy']=STATIC_HANDBOOK_CSP if imported else HANDBOOK_CSP
    response.headers['Cache-Control']='no-store'
    return response

@app.get('/guides/<int:guide_id>/handbook/images/<filename>')
def handbook_image(guide_id,filename):
    handbook_path(guide_id)
    if not re.fullmatch(r'[a-f0-9]{32}\.webp',filename): abort(404)
    path=DATA/'uploads'/'handbooks'/str(guide_id)/filename
    if not path.is_file(): abort(404)
    response=send_file(path,mimetype='image/webp')
    response.headers['Cache-Control']='private, no-cache'
    return response

def validate(data):
    if not isinstance(data,dict): abort(400,description='表单格式不正确')
    result={}
    limits={'title':100,'destination':80,'country':50,'summary':300,'body':100000,'season':60,'budget':60,'sources':5000,'verified_at':10}
    for key,limit in limits.items():
        value=data.get(key,'')
        if not isinstance(value,str) or len(value)>limit: abort(400,description='部分内容过长或格式不正确')
        result[key]=value.strip()
    if not result['title'] or not result['destination']: abort(400,description='请填写攻略标题和目的地')
    result['status']=data.get('status','draft')
    if result['status'] not in ('draft','private','public'): abort(400,description='请选择正确的可见范围')
    if result['status']=='public' and not result['body']: abort(400,description='公开攻略前，请先填写正文')
    try:
        result['days']=int(data.get('days') or 1)
        if not 1<=result['days']<=365: raise ValueError()
    except (ValueError,TypeError): abort(400,description='旅行天数应为 1～365 天')
    tags=data.get('tags',[])
    if not isinstance(tags,list) or len(tags)>12 or any(not isinstance(t,str) or len(t)>24 for t in tags): abort(400,description='最多 12 个标签，每个不超过 24 字')
    result['tags']=Jsonb(list(dict.fromkeys(t.strip() for t in tags if t.strip())))
    cover=data.get('cover','/static/assets/lake.jpg')
    if not isinstance(cover,str) or not re.fullmatch(r'/(?:static/assets/[a-z]+\.(?:jpg|svg)|media/[a-f0-9]{32}\.webp)',cover): abort(400,description='请选择有效封面')
    if cover.startswith('/media/'):
        media_row=db().execute('SELECT * FROM media WHERE filename=%s AND deleted_at IS NULL FOR SHARE',(cover.split('/')[-1],)).fetchone()
        if not media_row or not (DATA/'uploads'/media_row['filename']).is_file(): abort(400,description='封面图片不存在或已在回收站')
    elif not (BASE/cover.lstrip('/')).is_file(): abort(400,description='封面图片不存在')
    for filename in set(re.findall(r'/media/([a-f0-9]{32}\.webp)',result['body'])):
        if not db().execute('SELECT filename FROM media WHERE filename=%s AND deleted_at IS NULL FOR SHARE',(filename,)).fetchone(): abort(400,description='正文包含已删除或不存在的素材')
    result['cover']=cover
    if result['verified_at']:
        try: datetime.strptime(result['verified_at'],'%Y-%m-%d')
        except ValueError: abort(400,description='核实日期格式不正确')
    category=data.get('category_id')
    if category in ('',None): result['category_id']=None
    else:
        try: category=int(category)
        except (TypeError,ValueError): abort(400,description='请选择正确分类')
        if not db().execute('SELECT id FROM categories WHERE id=%s',(category,)).fetchone(): abort(400,description='该分类已不存在')
        result['category_id']=category
    sample=data.get('sample',False)
    if not isinstance(sample,bool): abort(400,description='示例标记格式不正确')
    result['sample']=sample
    result['updated_at']=now()
    return result

def sync_tags(values):
    for tag in values['tags'].obj: db().execute('INSERT INTO tags(name) VALUES(%s) ON CONFLICT DO NOTHING',(tag,))


def prior_html_import(digest):
    return db().execute("SELECT g.id,g.title,g.deleted_at,a.details->>'import_token' AS import_token FROM audit_log a JOIN guides g ON a.target=g.id::text WHERE a.action='guide.import_html' AND a.details->>'source_sha256'=%s ORDER BY a.id DESC LIMIT 1",(digest,)).fetchone()

def import_directory(token):
    if not re.fullmatch(r'[a-f0-9]{32}',token): abort(404,description='导入预览不存在')
    path=DATA/'html-imports'/token
    try: info=json.loads((path/'manifest.json').read_text())
    except (OSError,ValueError): abort(404,description='导入预览不存在，请重新上传')
    if time.time()-info['created']>86400: abort(410,description='导入预览已过期，请重新上传')
    binding=hashlib.sha256(session.get('csrf','').encode()).hexdigest()
    if info['admin_id']!=user()['id'] or not secrets.compare_digest(info['session'],binding):
        abort(404,description='请在上传文件的登录会话中继续导入，或重新上传')
    return path,info

def import_preview_html(body,token,info):
    result=render_markdown(body)
    for image in info['images']:
        name=image['filename']
        result=result.replace('src="/media/'+name+'"','src="/api/admin/html-imports/'+token+'/images/'+name+'"')
    return result

@app.post('/api/admin/html-imports')
def parse_html_import():
    file=request.files.get('file')
    if not file or not file.filename: abort(400,description='请选择 HTML 或 ZIP 文件')
    filename=Path(file.filename.replace('\\','/')).name[:150]
    raw=file.read(MAX_UPLOAD+1)
    if not raw or len(raw)>MAX_UPLOAD: abort(400,description='请选择非空文件，HTML 或 ZIP 最大 8 MB')
    previous=prior_html_import(hashlib.sha256(raw).hexdigest())
    if previous:
        return jsonify(error='这份文件已经导入，请打开已有攻略；回收站中的攻略可以恢复。',existing=dict(previous)),409
    root=DATA/'html-imports';root.mkdir(mode=0o700,exist_ok=True)
    for directory in root.iterdir():
        if directory.is_dir() and re.fullmatch(r'[a-f0-9]{32}',directory.name) and time.time()-directory.stat().st_mtime>86400:
            shutil.rmtree(directory)
    if sum(1 for d in root.iterdir() if d.is_dir() and not (d/'complete').exists())>=20:
        abort(429,description='临时预览较多，请先在导入页面放弃不用的预览，或等待一天后自动清理')
    token=secrets.token_hex(16);directory=root/token;directory.mkdir(mode=0o700)
    try:
        info=parse_upload(raw,filename,directory)
        (directory/'snapshot.html').write_text(info.pop('snapshot'))
        (directory/'source').write_bytes(raw)
        info.update(created=time.time(),admin_id=user()['id'],session=hashlib.sha256(session['csrf'].encode()).hexdigest())
        (directory/'manifest.json').write_text(json.dumps(info,ensure_ascii=False))
    except ImportProblem as exc:
        shutil.rmtree(directory);abort(400,description=str(exc))
    except Exception:
        shutil.rmtree(directory);raise
    return jsonify(token=token),201

@app.get('/api/admin/html-imports/<token>')
def get_html_import(token):
    _,info=import_directory(token)
    return jsonify(token=token,guide=info['guide'],warnings=info['warnings'],stats=info['stats'],filename=info['source_filename'],html=import_preview_html(info['guide']['body'],token,info))

@app.delete('/api/admin/html-imports/<token>')
def discard_html_import(token):
    path,_=import_directory(token);shutil.rmtree(path)
    return jsonify(ok=True)

@app.get('/api/admin/html-imports/<token>/images/<filename>')
def html_import_image(token,filename):
    path,info=import_directory(token)
    if filename not in {p['filename'] for p in info['images']}: abort(404)
    return send_file(path/filename,mimetype='image/webp',conditional=False)

@app.post('/api/admin/html-imports/<token>/preview')
def preview_html_import(token):
    _,info=import_directory(token)
    body=payload().get('body','')
    if not isinstance(body,str) or len(body)>100000: abort(400,description='正文格式不正确')
    return jsonify(html=import_preview_html(body,token,info))

@app.post('/api/admin/html-imports/<token>/save')
def save_html_import(token):
    directory,info=import_directory(token)
    data=payload().copy()
    body=data.get('body','')
    if not isinstance(body,str) or not body.strip() or len(body)>98000:
        abort(400,description='请保留非空正文，导入正文最多 98,000 字符')
    conn=db();created=[]
    try:
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('html-import:'+info['source_sha256'],))
        previous=prior_html_import(info['source_sha256'])
        if previous:
            if previous['import_token']==token:
                return jsonify(id=previous['id'],already_imported=True)
            return jsonify(error='该文件已在另一个页面导入，请打开已有攻略。',existing=dict(previous)),409
        for p in info['images']:
            target=DATA/'uploads'/p['filename']
            with target.open('xb') as file:
                created.append(target);file.write((directory/p['filename']).read_bytes())
            target.chmod(0o640)
            conn.execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,%s,%s,%s)',(p['filename'],p['name'],p['bytes'],p['width'],p['height']))
        values=validate(data);sync_tags(values)
        gid=conn.execute('INSERT INTO guides('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()['id']
        entry=f'原版附件：[查看 HTML 手册](/guides/{gid}/handbook) · [下载离线手册](/guides/{gid}/handbook?download=1) · [下载上传源文件](/guides/{gid}/handbook?download=source)\n\n> 原版是导入时的静态快照；编辑下方正文不会同步修改附件。\n\n'
        conn.execute('UPDATE guides SET body=%s WHERE id=%s',(entry+values['body'],gid))
        handbooks=DATA/'uploads'/'handbooks';handbooks.mkdir(mode=0o750,exist_ok=True)
        image_dir=handbooks/str(gid);image_dir.mkdir(mode=0o750);created.append(image_dir)
        snapshot=(directory/'snapshot.html').read_text()
        offline=snapshot
        for p in info['images']:
            name=p['filename'];source=directory/name
            shutil.copyfile(source,image_dir/name);(image_dir/name).chmod(0o640)
            snapshot=snapshot.replace('/media/'+name,f'/guides/{gid}/handbook/images/'+name)
            offline=offline.replace('/media/'+name,'data:image/webp;base64,'+base64.b64encode(source.read_bytes()).decode())
        extension=Path(info['source_filename'].lower()).suffix
        files={f'{gid}.html':snapshot.encode(),f'{gid}.original.html':offline.encode(),f'{gid}.source{extension}':(directory/'source').read_bytes(),f'{gid}.import.json':json.dumps({'filename':info['source_filename'],'extension':extension,'source_sha256':info['source_sha256']},ensure_ascii=False).encode()}
        for filename,raw in files.items():
            path=handbooks/filename
            with path.open('xb') as file:
                created.append(path);file.write(raw)
            path.chmod(0o640)
        audit('guide.import_html',gid,{'title':values['title'],'source_filename':info['source_filename'],'source_sha256':info['source_sha256'],'media_count':len(info['images']),'import_token':token})
        conn.commit()
    except Exception:
        conn.rollback()
        for path in reversed(created):
            if path.is_dir():shutil.rmtree(path)
            else:path.unlink(missing_ok=True)
        raise
    try: (directory/'complete').touch()
    except OSError: app.logger.warning('Unable to mark completed HTML import staging directory')
    return jsonify(id=gid),201

@app.post('/api/guides')
@admin_required
def create_guide():
    values=validate(payload());sync_tags(values)
    row=db().execute('INSERT INTO guides('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()
    audit('guide.create',row['id'],{'title':values['title'],'status':values['status']});db().commit()
    return jsonify(id=row['id']),201

@app.put('/api/guides/<int:guide_id>')
@admin_required
def update_guide(guide_id):
    row=guide_row(guide_id,True);data=payload()
    if row['deleted_at']: abort(400,description='请先从回收站恢复这篇攻略')
    if data.get('revision')!=row['revision']: abort(409,description='攻略已在其他页面修改。请保留当前内容，刷新后重新编辑。')
    values=validate(data);sync_tags(values);values['revision']=row['revision']+1
    db().execute('UPDATE guides SET '+','.join(k+'=%s' for k in values)+' WHERE id=%s',list(values.values())+[guide_id])
    audit('guide.update',guide_id,{'title':values['title'],'status':values['status']});db().commit()
    return jsonify(id=guide_id,revision=values['revision'])

@app.patch('/api/admin/guides/<int:guide_id>/metadata')
def update_guide_metadata(guide_id):
    data=payload()
    fields=set(data)-{'revision'}
    if not fields or not fields<={'category_id','status'}:
        abort(400,description='这里只支持修改分类和状态')
    if type(data.get('revision'))!=int or data['revision']<1:
        abort(400,description='请刷新列表后重试')
    if 'status' in fields and data['status'] not in ('public','private','draft'):
        abort(400,description='请选择正确的状态')
    if 'category_id' in fields and data['category_id'] is not None:
        category=data['category_id']
        if type(category)!=int or not 1<=category<=9223372036854775807:
            abort(400,description='请选择有效分类')
        # Follow the category deletion lock order: category, then guide.
        if not db().execute('SELECT id FROM categories WHERE id=%s FOR KEY SHARE',(category,)).fetchone():
            abort(400,description='分类已不存在，请刷新列表后重新选择')
    row=guide_row(guide_id,True)
    if row['deleted_at']:abort(400,description='请先从回收站恢复这篇攻略')
    if data['revision']!=row['revision']:
        abort(409,description='攻略已在其他页面修改，请查看最新列表后重新选择')
    if data.get('status')=='public' and not row['body'].strip():
        abort(400,description='攻略正文为空，请先编辑内容再发布')
    values={key:data[key] for key in sorted(fields) if data[key]!=row[key]}
    if values:
        changes={key:{'from':row[key],'to':value} for key,value in values.items()}
        values.update(updated_at=now(),revision=row['revision']+1)
        row=db().execute('UPDATE guides SET '+','.join(k+'=%s' for k in values)+' WHERE id=%s RETURNING *',list(values.values())+[guide_id]).fetchone()
        audit('guide.quick_update',guide_id,{'title':row['title'],'changes':changes})
    db().commit()
    return jsonify(guide={key:row[key] for key in ('id','category_id','status','revision','updated_at')})

@app.delete('/api/guides/<int:guide_id>')
@admin_required
def delete_guide(guide_id):
    row=guide_row(guide_id,True)
    db().execute('UPDATE guides SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=%s',(guide_id,))
    audit('guide.trash',guide_id,{'title':row['title']});db().commit();return jsonify(ok=True)

@app.post('/api/guides/<int:guide_id>/restore')
@admin_required
def restore_guide(guide_id):
    row=guide_row(guide_id,True)
    db().execute('UPDATE guides SET deleted_at=NULL,updated_at=now(),revision=revision+1 WHERE id=%s',(guide_id,))
    audit('guide.restore',guide_id,{'title':row['title']});db().commit();return jsonify(ok=True)

@app.get('/api/admin/guides')
def admin_guides():
    conditions=['deleted_at IS NOT NULL' if request.args.get('trash')=='1' else 'deleted_at IS NULL'];params=[]
    q=request.args.get('q','').strip()[:200]
    if q:
        conditions.append("(title ILIKE %s OR destination ILIKE %s OR summary ILIKE %s OR tags::text ILIKE %s)");params.extend(['%'+q+'%']*4)
    status=request.args.get('status','')
    if status in ('public','private','draft'): conditions.append('status=%s');params.append(status)
    category=request.args.get('category','')
    if category.isdigit(): conditions.append('category_id=%s');params.append(int(category))
    tag=request.args.get('tag','')
    if tag: conditions.append('tags ? %s');params.append(tag[:24])
    where=' AND '.join(conditions)
    total=db().execute('SELECT count(*) AS n FROM guides WHERE '+where,params).fetchone()['n']
    try: page=max(1,int(request.args.get('page','1')))
    except ValueError: page=1
    page=min(page,max(1,(total+19)//20))
    rows=db().execute('SELECT * FROM guides WHERE '+where+' ORDER BY updated_at DESC,id DESC LIMIT 20 OFFSET %s',params+[(page-1)*20]).fetchall()
    return jsonify(guides=[serialize(r) for r in rows],total=total,page=page,pages=max(1,(total+19)//20))

@app.post('/api/admin/guides/bulk')
def bulk_guides():
    data=payload();ids=data.get('ids');action=data.get('action')
    if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(type(i)!=int or i<1 for i in ids): abort(400,description='请选择 1～100 篇攻略')
    ids=list(set(ids));rows=db().execute('SELECT * FROM guides WHERE id=ANY(%s) ORDER BY id FOR UPDATE',(ids,)).fetchall()
    if len(rows)!=len(ids): abort(404,description='部分攻略已不存在，请刷新')
    if action in ('public','private','draft'):
        if any(r['deleted_at'] for r in rows): abort(400,description='请先恢复回收站中的攻略')
        if action=='public' and any(not r['body'].strip() for r in rows): abort(400,description='选中攻略中有空正文，无法发布')
        db().execute('UPDATE guides SET status=%s,updated_at=now(),revision=revision+1 WHERE id=ANY(%s)',(action,ids))
    elif action=='trash': db().execute('UPDATE guides SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=ANY(%s)',(ids,))
    elif action=='restore': db().execute('UPDATE guides SET deleted_at=NULL,updated_at=now(),revision=revision+1 WHERE id=ANY(%s)',(ids,))
    elif action=='purge':
        if any(not r['deleted_at'] for r in rows): abort(400,description='只有回收站内的攻略可彻底删除')
        db().execute('DELETE FROM guides WHERE id=ANY(%s)',(ids,))
    else: abort(400,description='不支持的批量操作')
    audit('guide.bulk_'+action,details={'ids':ids,'titles':[r['title'] for r in rows]});db().commit();return jsonify(ok=True,count=len(ids))

@app.get('/api/admin/taxonomy')
def taxonomy():
    cats=db().execute('SELECT c.id,c.name,count(g.id) AS count FROM categories c LEFT JOIN guides g ON g.category_id=c.id AND g.deleted_at IS NULL GROUP BY c.id ORDER BY c.id').fetchall()
    tags=db().execute('SELECT t.name,(SELECT count(*) FROM guides g WHERE g.tags ? t.name AND g.deleted_at IS NULL) AS count FROM tags t ORDER BY t.name').fetchall()
    return jsonify(categories=cats,tags=tags)

@app.post('/api/admin/taxonomy')
def change_taxonomy():
    data=payload();kind=data.get('kind');action=data.get('action');name=data.get('name','');old=data.get('old','')
    if kind not in ('category','tag') or action not in ('create','rename','delete'): abort(400,description='不支持的分类操作')
    if not isinstance(name,str) or (action!='delete' and not 1<=len(name.strip())<=(24 if kind=='tag' else 40)): abort(400,description='名称为空或过长')
    name=name.strip()
    if kind=='category':
        if action=='create': db().execute('INSERT INTO categories(name) VALUES(%s)',(name,))
        else:
            try: category_id=int(data.get('id'))
            except (TypeError,ValueError): abort(400,description='分类编号无效')
            if not db().execute('SELECT id FROM categories WHERE id=%s FOR UPDATE',(category_id,)).fetchone(): abort(404,description='分类已不存在')
            if action=='rename': db().execute('UPDATE categories SET name=%s WHERE id=%s',(name,category_id))
            else:
                db().execute('UPDATE guides SET category_id=NULL,revision=revision+1,updated_at=now() WHERE category_id=%s',(category_id,))
                db().execute('DELETE FROM categories WHERE id=%s',(category_id,))
    else:
        # Lock guide rows in the same order as batch updates; rename/delete propagates to trash too.
        if action=='create': db().execute('INSERT INTO tags(name) VALUES(%s)',(name,))
        else:
            if not isinstance(old,str) or not db().execute('SELECT name FROM tags WHERE name=%s',(old,)).fetchone(): abort(404,description='标签已不存在')
            if action=='rename': db().execute('INSERT INTO tags(name) VALUES(%s)',(name,))
            rows=db().execute('SELECT id,tags FROM guides WHERE tags ? %s ORDER BY id FOR UPDATE',(old,)).fetchall()
            for row in rows:
                updated=[name if t==old else t for t in row['tags']] if action=='rename' else [t for t in row['tags'] if t!=old]
                db().execute('UPDATE guides SET tags=%s,revision=revision+1,updated_at=now() WHERE id=%s',(Jsonb(list(dict.fromkeys(updated))),row['id']))
            db().execute('DELETE FROM tags WHERE name=%s',(old,))
    audit('taxonomy.'+action,kind,{'name':name,'old':old,'id':data.get('id')});db().commit();return jsonify(ok=True)

@app.post('/api/upload')
@admin_required
def upload():
    # Allow multipart framing in addition to the file's own 50 MiB limit.
    request.max_content_length=MAX_IMAGE_UPLOAD+1024*1024
    file=request.files.get('image')
    if not file: abort(400,description='请选择一张图片')
    file.stream.seek(0,io.SEEK_END)
    size=file.stream.tell()
    file.stream.seek(0)
    if size>MAX_IMAGE_UPLOAD:abort(413,description='图片不能超过 50 MB')
    filename=secrets.token_hex(16)+'.webp';path=DATA/'uploads'/filename
    try:
        with Image.open(file.stream) as original:
            # Phone JPEGs with MPF metadata may be identified as MPO. Its first
            # frame is the primary photo; extra gain-map/depth frames are omitted.
            jpeg=original.format in ('JPEG','MPO')
            if not jpeg and original.format not in ('PNG','WEBP'):
                abort(400,description=f'暂不支持 {original.format} 图片，请导出为 JPG/JPEG、PNG 或 WebP 后上传')
            pixel_limit=MAX_JPEG_PIXELS if jpeg else 30_000_000
            if original.width*original.height>pixel_limit:
                abort(400,description=f'照片分辨率超过 {pixel_limit//10000} 万像素，请缩小尺寸后上传')
            # Ask libjpeg to downsample while decoding, before EXIF transposition
            # or RGB copies allocate a full-size phone/camera image.
            if jpeg: original.draft('RGB',(2400,2400))
            original.thumbnail((2400,2400))
            with ImageOps.exif_transpose(original) as oriented, oriented.convert('RGB') as picture:
                picture.save(path,'WEBP',quality=85)
                width,height=picture.size
            db().execute('INSERT INTO media(filename,name,bytes,width,height) VALUES(%s,%s,%s,%s,%s)',(filename,(file.filename or filename)[:150],path.stat().st_size,width,height))
            audit('media.upload',filename);db().commit()
    except (UnidentifiedImageError,OSError,Image.DecompressionBombError):
        path.unlink(missing_ok=True);abort(400,description='图片损坏或实际格式无法读取，请重新导出为 JPG/JPEG、PNG 或 WebP 后上传')
    except Exception:
        path.unlink(missing_ok=True);raise
    return jsonify(url='/media/'+filename),201

def media_refs(filename):
    url='/media/'+filename
    guides=db().execute("SELECT id,title,deleted_at,'guide' AS kind FROM guides WHERE cover=%s OR position(%s in body)>0 ORDER BY id",(url,url)).fetchall()
    records=db().execute("SELECT id,title,deleted_at,'record' AS kind FROM travel_records WHERE cover=%s OR position(%s in body)>0 OR photos @> %s ORDER BY id",(url,url,Jsonb([{'url':url}]))).fetchall()
    tasks=db().execute("SELECT id,'旅游助手 · ' || coalesce(report->'travel_guide'->>'title','攻略') AS title,NULL AS deleted_at,'travel-agent' AS kind FROM agent_tasks WHERE request->>'assistant'='travel' AND position(%s in coalesce(report->'travel_guide'->>'body',''))>0 ORDER BY id",(url,)).fetchall()
    return guides+records+tasks

@app.get('/api/admin/media')
def admin_media():
    rows=db().execute('SELECT * FROM media ORDER BY created_at DESC').fetchall()
    for row in rows: row.update(url='/media/'+row['filename'],references=media_refs(row['filename']))
    defaults=[{'url':'/static/assets/'+p.name,'name':p.stem} for p in sorted((BASE/'static/assets').iterdir()) if re.fullmatch(r'[a-z]+\.(jpg|svg)',p.name)]
    return jsonify(media=rows,defaults=defaults)

@app.post('/api/admin/media/<filename>')
def update_media(filename):
    if not re.fullmatch(r'[a-f0-9]{32}\.webp',filename): abort(404)
    row=db().execute('SELECT * FROM media WHERE filename=%s FOR UPDATE',(filename,)).fetchone()
    if not row: abort(404)
    data=payload();action=data.get('action')
    if action=='rename':
        name=data.get('name','')
        if not isinstance(name,str) or not 1<=len(name.strip())<=150: abort(400,description='素材名称需要 1～150 字')
        db().execute('UPDATE media SET name=%s WHERE filename=%s',(name.strip(),filename))
    elif action=='trash':
        if media_refs(filename): abort(409,description='图片仍被攻略、旅行足迹或旅游助手引用（含回收站），请先移除引用')
        db().execute('UPDATE media SET deleted_at=now() WHERE filename=%s',(filename,))
    elif action=='restore': db().execute('UPDATE media SET deleted_at=NULL WHERE filename=%s',(filename,))
    else: abort(400,description='不支持的素材操作')
    audit('media.'+action,filename);db().commit();return jsonify(ok=True)

@app.get('/media/<filename>')
def media(filename):
    if not re.fullmatch(r'[a-f0-9]{32}\.webp',filename): abort(404)
    row=db().execute('SELECT filename,deleted_at FROM media WHERE filename=%s',(filename,)).fetchone()
    if not row: abort(404)
    if not user():
        if row['deleted_at']: abort(404)
        url='/media/'+filename
        sql="SELECT id FROM guides WHERE status='public' AND deleted_at IS NULL AND (cover=%s OR position(%s in body)>0)"
        if not site_settings()['show_samples']: sql+=' AND NOT sample'
        guide_used=db().execute(sql+' LIMIT 1',(url,url)).fetchone()
        record_used=db().execute("SELECT id FROM travel_records WHERE status='public' AND deleted_at IS NULL AND (cover=%s OR position(%s in body)>0 OR photos @> %s) LIMIT 1",(url,url,Jsonb([{'url':url}]))).fetchone()
        if not guide_used and not record_used: abort(404)
    path=DATA/'uploads'/filename
    if not path.is_file(): abort(404)
    width=request.args.get('w')
    if width:
        if width not in ('640','1280'): abort(400,description='不支持的图片尺寸')
        path=image_variant(path,int(width))
    return send_file(path,mimetype='image/webp')

@app.get('/api/admin/overview')
def overview():
    counts=db().execute("SELECT count(*) FILTER(WHERE deleted_at IS NULL) AS total,count(*) FILTER(WHERE deleted_at IS NULL AND status='public') AS public,count(*) FILTER(WHERE deleted_at IS NULL AND status='draft') AS draft,count(*) FILTER(WHERE deleted_at IS NULL AND status='private') AS private,count(*) FILTER(WHERE deleted_at IS NOT NULL) AS trash FROM guides").fetchone()
    assets=db().execute('SELECT count(*) AS count,COALESCE(sum(bytes),0)::bigint AS bytes FROM media WHERE deleted_at IS NULL').fetchone()
    recent=db().execute('SELECT * FROM guides WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5').fetchall()
    last=db().execute("SELECT value FROM settings WHERE key='last_backup'").fetchone()
    records=db().execute("SELECT count(*) FILTER(WHERE deleted_at IS NULL) AS total,count(*) FILTER(WHERE deleted_at IS NULL AND status='public') AS public FROM travel_records").fetchone()
    return jsonify(counts=counts,records=records,media=assets,recent=[serialize(r) for r in recent],database='PostgreSQL',backup=last['value'] if last else None)

@app.get('/api/admin/audit')
def logs():
    try: page=max(1,int(request.args.get('page','1')))
    except ValueError: page=1
    total=db().execute('SELECT count(*) AS n FROM audit_log').fetchone()['n'];pages=max(1,(total+29)//30);page=min(page,pages)
    rows=db().execute('SELECT * FROM audit_log ORDER BY id DESC LIMIT 30 OFFSET %s',((page-1)*30,)).fetchall()
    return jsonify(logs=rows,total=total,page=page,pages=pages)

@app.get('/api/admin/export')
def export():
    rows=db().execute('SELECT * FROM guides ORDER BY id').fetchall()
    data={'format':'travel-notes-export-v2','exported_at':now().isoformat(),'guides':rows,'records':db().execute('SELECT * FROM travel_records ORDER BY id').fetchall(),
        'categories':db().execute('SELECT * FROM categories ORDER BY id').fetchall(),'settings':site_settings()}
    audit('data.export',details={'count':len(rows)});db().commit()
    content=json.dumps(data,ensure_ascii=False,indent=2,default=lambda d:d.isoformat()).encode()
    return send_file(io.BytesIO(content),mimetype='application/json',as_attachment=True,download_name='travel-notes-'+date.today().isoformat()+'.json')

# All /api/admin routes use the common administrator and CSRF protection above.
from agent_api import register as register_agent
register_agent(app, db, payload, audit)
from travel_planner_api import register as register_travel_planner
register_travel_planner(app, db, payload, audit, render_markdown, validate, sync_tags, DATA)
