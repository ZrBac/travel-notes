"""Private trip snapshots and explicit application of bounded assistant proposals."""
import copy
from datetime import date, datetime, timedelta, timezone
import re
import secrets
from flask import abort, jsonify, request, session
from psycopg.types.json import Jsonb
from trip_api import integer, text, today, summary, normalize_itinerary

ACTIONS = {'adjust_day':'调整当天', 'check_departure':'临行复核', 'recap':'整理旅行回忆', 'preferences':'总结出游偏好'}
ACTIVE = ('queued', 'running', 'testing', 'publishing')


def json_dates(value):
    if isinstance(value, (date, datetime)): return value.isoformat()
    if isinstance(value, dict): return {k:json_dates(v) for k,v in value.items()}
    if isinstance(value, list): return [json_dates(v) for v in value]
    return value


def trip_context(db, trip_id, day=None):
    integer(trip_id, 10**18-1, '关联旅行')
    row = db().execute('SELECT * FROM trips WHERE id=%s', (trip_id,)).fetchone()
    if not row: abort(404, description='这趟旅行不存在')
    plan = db().execute('SELECT * FROM trip_plans WHERE trip_id=%s ORDER BY version DESC LIMIT 1', (trip_id,)).fetchone()
    notes = db().execute('SELECT id,captured_date,place,note,photos,revision FROM trip_notes WHERE trip_id=%s ORDER BY captured_date,id LIMIT 100', (trip_id,)).fetchall()
    preference = db().execute('SELECT value FROM settings WHERE key=%s', ('travel_family_preferences:'+str(session['admin_id']),)).fetchone()
    context = {'trip':summary(row), 'plan':{'version':plan['version'], 'itinerary':plan['snapshot']['itinerary'],
               'conditions':plan['snapshot'].get('conditions', {})} if plan else None,
               'notes':notes, 'preferences':preference['value'] if preference else {}, 'captured_at':datetime.now(timezone.utc)}
    if day is not None: context['day'] = integer(day, (row['end_date']-row['start_date']).days+1, '旅行日')
    # Keep the complete authoritative plan on the server; send only bounded text to the model.
    for item in (context['plan'] or {}).get('itinerary', []):
        for key in ('transport','lunch','dinner','stay','pace'): item[key] = item.get(key,'')[:500]
        for slot in item['slots']:
            for key in ('plan','transport','reservation'): slot[key] = slot.get(key,'')[:500]
    return json_dates(context)


def workflow_task(db, task_id, trip_id, action=None, lock=False):
    integer(task_id, 10**18-1, '助手任务')
    row = db().execute('SELECT * FROM agent_tasks WHERE id=%s'+(' FOR UPDATE' if lock else ''), (task_id,)).fetchone()
    info = row['request'] if row else {}
    if not row or info.get('assistant')!='travel' or info.get('attached_trip_id')!=trip_id or info.get('workflow') not in ACTIONS:
        abort(404, description='本次旅行的助手任务不存在')
    if action and info['workflow']!=action: abort(400, description='助手任务类型不匹配')
    return row


def current_task(db, task, trip):
    if task['status']!='done' or not isinstance(task['report'].get('workflow_result'),dict):
        abort(409, description='请等待助手完成后再采用建议')
    context = task['request']['context']
    plan = db().execute('SELECT * FROM trip_plans WHERE trip_id=%s ORDER BY version DESC LIMIT 1', (trip['id'],)).fetchone()
    if context['trip']['revision']!=trip['revision'] or (context.get('plan') or {}).get('version')!=(plan['version'] if plan else None):
        abort(409, description='生成期间旅行资料或行程已更新，请基于最新旅行重新生成；当前内容未被覆盖')
    return plan


def mark_applied(db, task, result):
    value = {**task['request'], 'applied':result}
    db().execute('UPDATE agent_tasks SET request=%s,updated_at=now() WHERE id=%s', (Jsonb(value),task['id']))


def adjustment(db, task_id, trip):
    task = workflow_task(db, task_id, trip['id'], 'adjust_day', True)
    if task['request'].get('applied'): abort(409, description='这个调整已经采用，请查看当前计划')
    original = current_task(db, task, trip)
    if not original: abort(409, description='请先填写或采用本次旅行计划')
    context = task['request']['context']; day = context['day']; proposal = task['report']['workflow_result'].get('day_plan')
    if trip['state']=='archived': abort(409,description='已归档旅行请先取消归档，再调整安排')
    if trip['start_date']+timedelta(days=day-1)<today(): abort(409,description='这一天已经过去，请保留实际记录，选择今天或未来日期重新调整')
    snapshot = copy.deepcopy(original['snapshot'])
    candidate = copy.deepcopy(snapshot['itinerary']); candidate[day-1] = proposal
    candidate = normalize_itinerary(candidate,snapshot['days'],snapshot['destination'])
    old = snapshot['itinerary'][day-1]
    marked = [i for i in range(len(old['stops'])) if trip['progress'].get(f"{original['version']}:{day}:{i}") in ('done','skipped')]
    if marked and candidate[day-1]['stops'][:max(marked)+1]!=old['stops'][:max(marked)+1]:
        abort(409, description='建议改动了已去或跳过的路线，请重新生成仅调整剩余安排的方案')
    snapshot['itinerary'] = candidate
    snapshot['assistant_notes'] = {'task_id':task_id,'summary':task['report']['workflow_result'].get('summary','')}
    return snapshot, original['source_guide_id'], task_id, '助手调整第 '+str(day)+' 天', task


def register(app, db, payload, audit, render, validate_record):
    @app.get('/api/admin/trips/<int:trip_id>/assistant-context')
    def assistant_context(trip_id):
        if request.args.get('view')=='planning':
            row=db().execute('SELECT * FROM trips WHERE id=%s',(trip_id,)).fetchone()
            if not row: abort(404,description='这趟旅行不存在')
            plan=db().execute("SELECT version,snapshot->'conditions' conditions FROM trip_plans WHERE trip_id=%s ORDER BY version DESC LIMIT 1",(trip_id,)).fetchone()
            return jsonify(context=json_dates({'trip':summary(row),'plan':plan}))
        return jsonify(context=trip_context(db,trip_id))

    @app.post('/api/admin/trips/<int:trip_id>/assistant')
    def trip_assistant_submit(trip_id):
        data=payload(); action=data.get('action')
        if not isinstance(action,str) or action not in ACTIONS: abort(400,description='请选择本次旅行的助手操作')
        prompt=text(data.get('prompt',''),6000,'补充要求')
        if action=='adjust_day' and len(prompt)<2: abort(400,description='说一下今天想怎么调整，例如下雨了，减少户外活动')
        key=data.get('request_key')
        if key is not None and (not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key)): abort(400,description='提交标识不正确')
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        if key:
            previous=db().execute("SELECT id FROM agent_tasks WHERE request->>'assistant'='travel' AND request->>'request_key'=%s AND request->>'attached_trip_id'=%s AND request->>'created_by'=%s",(key,str(trip_id),str(session['admin_id']))).fetchone()
            if previous: return jsonify(id=previous['id'],already_saved=True)
        row=db().execute('SELECT * FROM trips WHERE id=%s FOR UPDATE',(trip_id,)).fetchone()
        if not row: abort(404,description='这趟旅行不存在')
        if type(data.get('revision')) is not int or row['revision']!=data['revision']: abort(409,description='旅行资料已更新，请刷新后再提交；补充要求仍保留')
        if row['state']=='archived' and action in ('adjust_day','check_departure'): abort(409,description='已归档旅行请先取消归档，再修改安排')
        info=db().execute("SELECT value FROM settings WHERE key='agent_service'").fetchone()
        info=info['value'] if info else {}
        if datetime.now(timezone.utc).timestamp()-info.get('heartbeat',0)>=300 or not info.get('authenticated'): abort(503,description='旅游助手暂未连接或账号需要重新登录')
        count=db().execute("SELECT count(*) n FROM agent_tasks WHERE request->>'assistant'='travel' AND status IN ('queued','running','testing','publishing')").fetchone()['n']
        if count>=5: abort(429,description='旅游助手队列已满，请等现有任务完成')
        context=trip_context(db,trip_id,data.get('day') if action=='adjust_day' else None)
        if action=='adjust_day':
            if 'day' not in context or not context['plan']: abort(400,description='请先采用或填写计划，并选择要调整的日期')
            day_date=row['start_date']+timedelta(days=context['day']-1)
            if day_date<today(): abort(400,description='过去的行程请作为真实记录保留，选择今天或未来日期调整')
        if action in ('recap','preferences'):
            has_visits=any(v=='done' for k,v in row['progress'].items() if context['plan'] and k.startswith(str(context['plan']['version'])+':'))
            if not context['notes'] and not has_visits: abort(400,description='先留一点真实随记或标记已去地点，助手再据此整理，不会把计划当作实际经历')
        conditions={**((context['plan'] or {}).get('conditions',{})), 'destination':row['destination'], 'days':(row['end_date']-row['start_date']).days+1,
                    'people':row['people'], 'dates':row['start_date'].isoformat()+' 至 '+row['end_date'].isoformat(), 'companions':row['companions']}
        value={'assistant':'travel','workflow':action,'attached_trip_id':trip_id,'context':context,'trip':conditions,
               'created_by':session['admin_id'],'request_key':key}
        task=db().execute("INSERT INTO agent_tasks(kind,prompt,request) VALUES('chat',%s,%s) RETURNING id",(prompt or ACTIONS[action],Jsonb(value))).fetchone()
        audit('trip.assistant_submit',trip_id,{'task_id':task['id'],'action':action});db().commit()
        return jsonify(id=task['id'],already_saved=False),201

    @app.get('/api/admin/trips/<int:trip_id>/assistant')
    def trip_assistant_tasks(trip_id):
        trip=db().execute('SELECT revision FROM trips WHERE id=%s',(trip_id,)).fetchone()
        if not trip: abort(404,description='这趟旅行不存在')
        task_id=request.args.get('task_id')
        if task_id is not None and (not task_id.isascii() or not task_id.isdigit() or len(task_id)>18 or int(task_id)<1): abort(400,description='助手任务标识不正确')
        # History and polling never fetch the stored snapshot or render all articles.
        columns="id,prompt,status,created_at,updated_at,request->>'workflow' action,request#>'{context,day}' AS \"day\",request->'applied' applied,request#>'{context,trip,revision}' base_revision"
        if task_id: columns+=',report'
        rows=db().execute('SELECT '+columns+" FROM agent_tasks WHERE request->>'assistant'='travel' AND request->>'attached_trip_id'=%s AND request ? 'workflow'"+(' AND id=%s' if task_id else '')+' ORDER BY id DESC LIMIT 30',
                          (str(trip_id),int(task_id)) if task_id else (str(trip_id),)).fetchall()
        if task_id and not rows: abort(404,description='本次旅行的助手任务不存在')
        items=[]
        for row in rows:
            item={k:v for k,v in row.items() if k!='report'}
            item.update(trip_id=trip_id,stale=row['base_revision']!=trip['revision'])
            if task_id:
                report=row['report'];result=report.get('workflow_result') if row['status']=='done' else None
                item.update(result=result,html=render(result.get('body','')) if result else '',reason=report.get('reason','')[:1500],progress=report.get('progress',[])[-15:],execution=report.get('execution',{}))
            items.append(item)
        return jsonify(tasks=items,revision=trip['revision'])

    @app.post('/api/admin/trips/<int:trip_id>/assistant/<int:task_id>/apply')
    def trip_assistant_apply(trip_id,task_id):
        data=payload();db().execute('SELECT pg_advisory_xact_lock(74390511)')
        task=workflow_task(db,task_id,trip_id,lock=True);action=task['request']['workflow']
        applied=task['request'].get('applied')
        if applied:
            if applied.get('record_id'):
                record=db().execute('SELECT deleted_at FROM travel_records WHERE id=%s',(applied['record_id'],)).fetchone()
                if not record or record['deleted_at']: abort(409,description='已存档足迹已删除，请先在回收站恢复；不会重复创建')
            return jsonify(**applied,already_saved=True)
        row=db().execute('SELECT * FROM trips WHERE id=%s FOR UPDATE',(trip_id,)).fetchone()
        if not row: abort(404,description='这趟旅行不存在')
        if type(data.get('revision')) is not int or data['revision']!=row['revision']: abort(409,description='旅行已更新，请重新核对建议')
        current_task(db,task,row);result=task['report']['workflow_result']
        if action=='adjust_day': abort(400,description='请通过行程采用按钮保存为新计划版本')
        if action=='check_departure':
            checks=result.get('checks',[]);selected=data.get('indices')
            if not isinstance(selected,list) or not selected or len(selected)>30 or any(type(n) is not int or not 0<=n<len(checks) for n in selected): abort(400,description='请选择要加入的准备事项')
            items=copy.deepcopy(row['checklist'])
            for i in dict.fromkeys(selected):
                item=checks[i];kind=item.get('kind');title=text(item.get('title',''),200,'事项',True);note=text(item.get('note',''),500,'备注')
                if kind not in ('prepare','reservation','packing'): abort(400,description='事项类型不正确')
                if not any(x['title']==title and x['kind']==kind for x in items): items.append({'id':secrets.token_hex(8),'kind':kind,'title':title,'note':note,'done':False,'day':None,'plan_version':None})
            if len(items)>150: abort(400,description='准备事项已达上限，请先整理已有事项')
            db().execute('UPDATE trips SET checklist=%s,revision=revision+1,updated_at=now() WHERE id=%s',(Jsonb(items),trip_id))
            saved={'revision':row['revision']+1,'checklist':items}
        elif action=='recap':
            photos=[]
            for item in task['request']['context']['notes']:
                for photo in item['photos']:
                    if photo['url'] not in [p['url'] for p in photos] and len(photos)<30: photos.append(photo)
            values=validate_record({'title':text(result.get('title',''),100,'足迹标题',True),'destination':row['destination'],
                'start_date':row['start_date'].isoformat(),'end_date':row['end_date'].isoformat(), 'summary':text(result.get('summary',''),300,'足迹摘要'),
                'body':recap_body(result,task['request']['context']['notes']),'photos':photos,'status':'private',
                'cover':photos[0]['url'] if photos else '/static/assets/lake.jpg'})
            record=db().execute('INSERT INTO travel_records('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()
            db().execute('INSERT INTO trip_records(trip_id,record_id) VALUES(%s,%s)',(trip_id,record['id']))
            saved={'record_id':record['id'],'revision':row['revision']}
        else:
            if task['request'].get('created_by')!=session['admin_id']: abort(403,description='长期偏好请由提交这项总结的管理员确认')
            from travel_planner_api import normalize_family
            db().execute('SELECT pg_advisory_xact_lock(74390516,%s)',(session['admin_id'],))
            account=db().execute('SELECT id,session_version FROM admins WHERE id=%s FOR KEY SHARE',(session['admin_id'],)).fetchone()
            if not account or account['session_version']!=session.get('version'): abort(401,description='登录信息已更新，请重新登录')
            key='travel_family_preferences:'+str(session['admin_id'])
            old=db().execute('SELECT value FROM settings WHERE key=%s FOR UPDATE',(key,)).fetchone();old=old['value'] if old else {}
            if old!=task['request']['context'].get('preferences',{}): abort(409,description='家庭偏好已更新，请重新生成建议，不会覆盖最新偏好')
            chosen=data.get('fields');suggestions=result.get('suggestions',[])
            if not isinstance(chosen,list) or not chosen or any(not isinstance(f,str) for f in chosen): abort(400,description='请选择要记住的偏好')
            value=dict(old.get('preferences',{}));found=set()
            for item in suggestions:
                if item.get('field') in chosen:
                    field=item['field'];field_value=item['value'];found.add(field)
                    if field=='people':
                        if not isinstance(field_value,str) or not field_value.isascii() or not field_value.isdigit(): abort(400,description='人数建议格式不正确')
                        field_value=int(field_value)
                    value[field]=field_value
            if found!=set(chosen): abort(400,description='偏好建议已变化，请重新选择')
            value=normalize_family(value);stamp={'preferences':value,'updated_at':datetime.now(timezone.utc).isoformat()}
            db().execute('INSERT INTO settings(key,value) VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,Jsonb(stamp)))
            saved={'preferences':value,'revision':row['revision']}
        mark_applied(db,task,saved);audit('trip.assistant_apply',trip_id,{'task_id':task_id,'action':action});db().commit()
        return jsonify(**saved,already_saved=False)

    def note_values(data,row):
        from trip_api import iso_date
        captured=iso_date(data.get('captured_date'))
        if not row['start_date']<=captured<=row['end_date']: abort(400,description='随记日期需要在本次旅行日期内')
        note=text(data.get('note',''),2000,'随记');place=text(data.get('place',''),120,'地点')
        values=validate_record({'title':'旅行随记','destination':row['destination'],'start_date':captured.isoformat(),
                                'photos':data.get('photos',[]),'body':'','status':'private'})
        if not note and not values['photos'].obj: abort(400,description='留一句感受或选几张照片再保存')
        return {'captured_date':captured,'place':place,'note':note,'photos':values['photos']}

    @app.get('/api/admin/trips/<int:trip_id>/notes')
    def trip_notes(trip_id):
        row=db().execute('SELECT id,revision FROM trips WHERE id=%s',(trip_id,)).fetchone()
        if not row: abort(404,description='这趟旅行不存在')
        raw=request.args.get('page','1')
        if not raw.isascii() or not raw.isdigit() or len(raw)>2 or not 1<=int(raw)<=5: abort(400,description='随记分页无效')
        page=int(raw)
        notes=[] if request.args.get('view')=='links' else db().execute('SELECT * FROM trip_notes WHERE trip_id=%s ORDER BY captured_date DESC,id DESC LIMIT 21 OFFSET %s',(trip_id,(page-1)*20)).fetchall()
        records=db().execute('SELECT r.id,r.title,r.status,r.deleted_at FROM trip_records t JOIN travel_records r ON r.id=t.record_id WHERE t.trip_id=%s AND r.deleted_at IS NULL ORDER BY r.id DESC',(trip_id,)).fetchall()
        return jsonify(notes=notes[:20],records=records,revision=row['revision'],next_page=page+1 if len(notes)>20 else None)

    @app.post('/api/admin/trips/<int:trip_id>/notes')
    def trip_note_create(trip_id):
        data=payload();key=data.get('request_key')
        if not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key): abort(400,description='提交标识不正确，请刷新重试')
        db().execute('SELECT pg_advisory_xact_lock(74390515)')
        previous=db().execute('SELECT id,trip_id FROM trip_notes WHERE request_key=%s',(key,)).fetchone()
        if previous:
            if previous['trip_id']!=trip_id: abort(409,description='提交标识已用于其他旅行')
            return jsonify(id=previous['id'],already_saved=True)
        row=db().execute('SELECT * FROM trips WHERE id=%s FOR UPDATE',(trip_id,)).fetchone()
        if not row: abort(404,description='这趟旅行不存在')
        if type(data.get('revision')) is not int or data['revision']!=row['revision']: abort(409,description='旅行资料已更新，请刷新核对后再保存；照片和随记仍保留')
        if db().execute('SELECT count(*) n FROM trip_notes WHERE trip_id=%s',(trip_id,)).fetchone()['n']>=100: abort(400,description='本次旅行已有 100 条随记，请合并或整理旧随记后再添加')
        values=note_values(data,row);values.update(trip_id=trip_id,request_key=key,created_by=session['admin_id'])
        note=db().execute('INSERT INTO trip_notes('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING id',list(values.values())).fetchone()
        db().execute('UPDATE trips SET revision=revision+1,updated_at=now() WHERE id=%s',(trip_id,));audit('trip.note_create',trip_id,{'note_id':note['id']});db().commit()
        return jsonify(id=note['id'],revision=row['revision']+1,already_saved=False),201

    @app.put('/api/admin/trips/<int:trip_id>/notes/<int:note_id>')
    def trip_note_update(trip_id,note_id):
        data=payload();row=db().execute('SELECT * FROM trips WHERE id=%s FOR UPDATE',(trip_id,)).fetchone()
        note=db().execute('SELECT * FROM trip_notes WHERE id=%s AND trip_id=%s FOR UPDATE',(note_id,trip_id)).fetchone()
        if not row or not note: abort(404,description='这条随记不存在')
        if type(data.get('revision')) is not int or data['revision']!=note['revision']: abort(409,description='这条随记已更新，请重新核对')
        values=note_values({**json_dates(note),**data},row)
        db().execute('UPDATE trip_notes SET '+','.join(k+'=%s' for k in values)+',revision=revision+1,updated_at=now() WHERE id=%s',(*values.values(),note_id))
        db().execute('UPDATE trips SET revision=revision+1,updated_at=now() WHERE id=%s',(trip_id,));audit('trip.note_update',trip_id,{'note_id':note_id});db().commit()
        return jsonify(ok=True,revision=note['revision']+1,trip_revision=row['revision']+1)

    @app.delete('/api/admin/trips/<int:trip_id>/notes/<int:note_id>')
    def trip_note_delete(trip_id,note_id):
        data=payload();row=db().execute('SELECT * FROM trips WHERE id=%s FOR UPDATE',(trip_id,)).fetchone()
        note=db().execute('SELECT revision FROM trip_notes WHERE id=%s AND trip_id=%s FOR UPDATE',(note_id,trip_id)).fetchone()
        if not row or not note: abort(404,description='这条随记不存在')
        if type(data.get('revision')) is not int or data['revision']!=note['revision']: abort(409,description='这条随记已更新，请重新核对后再删除')
        db().execute('DELETE FROM trip_notes WHERE id=%s',(note_id,));db().execute('UPDATE trips SET revision=revision+1,updated_at=now() WHERE id=%s',(trip_id,))
        audit('trip.note_delete',trip_id,{'note_id':note_id});db().commit();return jsonify(ok=True,revision=row['revision']+1)


def recap_body(result,notes):
    from html import escape
    body=text(result.get('body',''),60000,'真实游记',True)
    if re.search(r'!\[[^\]]*\]\(|<\s*img\b|/media/',body,re.I): abort(400,description='游记正文包含未经核对的图片，请重新生成；相册将使用本次真实照片')
    sections=[];seen=set()
    for note in notes:
        pictures=[]
        for photo in note['photos']:
            if photo['url'] in seen or len(seen)>=30: continue
            seen.add(photo['url']);pictures.append('<figure><img src="'+escape(photo['url'],quote=True)+'" alt="'+escape(photo.get('caption',''),quote=True)+'"><figcaption>'+escape(photo.get('caption',''))+'</figcaption></figure>')
        if pictures:
            sections.append('<section><h3>'+escape(note['captured_date']+' · '+note['place'])+'</h3><p>'+escape(note['note'][:300])+'</p>'+''.join(pictures)+'</section>')
    # The existing renderer handles mixed Markdown and safe, locally sourced HTML.
    return body+('\n\n## 旅途照片与随记\n\n'+ '\n'.join(sections) if sections else '')
