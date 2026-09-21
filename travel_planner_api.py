"""Private travel research tasks, using the existing durable agent queue."""
from datetime import datetime, timezone
from flask import abort, jsonify, request, send_file
from pathlib import Path
import base64
import io
import re
from html import escape
from psycopg.types.json import Jsonb

SCOPE = "request->>'assistant' = 'travel'"
ACTIVE = ('queued', 'running', 'testing', 'publishing')


def normalize_trip(value):
    if not isinstance(value, dict): abort(400, description='旅行条件格式不正确')
    result = {}
    for field, limit in {'destination':120, 'origin':80, 'dates':120, 'rooms':120,
                         'budget':120, 'preferences':1500, 'excluded':500}.items():
        text = value.get(field, '')
        if not isinstance(text, str) or len(text) > limit: abort(400, description='旅行条件过长或格式不正确')
        result[field] = text.strip()
    for field, default, maximum in (('days',4,30), ('people',1,50)):
        number = value.get(field, default)
        if type(number) is not int or not 1 <= number <= maximum:
            abort(400, description='天数需要 1～30 天，人数需要 1～50 人')
        result[field] = number
    result['mode'] = value.get('mode', 'itinerary')
    if result['mode'] not in ('itinerary', 'compare'): abort(400, description='请选择攻略或目的地对比')
    result['template']='auto'
    if value.get('template','auto') not in ('auto','culture','nature','food'): abort(400, description='请选择有效的攻略模板')
    return result


def register(app, db, payload, audit, render_markdown, validate, sync_tags, data_path):
    def task(task_id, lock=False):
        row = db().execute('SELECT * FROM agent_tasks WHERE id=%s AND '+SCOPE+(' FOR UPDATE' if lock else ''), (task_id,)).fetchone()
        if not row: abort(404, description='旅游任务不存在')
        return row

    def service():
        row = db().execute("SELECT value FROM settings WHERE key='agent_service'").fetchone()
        info = row['value'] if row else {}
        return {'online':datetime.now(timezone.utc).timestamp()-info.get('heartbeat',0)<300,
                'authenticated':bool(info.get('authenticated')), 'concurrency':info.get('concurrency',1), 'lanes':info.get('lanes',{})}

    @app.get('/api/admin/travel-agent')
    def travel_index():
        before = request.args.get('before', '')
        if before and (not before.isascii() or not before.isdigit() or len(before)>18 or int(before)<1):
            abort(400, description='分页位置无效')
        rows = db().execute('SELECT id,prompt,status,parent_id,created_at,updated_at,request FROM agent_tasks WHERE '+SCOPE+
                            (' AND id<%s' if before else '')+' ORDER BY id DESC LIMIT 51', (int(before),) if before else ()).fetchall()
        items = [{**{key:row[key] for key in ('id','prompt','status','parent_id','created_at','updated_at')},
                  'trip':row['request'].get('trip',{}), 'guide_id':row['request'].get('guide_id')} for row in rows[:50]]
        return jsonify(tasks=items, next_before=rows[49]['id'] if len(rows)>50 else None, service=service())

    @app.get('/api/admin/travel-agent/tasks/<int:task_id>')
    def travel_detail(task_id):
        row = task(task_id)
        report = row['report']; guide = report.get('travel_guide')
        result = {key:row[key] for key in ('id','prompt','status','parent_id','result','created_at','updated_at')}
        result.update(trip=row['request'].get('trip',{}), guide_id=row['request'].get('guide_id'),
                      guide=guide, photo_count=report.get('photo_count',0), web_search_count=report.get('web_search_count',0),
                      progress=report.get('progress',[]),
                      html=render_markdown(guide['body']) if row['status']=='done' and guide else '')
        return jsonify(task=result)

    @app.post('/api/admin/travel-agent/tasks')
    def travel_create():
        data = payload(); prompt = data.get('prompt','')
        if not isinstance(prompt,str) or not 2 <= len(prompt.strip()) <= 6000:
            abort(400, description='请填写 2～6000 字的旅行需求')
        info = service()
        if not info['online']: abort(503, description='旅游助手暂未连接，请稍后重试')
        if not info['authenticated']: abort(503, description='助手账号需要重新登录，请通过服务器更新登录')
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        parent_id = data.get('parent_id'); parent = None
        if parent_id is not None:
            if type(parent_id) is not int or not 1 <= parent_id < 10**18: abort(400, description='关联任务无效')
            parent = task(parent_id)
            if parent['status'] in ACTIVE: abort(409, description='请等待当前任务完成后再继续修改')
        trip = normalize_trip(data.get('trip',parent['request'].get('trip',{}) if parent else {}))
        count = db().execute("SELECT count(*) AS n FROM agent_tasks WHERE request->>'assistant'='travel' AND status IN ('queued','running','testing','publishing')").fetchone()['n']
        if count >= 5: abort(429, description='助手队列已满，请等现有任务完成后再提交')
        row = db().execute("INSERT INTO agent_tasks(kind,prompt,parent_id,request) VALUES('chat',%s,%s,%s) RETURNING id",
                           (prompt.strip(),parent_id,Jsonb({'assistant':'travel','trip':trip}))).fetchone()
        audit('travel_agent.submit',row['id'],{'mode':trip['mode']}); db().commit()
        return jsonify(id=row['id']),201

    @app.delete('/api/admin/travel-agent/tasks/<int:task_id>')
    def travel_agent_delete(task_id):
        # Match creation/publication lock ordering; the row lock also serializes saves.
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        row = task(task_id, lock=True)
        if row['status'] in ('queued', 'running', 'testing', 'publishing'):
            abort(409, description='处理中任务不能删除，请先停止并等待任务结束')
        child = db().execute('SELECT id FROM agent_tasks WHERE parent_id=%s ORDER BY id DESC LIMIT 1', (task_id,)).fetchone()
        if child:
            abort(409, description='此记录仍被后续任务引用，请先删除后续任务 #' + str(child['id']))
        db().execute('DELETE FROM agent_tasks WHERE id=%s', (task_id,))
        audit('travel_agent.delete', task_id)
        db().commit()
        return jsonify(ok=True)

    @app.post('/api/admin/travel-agent/tasks/<int:task_id>/cancel')
    def travel_cancel(task_id):
        task(task_id)
        row = db().execute("UPDATE agent_tasks SET cancel_requested=true,updated_at=now() WHERE id=%s AND status IN ('queued','running') RETURNING id",(task_id,)).fetchone()
        if not row: abort(409, description='此任务当前不能停止，请刷新状态')
        audit('travel_agent.cancel',task_id); db().commit()
        return jsonify(ok=True)

    @app.post('/api/admin/travel-agent/tasks/<int:task_id>/save')
    def travel_save(task_id):
        row = task(task_id,lock=True)
        existing = row['request'].get('guide_id')
        if existing:
            guide = db().execute('SELECT id,deleted_at FROM guides WHERE id=%s',(existing,)).fetchone()
            if not guide or guide['deleted_at']: abort(409, description='此前存档已删除，请到回收站恢复，或继续修改后另存新版本')
            return jsonify(id=existing,already_saved=True)
        guide = row['report'].get('travel_guide')
        if row['status']!='done' or not isinstance(guide,dict): abort(409, description='攻略生成完成后才能存档')
        values = validate({**guide, 'status':'draft', 'verified_at':'', 'tags':['AI参考'], 'cover':guide.get('cover','/static/assets/lake.jpg'), 'sample':False})
        sync_tags(values)
        saved = db().execute('INSERT INTO guides('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()
        context = {**row['request'],'guide_id':saved['id']}
        db().execute('UPDATE agent_tasks SET request=%s,updated_at=now() WHERE id=%s',(Jsonb(context),task_id))
        audit('travel_agent.save',saved['id'],{'task_id':task_id,'title':values['title']}); db().commit()
        return jsonify(id=saved['id'],already_saved=False),201

    @app.get('/api/admin/travel-agent/tasks/<int:task_id>/export')
    def travel_export(task_id):
        row=task(task_id);guide=row['report'].get('travel_guide')
        if row['status']!='done' or not guide: abort(409,description='攻略完成后才能下载')
        html=render_markdown(guide['body']);total=0
        def embed(match):
            nonlocal total
            filename=match.group(1);path=data_path/'uploads'/filename
            media=db().execute('SELECT filename FROM media WHERE filename=%s AND deleted_at IS NULL',(filename,)).fetchone()
            if not media or not path.is_file() or path.stat().st_size>500000:return 'src=""'
            raw=path.read_bytes();total+=len(raw)
            if total>8*500000:return 'src=""'
            return 'src="data:image/webp;base64,'+base64.b64encode(raw).decode()+'"'
        html=re.sub(r'src="/media/([a-f0-9]{32}\.webp)(?:\?w=(?:640|1280))?"',embed,html)
        css=(Path(__file__).parent/'static/guide-visual.css').read_text()
        document='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(guide['title'])+'</title><style>body{max-width:1050px;margin:32px auto;padding:0 20px;font-family:system-ui,sans-serif;line-height:1.85;color:#243b32;background:#faf9f5}table{display:block;overflow:auto;border-collapse:collapse}td,th{padding:10px;border:1px solid #ddd}a{color:#24674e}img{max-width:100%}h1,h2,h3{line-height:1.45}pre{white-space:pre-wrap;overflow-wrap:anywhere}'+css+'</style><h1>'+escape(guide['title'])+'</h1><p>'+escape(guide['summary'])+'</p><p>攻略参考 · 价格和预约规则请以出行时官方信息为准。</p>'+html+'<h2>参考资料</h2>'+render_markdown(guide.get('sources',''))+'</html>'
        response=send_file(io.BytesIO(document.encode()),mimetype='text/html',as_attachment=True,download_name=guide['title']+'.html')
        response.headers['Content-Security-Policy']="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        return response
