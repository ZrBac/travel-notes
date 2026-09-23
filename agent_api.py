"""Administrator-only task API. This process never receives model credentials."""
import re
from datetime import datetime, timezone
from flask import abort, jsonify, request
from psycopg.types.json import Jsonb


def register(app, db, payload, audit):
    def task(task_id, lock=False):
        row = db().execute("SELECT * FROM agent_tasks WHERE id=%s AND request->>'assistant' IS DISTINCT FROM 'travel'" + (" FOR UPDATE" if lock else ""), (task_id,)).fetchone()
        if not row: abort(404, description='任务不存在')
        return row

    def service():
        row = db().execute("SELECT value FROM settings WHERE key='agent_service'").fetchone()
        data = dict(row['value']) if row else {}
        data['online'] = datetime.now(timezone.utc).timestamp() - data.get('heartbeat', 0) < 300
        return data

    @app.get('/api/admin/agent')
    def agent_index():
        before=request.args.get('before','')
        if before and (not before.isascii() or not before.isdigit() or len(before)>18 or int(before)<1):abort(400,description='分页位置无效')
        rows = db().execute("SELECT id,kind,prompt,status,parent_id,created_at,updated_at,report->>'outcome' AS outcome,report->>'repair_attempt' AS repair_attempt FROM agent_tasks WHERE request->>'assistant' IS DISTINCT FROM 'travel'"+(' AND id<%s' if before else '')+' ORDER BY id DESC LIMIT 51',(int(before),) if before else ()).fetchall()
        return jsonify(tasks=rows[:50],next_before=rows[49]['id'] if len(rows)>50 else None,service=service())

    @app.get('/api/admin/agent/tasks/<int:task_id>')
    def agent_detail(task_id):
        row = task(task_id)
        # Internal filesystem state and raw model output never cross the API.
        fields = ('id','kind','prompt','status','parent_id','result','report','created_at','updated_at')
        return jsonify(task={key:row[key] for key in fields})

    @app.post('/api/admin/agent/tasks')
    def agent_create():
        data = payload(); kind = data.get('kind', 'change'); prompt = data.get('prompt')
        if kind not in ('change','diagnose','chat') or not isinstance(prompt,str) or not 2 <= len(prompt.strip()) <= 6000:
            abort(400, description='请选择任务类型，填写 2～6000 字的需求')
        if not service().get('online'): abort(503, description='网站管家暂未连接，请稍后重试')
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        parent_id = data.get('parent_id')
        if parent_id is not None:
            if type(parent_id) is not int or parent_id < 1: abort(400, description='关联任务无效')
            parent = task(parent_id)
            if parent['status'] in ('queued','running','testing','publishing'): abort(409, description='请等上一任务完成后再补充需求')
        count = db().execute("SELECT count(*) AS n FROM agent_tasks WHERE request->>'assistant' IS DISTINCT FROM 'travel' AND status IN ('queued','running','testing','publishing')").fetchone()['n']
        if count >= 5: abort(429, description='最多保留 5 个待处理任务，请稍后提交')
        row = db().execute('INSERT INTO agent_tasks(kind,prompt,parent_id) VALUES(%s,%s,%s) RETURNING id', (kind,prompt.strip(),parent_id)).fetchone()
        audit('agent.submit',row['id'],{'kind':kind});db().commit()
        return jsonify(id=row['id']),201

    @app.delete('/api/admin/agent/tasks/<int:task_id>')
    def agent_delete(task_id):
        # Match creation/publication lock ordering; lock status before deleting.
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        row = task(task_id, lock=True)
        if row['status'] in ('queued', 'running', 'testing', 'publishing'):
            abort(409, description='处理中任务不能删除，请先停止并等待任务结束')
        child = db().execute('SELECT id FROM agent_tasks WHERE parent_id=%s ORDER BY id DESC LIMIT 1', (task_id,)).fetchone()
        if child:
            abort(409, description='此记录仍被后续任务引用，请先删除后续任务 #' + str(child['id']))
        db().execute('DELETE FROM agent_tasks WHERE id=%s', (task_id,))
        audit('agent.delete', task_id)
        db().commit()
        return jsonify(ok=True)

    @app.post('/api/admin/agent/tasks/<int:task_id>/cancel')
    def agent_cancel(task_id):
        row=task(task_id)
        if row['status'] not in ('queued','running','testing'): abort(409,description='此任务当前不能取消')
        changed=db().execute("UPDATE agent_tasks SET cancel_requested=true,updated_at=now() WHERE id=%s AND status IN ('queued','running','testing') RETURNING id",(task_id,)).fetchone()
        if not changed: abort(409,description='任务状态已更新，请刷新')
        audit('agent.cancel',task_id);db().commit();return jsonify(ok=True)

    @app.post('/api/admin/agent/tasks/<int:task_id>/publish')
    def agent_publish(task_id):
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        data=payload();row=task(task_id)
        digest=data.get('artifact')
        if row['status']!='ready' or not row['report'].get('publishable') or digest!=row['report'].get('artifact'):
            abort(409,description='候选版本已变化或尚未通过检查，请刷新后查看')
        if db().execute("SELECT id FROM agent_tasks WHERE kind='publish' AND parent_id=%s AND status IN ('queued','publishing','running')",(task_id,)).fetchone():
            abort(409,description='此版本正在发布')
        new=db().execute("INSERT INTO agent_tasks(kind,prompt,parent_id,request) VALUES('publish','发布已审核的候选版本',%s,%s) RETURNING id",(task_id,Jsonb({'artifact':digest}))).fetchone()
        audit('agent.publish_request',task_id);db().commit();return jsonify(id=new['id']),201

    @app.post('/api/admin/agent/rollback')
    def agent_rollback():
        version=payload().get('version','')
        if not isinstance(version,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}',version): abort(400,description='请选择有效版本')
        known=service().get('versions',[])
        if version not in known: abort(409,description='此回退版本已过期，请刷新后选择')
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        if db().execute("SELECT id FROM agent_tasks WHERE kind='rollback' AND status IN ('queued','running','publishing')").fetchone(): abort(409,description='已有回退任务')
        new=db().execute("INSERT INTO agent_tasks(kind,prompt,request) VALUES('rollback',%s,%s) RETURNING id",('回退代码至 '+version,Jsonb({'version':version}))).fetchone()
        audit('agent.rollback_request',new['id']);db().commit();return jsonify(id=new['id']),201
