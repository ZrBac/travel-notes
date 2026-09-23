"""Explicit, signed deletion plans for complete assistant task branches."""
import hashlib
import json
from flask import abort, jsonify, session
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

ACTIVE={'queued','running','testing','publishing'}


def register(app, db, payload, audit):
    signer=URLSafeTimedSerializer(app.secret_key,salt='assistant-task-delete-v1')

    def roots(data):
        ids=data.get('ids')
        if not isinstance(ids,list) or not 1<=len(ids)<=100 or any(type(i) is not int or not 1<=i<10**18 for i in ids) or len(set(ids))!=len(ids):
            abort(400,description='请选择 1～100 条不同的任务记录')
        return sorted(ids)

    def plan(scope,ids):
        # Same order as task creation/publication; row locks serialize worker updates.
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        found=db().execute("SELECT id,request->>'assistant' AS assistant FROM agent_tasks WHERE id=ANY(%s)",(ids,)).fetchall()
        if len(found)!=len(ids) or any((r['assistant']=='travel')!=(scope=='travel-agent') for r in found):
            abort(404,description='部分任务已不存在，请刷新列表后重新选择')
        rows=db().execute("""WITH RECURSIVE branch(id) AS (
            SELECT id FROM agent_tasks WHERE id=ANY(%s)
            UNION SELECT t.id FROM agent_tasks t JOIN branch b ON t.parent_id=b.id
        ) SELECT t.id,t.parent_id,t.prompt,t.status,t.updated_at,t.request->>'assistant' AS assistant
          FROM agent_tasks t JOIN branch b ON b.id=t.id ORDER BY t.id LIMIT 501 FOR UPDATE OF t""",(ids,)).fetchall()
        if len(rows)>500:abort(400,description='关联任务超过 500 条，请分组清理')
        if any((r['assistant']=='travel')!=(scope=='travel-agent') for r in rows):
            abort(409,description='存在其他助手的关联记录，无法合并删除，请联系管理员检查')
        fingerprint=hashlib.sha256(json.dumps([(r['id'],r['parent_id'],r['status'],r['updated_at'].isoformat()) for r in rows],separators=(',',':')).encode()).hexdigest()
        claim={'scope':scope,'roots':ids,'fingerprint':fingerprint,'admin':session.get('admin_id'),'version':session.get('version')}
        return rows,claim

    def preview(scope):
        ids=roots(payload());rows,claim=plan(scope,ids)
        blocked=[r['id'] for r in rows if r['status'] in ACTIVE]
        return jsonify(ids=[r['id'] for r in rows],selected_ids=ids,added_count=len(rows)-len(ids),blocked_ids=blocked,
                       can_delete=not blocked,confirmation=signer.dumps(claim),
                       tasks=[{'id':r['id'],'parent_id':r['parent_id'],'title':r['prompt'][:100],'status':r['status'],'selected':r['id'] in ids} for r in rows])

    def delete(scope):
        data=payload();ids=roots(data)
        token=data.get('confirmation')
        if not isinstance(token,str) or not 1<=len(token)<=8192:abort(409,description='请先检查并确认删除范围')
        try:claim=signer.loads(token,max_age=600)
        except (BadSignature,SignatureExpired,TypeError):abort(409,description='删除确认已失效，请重新检查删除范围')
        rows,current=plan(scope,ids)
        if claim!=current:abort(409,description='任务或关联记录已变化，请重新检查删除范围')
        if any(r['status'] in ACTIVE for r in rows):abort(409,description='这组记录包含正在处理的任务，请停止并等待结束后再删除')
        deleted=[r['id'] for r in rows]
        # One statement removes every descendant, so no dangling parent references remain.
        db().execute('DELETE FROM agent_tasks WHERE id=ANY(%s)',(deleted,))
        audit(('travel_agent' if scope=='travel-agent' else 'agent')+'.bulk_delete',details={'name':f'{len(deleted)} 条任务记录','ids':deleted,'selected_ids':ids})
        db().commit()
        return jsonify(ok=True,ids=deleted,count=len(deleted))

    for scope in ('agent','travel-agent'):
        app.add_url_rule('/api/admin/'+scope+'/tasks/delete-preview','task_delete_preview_'+scope,lambda scope=scope:preview(scope),methods=['POST'])
        app.add_url_rule('/api/admin/'+scope+'/tasks/bulk-delete','task_bulk_delete_'+scope,lambda scope=scope:delete(scope),methods=['POST'])
