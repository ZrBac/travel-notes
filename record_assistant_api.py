"""Private editor snapshots, durable footprint tasks and explicit preview adoption."""
from datetime import datetime, timezone
from html import escape
import re

from flask import abort, jsonify, request, session
from psycopg.types.json import Jsonb

ACTIONS = {'record_generate': '生成旅行足迹', 'record_polish': '润色旅行足迹', 'record_photos': '识图并整理照片说明'}
SCOPE = "request->>'assistant'='travel' AND request->>'workflow' IN ('record_generate','record_polish','record_photos') AND request->>'created_by'=%s"
FIELDS = ('title', 'destination', 'start_date', 'end_date', 'summary', 'body', 'actual_cost', 'photos')
MARKER = re.compile(r'\[\[(?:原图|相册)[^\]]*\]\]')


def normalize_snapshot(raw, validate_record, allow_missing_destination=False):
    if not isinstance(raw, dict): abort(400, description='请先填写足迹内容')
    record_id, revision = raw.get('id'), raw.get('revision')
    if record_id is not None and (type(record_id) is not int or not 1 <= record_id < 2**63):
        abort(400, description='足迹编号不正确')
    if record_id is not None and (type(revision) is not int or revision < 1):
        abort(400, description='足迹版本不正确，请重新打开编辑页')
    title = raw.get('title', '')
    if not isinstance(title, str) or len(title) > 100: abort(400, description='标题最多 100 字')
    # Generating a title is part of this workflow. The regular save validator
    # still checks dates, destinations, every actual photo and inline image.
    destination = raw.get('destination', '')
    values = validate_record({**raw, 'destination': ('地点待补充' if allow_missing_destination and destination == '' else destination),
                              'title': title.strip() or '旅行回忆', 'status': 'private',
                              'guide_id': None, 'guide_day': None, 'cover': None})
    result = {key: values[key] for key in FIELDS}
    result.update(id=record_id, revision=revision if record_id else None, title=title.strip())
    if allow_missing_destination and destination == '': result['destination'] = ''
    result['photos'] = values['photos'].obj
    for field in ('start_date', 'end_date'):
        result[field] = values[field].isoformat() if values[field] else ''
    return result


def check_source(db, snapshot):
    if snapshot['id'] is None: return
    row = db().execute('SELECT revision,deleted_at FROM travel_records WHERE id=%s', (snapshot['id'],)).fetchone()
    if not row or row['deleted_at']: abort(409, description='这篇足迹已删除，请先恢复或重新打开')
    if row['revision'] != snapshot['revision']:
        abort(409, description='足迹已在其他页面更新，请保留当前内容，重新打开后再整理')


def context_for(snapshot, render_markdown, metadata=None):
    images = []
    def protect(match):
        marker = '[[原图'+str(len(images)+1).zfill(2)+']]'
        images.append({'marker': marker, 'html': match.group()})
        return marker
    body = re.sub(r'<img\b[^>]*>', protect, render_markdown(snapshot['body']), flags=re.I)
    # Strip unused image addresses from captions and source text sent to the
    # text-only worker. The original snapshot remains private on the server.
    body = re.sub(r'/media/[a-f0-9]{32}\.webp(?:\?[^\s"<>]*)?', '[照片地址]', body)
    return {'record': {key: value for key, value in snapshot.items() if key not in ('photos', 'body')},
            'body': body, 'images': images,
            'photos': [{'marker': '[[相册'+str(i+1).zfill(2)+']]', 'caption': photo['caption'],
                        **({'taken_at': metadata.get(photo['url'], {}).get('taken_at', '')} if metadata is not None else {})}
                       for i, photo in enumerate(snapshot['photos'])]}


def proposal_for(row, render_markdown):
    result = row['report'].get('workflow_result')
    if row['status'] != 'done' or not isinstance(result, dict):
        abort(409, description='请等待足迹整理完成，再预览采用')
    if row['request']['workflow'] == 'record_photos':
        source = row['request']['record_snapshot']['photos']
        photos = result.get('photos'); warnings = result.get('warnings', [])
        if (not isinstance(photos, list) or len(photos) != len(source) or not isinstance(warnings, list)
                or len(warnings) > 20 or any(not isinstance(w, str) or len(w) > 1000 for w in warnings)):
            abort(409, description='识图结果不完整，请重试')
        indexed = {}
        for photo in photos:
            if not isinstance(photo, dict): abort(409, description='照片说明格式不正确')
            marker = photo.get('marker')
            if not isinstance(marker, str) or marker in indexed: abort(409, description='照片对应关系不正确')
            for field, limit in (('caption', 200), ('place_hint', 80), ('quality_note', 120)):
                if not isinstance(photo.get(field), str) or len(photo[field]) > limit:
                    abort(409, description='照片说明过长或不完整')
            if not photo['caption'].strip() or photo.get('confidence') not in ('high','medium','low') or photo.get('subject') not in ('风景','美食','人文','合影','其他') or type(photo.get('highlight')) is not bool:
                abort(409, description='照片识别信息不完整')
            indexed[marker] = photo
        expected = ['[[相册'+str(i+1).zfill(2)+']]' for i in range(len(source))]
        if set(indexed) != set(expected): abort(409, description='识图结果遗漏或添加了照片')
        return {'photos': [{**indexed[marker], 'index': i, 'url': source[i]['url'], 'original_caption': source[i]['caption']}
                           for i, marker in enumerate(expected)], 'warnings': warnings}
    for key, limit in (('title', 100), ('summary', 300), ('body', 100000)):
        if not isinstance(result.get(key), str) or not result[key].strip() or len(result[key]) > limit:
            abort(409, description='整理结果不完整，请重新生成')
    body = result['body'].strip()
    if re.search(r'!\[|<\s*(?:img|picture|source)\b|/media/', body, re.I):
        abort(409, description='整理结果包含未经核对的图片，请重新生成')
    context = row['request']['context']
    protected = {p['marker']: p['html'] for p in context['images']}
    original_markers = [p['marker'] for p in context['images']]
    output_markers = MARKER.findall(body)
    if [m for m in output_markers if m in protected] != original_markers:
        abort(409, description='整理结果遗漏或改动了原有图片，请重新生成')
    replacements = dict(protected)
    for metadata, photo in zip(context['photos'], row['request']['record_snapshot']['photos']):
        caption = escape(photo['caption'])
        replacements[metadata['marker']] = '<figure><img src="'+escape(photo['url'], quote=True)+'" alt="'+escape(photo['caption'] or '旅行照片', quote=True)+'">'+('<figcaption>'+caption+'</figcaption>' if caption else '')+'</figure>'
    if any(m not in replacements or output_markers.count(m) != 1 for m in output_markers):
        abort(409, description='整理结果引用了不存在或重复的照片，请重新生成')
    body = MARKER.sub(lambda match: replacements[match.group()], body)
    # A captionless album is still a real album. Include a small set when the
    # worker chose no picture positions; all 30 images stay in the saved album.
    if context['photos'] and not output_markers:
        body += '\n\n## 旅途照片\n\n'+'\n\n'.join(replacements[p['marker']] for p in context['photos'][:6])
    if len(body) > 100000: abort(409, description='整理后的正文过长，请缩短后再试')
    warnings = result.get('warnings', [])
    if not isinstance(warnings, list) or len(warnings) > 20 or any(not isinstance(w, str) or len(w) > 1000 for w in warnings):
        abort(409, description='整理结果的说明不完整，请重新生成')
    return {'title': result['title'].strip(), 'summary': result['summary'].strip(), 'body': body,
            'html': render_markdown(body), 'warnings': warnings}


def task_for(db, task_id, lock=False):
    row = db().execute('SELECT * FROM agent_tasks WHERE id=%s AND '+SCOPE+(' FOR UPDATE' if lock else ''),
                       (task_id, str(session['admin_id']))).fetchone()
    if not row: abort(404, description='这次足迹整理不存在或已删除')
    return row


def saved_record(db, data):
    """Lock a selected task before record rows; retries never create duplicates."""
    task_id = data.get('record_assistant_task')
    if task_id is None: return None
    if type(task_id) is not int or not 1 <= task_id < 2**63: abort(400, description='足迹整理编号不正确')
    task = task_for(db, task_id, True)
    if task['status'] != 'done': abort(409, description='足迹整理尚未完成')
    record_id = task['request'].get('saved_record_id')
    if record_id:
        row = db().execute('SELECT id,deleted_at FROM travel_records WHERE id=%s FOR UPDATE', (record_id,)).fetchone()
        if not row or row['deleted_at']: abort(409, description='整理结果已存档，请先从回收站恢复原足迹')
    return record_id


def link_saved(db, data, record_id):
    task_id = data.get('record_assistant_task')
    if task_id is None: return
    task = task_for(db, task_id, True)
    info = dict(task['request'])
    if info.get('saved_record_id') not in (None, record_id):
        abort(409, description='这次整理已用于另一篇足迹，请打开原足迹继续编辑')
    info['saved_record_id'] = record_id
    db().execute('UPDATE agent_tasks SET request=%s,updated_at=now() WHERE id=%s', (Jsonb(info), task_id))


def register(app, db, payload, audit, render_markdown, validate_record, data_dir):
    @app.post('/api/admin/record-assistant/tasks')
    def record_assistant_submit():
        data = payload(); action = data.get('action'); prompt = data.get('prompt', '')
        if not isinstance(action, str) or action not in ACTIONS: abort(400, description='请选择识图、生成游记或润色正文')
        if not isinstance(prompt, str) or len(prompt) > 2000: abort(400, description='经历或修改要求最多 2000 字')
        prompt = prompt.strip(); key = data.get('request_key')
        if not isinstance(key, str) or not re.fullmatch('[a-f0-9]{32}', key): abort(400, description='提交标识不正确，请重试')
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        previous = db().execute('SELECT id FROM agent_tasks WHERE '+SCOPE+" AND request->>'request_key'=%s", (str(session['admin_id']), key)).fetchone()
        if previous: return jsonify(id=previous['id'], already_saved=True)
        snapshot = normalize_snapshot(data.get('record'), validate_record, allow_missing_destination=action == 'record_photos'); check_source(db, snapshot)
        from photo_album_api import metadata_for
        metadata = metadata_for(db, snapshot['photos'], data_dir)
        context = context_for(snapshot, render_markdown, metadata)
        # A photo count alone is not evidence of an experience. A few actual
        # words or captions are enough, without requiring a separate trip.
        text = re.sub('<[^>]+>', '', context['body'])
        text = MARKER.sub('', text).strip()
        if action == 'record_polish' and not text: abort(400, description='请先写一点正文，再润色；也可以选择生成游记')
        if action == 'record_photos' and not snapshot['photos']: abort(400, description='先上传或选择几张旅行照片，再识图')
        if action != 'record_photos' and not (text or snapshot['summary'] or prompt or any(p['caption'] for p in snapshot['photos'])):
            abort(400, description='写几句真实经历，或给照片加一句说明，再让助手整理')
        service = db().execute("SELECT value FROM settings WHERE key='agent_service'").fetchone()
        info = service['value'] if service else {}
        if datetime.now(timezone.utc).timestamp()-info.get('heartbeat', 0) >= 300 or not info.get('authenticated'):
            abort(503, description='旅游助手暂未连接或账号需要重新登录；照片和文字仍保留')
        count = db().execute("SELECT count(*) n FROM agent_tasks WHERE request->>'assistant'='travel' AND status IN ('queued','running','testing','publishing')").fetchone()['n']
        if count >= 5: abort(429, description='旅游助手队列已满，请等现有任务完成')
        value = {'assistant': 'travel', 'workflow': action, 'created_by': session['admin_id'], 'request_key': key,
                 'record_id': snapshot['id'], 'record_snapshot': snapshot, 'context': context,
                 'trip': {'destination': snapshot['destination'], 'dates': snapshot['start_date']+(' 至 '+snapshot['end_date'] if snapshot['end_date'] else '')}}
        row = db().execute("INSERT INTO agent_tasks(kind,prompt,request) VALUES('chat',%s,%s) RETURNING id",
                           (prompt or ACTIONS[action], Jsonb(value))).fetchone()
        audit('record.assistant_submit', snapshot['id'], {'task_id': row['id'], 'action': action}); db().commit()
        return jsonify(id=row['id'], already_saved=False), 201

    @app.get('/api/admin/record-assistant/tasks')
    def record_assistant_history():
        record_id = request.args.get('record_id', 'new')
        params = [str(session['admin_id'])]
        condition = "coalesce(request->>'saved_record_id',request->>'record_id') IS NULL"
        if record_id != 'new':
            if not re.fullmatch('[1-9][0-9]{0,17}', record_id): abort(400, description='足迹编号不正确')
            condition = "coalesce(request->>'saved_record_id',request->>'record_id')=%s"; params.append(record_id)
        rows = db().execute("SELECT id,prompt,status,created_at,updated_at,request->>'workflow' action FROM agent_tasks WHERE "+SCOPE+' AND '+condition+' ORDER BY id DESC LIMIT 20', params).fetchall()
        return jsonify(tasks=rows)

    @app.get('/api/admin/record-assistant/tasks/<int:task_id>')
    def record_assistant_detail(task_id):
        row = task_for(db, task_id); info = row['request']; report = row['report']
        result = {key: row[key] for key in ('id', 'status', 'updated_at')}
        result.update(action=info['workflow'], record_id=info.get('saved_record_id') or info.get('record_id'),
                      reason=report.get('reason', ''), progress=report.get('progress', [])[-8:])
        if request.args.get('view') != 'status':
            result.update(prompt=row['prompt'], snapshot=info['record_snapshot'], proposal=None)
            if row['status'] == 'done':
                result['proposal'] = proposal_for(row, render_markdown)
        return jsonify(task=result)

    @app.post('/api/admin/record-assistant/tasks/<int:task_id>/preview')
    def record_assistant_preview(task_id):
        row = task_for(db, task_id); snapshot = normalize_snapshot(payload().get('record'), validate_record, allow_missing_destination=row['request']['workflow'] == 'record_photos')
        check_source(db, snapshot)
        if snapshot != row['request']['record_snapshot']:
            abort(409, description='生成后正文、日期或照片有更新，请按最新内容重新整理；当前改动会保留')
        return jsonify(proposal=proposal_for(row, render_markdown))
