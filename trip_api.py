"""Administrator-only concrete trips, immutable plan versions and everyday checklists."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import re
import secrets
from bs4 import BeautifulSoup
from flask import abort, jsonify, request, session
from psycopg.types.json import Jsonb
from travel_publication import destinations, split_guides

PERIODS = ('上午', '下午', '晚上')
DAY_TEXT = {'destination':80, 'theme':100, 'transport':1000, 'lunch':500,
            'dinner':500, 'stay':500, 'pace':500}


def today():
    return datetime.now(ZoneInfo('Asia/Shanghai')).date()


def text(value, limit, label, required=False):
    if not isinstance(value, str) or len(value)>limit or (required and not value.strip()):
        abort(400, description=label+'为空、过长或格式不正确')
    return value.strip()


def integer(value, maximum, label, minimum=1):
    if type(value) is not int or not minimum<=value<=maximum:
        abort(400, description=label+'格式不正确')
    return value


def iso_date(value):
    try:
        if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value): raise ValueError()
        return date.fromisoformat(value)
    except ValueError:
        abort(400, description='请选择有效的出行日期')


def summary(row, day=None):
    day=day or today()
    phase='archived' if row['state']=='archived' else 'upcoming' if row['start_date']>day else 'completed' if row['end_date']<day else 'travelling'
    return {**row, 'phase':phase, 'days':(row['end_date']-row['start_date']).days+1,
            'today_day':(day-row['start_date']).days+1 if phase=='travelling' else None,
            'countdown':max(0,(row['start_date']-day).days)}


def overview(db):
    day=today()
    row=db().execute("""SELECT t.id,t.title,t.destination,t.start_date,t.end_date,t.people,t.state,t.revision,
        coalesce(p.version,0) AS plan_version, jsonb_array_length(t.checklist) AS checklist_total,
        (SELECT count(*) FROM jsonb_array_elements(t.checklist) c WHERE c->>'done'='true') AS checklist_done
        FROM trips t LEFT JOIN LATERAL (SELECT version FROM trip_plans WHERE trip_id=t.id ORDER BY version DESC LIMIT 1) p ON true
        WHERE t.state='active' AND t.end_date>=%s
        ORDER BY CASE WHEN t.start_date<=%s THEN 0 ELSE 1 END,t.start_date,t.id DESC LIMIT 1""",(day,day)).fetchone()
    return summary(row,day) if row else None


def normalize_itinerary(value, days, destination):
    if not isinstance(value,list) or len(value)!=days:
        abort(400, description='每日安排需要完整覆盖本次旅行的天数')
    clean=[]
    for index,item in enumerate(value,1):
        if not isinstance(item,dict) or item.get('day')!=index or type(item.get('day')) is not int:
            abort(400, description='每日安排需要从第 1 天开始连续排列')
        row={'day':index}
        for key,limit in DAY_TEXT.items(): row[key]=text(item.get(key,destination if key=='destination' else ''),limit,'每日安排')
        row['destination']=destination
        stops=item.get('stops',[])
        if not isinstance(stops,list) or len(stops)>20: abort(400, description='每天最多填写 20 个路线地点')
        row['stops']=[text(stop,120,'路线地点',True) for stop in stops]
        slots=item.get('slots',[])
        if not isinstance(slots,list) or len(slots)!=3: abort(400, description='每天需要上午、下午和晚上的安排')
        row['slots']=[]
        for period,slot in zip(PERIODS,slots):
            if not isinstance(slot,dict) or slot.get('period')!=period: abort(400,description='请按上午、下午、晚上填写安排')
            row['slots'].append({'period':period, **{key:text(slot.get(key,''),1000,'时段安排') for key in ('plan','transport','reservation')}})
        clean.append(row)
    return clean


def blank_itinerary(days,destination):
    return [{'day':i,'destination':destination,'theme':'待安排','stops':[], 'transport':'','lunch':'','dinner':'','stay':'','pace':'',
             'slots':[{'period':period,'plan':'','transport':'','reservation':''} for period in PERIODS]} for i in range(1,days+1)]


def guide_itinerary(guide,render):
    """Read known generated HTML; unrecognized legacy prose stays as a reference."""
    result=blank_itinerary(guide['days'],guide['destination'])
    soup=BeautifulSoup(render(guide['body']),'html.parser')
    blocks=soup.select('.trip-day')
    for index,block in enumerate(blocks[:guide['days']]):
        row=result[index];heading=block.find(['h2','h3','h4'])
        if heading: row['theme']=re.sub(r'^D\d+\s*[·|｜:：-]?\s*','',heading.get_text(' ',strip=True))[:100]
        row['stops']=[re.sub(r'^\d+\s*[·.、]\s*','',node.get_text(' ',strip=True))[:120] for node in block.select('.trip-stop')][:20]
        table=block.select_one('.trip-table-wrap table')
        if table:
            for tr in table.select('tbody tr'):
                cells=[td.get_text(' ',strip=True) for td in tr.find_all(['th','td'])]
                if len(cells)>=4 and cells[0] in PERIODS:
                    row['slots'][PERIODS.index(cells[0])]={'period':cells[0],'plan':cells[1][:1000],'transport':cells[2][:1000],'reservation':cells[3][:1000]}
        for p in block.find_all('p'):
            value=p.get_text(' ',strip=True)
            for prefix,key in [('怎么走：','transport'),('午餐：','lunch'),('晚餐：','dinner')]:
                if value.startswith(prefix):row[key]=value[len(prefix):][:DAY_TEXT[key]]
            match=re.search(r'住宿 / 返程：\s*(.*?)\s*当天强度：\s*(.*)',value)
            if match:row['stay']=match[1][:500];row['pace']=match[2][:500]
    return result


def initial_checklist():
    return [{'id':secrets.token_hex(8),'kind':kind,'title':title,'note':'','done':False,'day':None,'plan_version':None}
            for kind,title in [('prepare','确认往返交通及到离时间'),('prepare','确认住宿或当天返程安排'),
                               ('prepare','出发前复核景点开放时间与预约'),('packing','证件和预约凭证'),
                               ('packing','手机、充电器及充电宝'),('packing','根据天气准备衣物与雨具')]]


def merge_reservations(items,itinerary,version):
    items=[dict(item) for item in items]
    keys={(item['day'],item['title']) for item in items}
    for day in itinerary:
        for slot in day['slots']:
            value=slot['reservation'].strip()
            if not value or re.match(r'^(?:无|暂无|无需|不需|未发现|待安排)',value):continue
            title=('D'+str(day['day'])+' '+slot['period']+'：'+value)[:200]
            if (day['day'],title) in keys:
                for item in items:
                    if item['day']==day['day'] and item['title']==title:item['plan_version']=version
                continue
            if len(items)>=150:break
            items.append({'id':secrets.token_hex(8),'kind':'reservation','title':title,'note':'根据方案整理，预约完成后再勾选',
                          'done':False,'day':day['day'],'plan_version':version})
            keys.add((day['day'],title))
    return items


def register(app,db,payload,audit,render):
    def trip_row(trip_id,lock=False):
        row=db().execute('SELECT * FROM trips WHERE id=%s'+(' FOR UPDATE' if lock else ''),(trip_id,)).fetchone()
        if not row:abort(404,description='这趟旅行不存在')
        return row

    def current_plan(trip_id):
        return db().execute('SELECT * FROM trip_plans WHERE trip_id=%s ORDER BY version DESC LIMIT 1',(trip_id,)).fetchone()

    def locked(trip_id,data):
        row=trip_row(trip_id,True)
        if data.get('revision')!=row['revision'] or type(data.get('revision')) is not int:
            abort(409,description='旅行已在其他页面更新，请刷新后再操作；本次输入未保存')
        return row

    def save_trip(row,**values):
        values.update(revision=row['revision']+1)
        args=[Jsonb(value) if key in ('checklist','progress') else value for key,value in values.items()]
        db().execute('UPDATE trips SET '+','.join(key+'=%s' for key in values)+',updated_at=now() WHERE id=%s',(*args,row['id']))
        return values['revision']

    def source(data):
        if not isinstance(data,dict):abort(400,description='请选择攻略来源')
        task_id=data.get('task_id');guide_id=data.get('guide_id')
        if (task_id is None)==(guide_id is None):abort(400,description='请选择一个攻略来源')
        conditions={};task=None;guide=None
        if task_id is not None:
            integer(task_id,10**18-1,'助手记录')
            task=db().execute("SELECT * FROM agent_tasks WHERE id=%s AND request->>'assistant'='travel'",(task_id,)).fetchone()
            if not task:abort(404,description='旅游助手记录不存在')
            if task['status']!='done' or not isinstance(task['report'].get('travel_guide'),dict):abort(409,description='请等待攻略生成完成后再采用')
            guide=dict(task['report']['travel_guide']);conditions=task['request'].get('trip',{})
            integer(guide.get('days'),30,'采用攻略的天数')
            if not isinstance(guide.get('body'),str) or len(guide['body'])>100000:abort(400,description='来源攻略内容格式不正确')
            stamp=task['updated_at'].isoformat()
            names=destinations(guide) or [guide.get('destination','')]
            selected=data.get('destination') or (names[0] if len(names)==1 else '')
            if selected not in names:abort(400,description='请先选择要采用的候选目的地')
            itinerary=[item for item in guide.get('itinerary',[]) if item.get('destination')==selected]
            if len(names)>1:
                try:guide=next(g for g in split_guides(guide,conditions,render) if g['destination']==selected)
                except (ValueError,StopIteration) as error:abort(409,description=str(error) or '请先补齐候选地的独立攻略')
            if not itinerary:itinerary=guide_itinerary(guide,render)
        else:
            integer(guide_id,10**18-1,'攻略')
            guide=db().execute('SELECT * FROM guides WHERE id=%s AND deleted_at IS NULL',(guide_id,)).fetchone()
            if not guide:abort(404,description='攻略不存在或已移入回收站')
            stamp=guide['updated_at'].isoformat();selected=guide['destination'];names=[selected]
            itinerary=guide_itinerary(guide,render)
        if data.get('updated_at') and data['updated_at']!=stamp:abort(409,description='来源攻略已更新，请重新打开采用页面')
        days=integer(guide.get('days'),30,'采用攻略的天数')
        selected=text(selected,80,'目的地',True)
        itinerary=normalize_itinerary(itinerary,days,selected)
        snapshot={key:text(guide.get(key,''),limit,'来源攻略内容') for key,limit in {'title':100,'summary':300,'budget':120,'season':120,'country':50,'sources':5000}.items()}
        snapshot.update(destination=selected,days=days,itinerary=itinerary,conditions=conditions,
                        reference_body=guide.get('body',''),source_updated_at=stamp)
        if len(snapshot['reference_body'])>100000:abort(400,description='来源攻略过长，请先整理')
        return snapshot,guide_id,task_id,names

    def meta(data,defaults=None,days=4):
        defaults=defaults or {}
        value={**defaults,**data}
        destination=text(value.get('destination',''),80,'目的地',True)
        start=iso_date(value.get('start_date'))
        end=iso_date(value['end_date']) if value.get('end_date') else start+timedelta(days=days-1)
        if not 0<=(end-start).days<30:abort(400,description='旅行日期需要在 1～30 天以内')
        return {'title':text(value.get('title',''),100,'旅行名称') or (destination+' · '+start.strftime('%m月%d日')+'出发'),
                'destination':destination,'start_date':start,'end_date':end,'people':integer(value.get('people',1),50,'人数'),
                **{key:text(value.get(key,''),limit,'旅行备注') for key,limit in {'companions':300,'lodging':2000,'transport':2000,'notes':4000}.items()},
                'state':value.get('state','active')}

    def add_plan(row,snapshot,guide_id=None,task_id=None,label='采用攻略'):
        if snapshot['days']!=(row['end_date']-row['start_date']).days+1:
            abort(400,description='方案天数与本次日期不一致，请调整日期或采用对应天数的方案')
        previous=current_plan(row['id']);version=previous['version']+1 if previous else 1
        db().execute('INSERT INTO trip_plans(trip_id,version,label,source_guide_id,source_task_id,snapshot) VALUES(%s,%s,%s,%s,%s,%s)',
                     (row['id'],version,label,guide_id,task_id,Jsonb(snapshot)))
        progress=dict(row['progress'])
        if previous:
            old_days={day['day']:day for day in previous['snapshot']['itinerary']}
            for day in snapshot['itinerary']:
                old_stops=old_days.get(day['day'],{}).get('stops',[])
                for index,stop in enumerate(day['stops']):
                    if old_stops.count(stop)!=1:continue
                    old_key=f"{previous['version']}:{day['day']}:{old_stops.index(stop)}"
                    if old_key in progress:progress[f"{version}:{day['day']}:{index}"]=progress[old_key]
        return version,merge_reservations(row['checklist'],snapshot['itinerary'],version),progress

    @app.get('/api/admin/trips')
    def trips():
        day=today();page=request.args.get('page','1');q=request.args.get('q','').strip();state=request.args.get('state','')
        if not page.isascii() or not page.isdigit() or len(page)>6 or int(page)<1 or len(q)>120 or state not in ('','active','archived'):
            abort(400,description='旅行筛选条件不正确')
        where=[];params=[]
        if q:where.append('(title ILIKE %s OR destination ILIKE %s)');params.extend(['%'+q+'%']*2)
        if state:where.append('state=%s');params.append(state)
        condition=' WHERE '+' AND '.join(where) if where else ''
        total=db().execute('SELECT count(*) n FROM trips'+condition,params).fetchone()['n']
        pages=max(1,(total+11)//12);page=min(int(page),pages)
        rows=db().execute('SELECT id,title,destination,start_date,end_date,people,state,revision,updated_at,'
            '(SELECT max(version) FROM trip_plans WHERE trip_id=trips.id) AS plan_version FROM trips'+condition+
            " ORDER BY CASE WHEN state='archived' THEN 3 WHEN start_date<=%s AND end_date>=%s THEN 0 WHEN start_date>%s THEN 1 ELSE 2 END,start_date,id DESC LIMIT 12 OFFSET %s",
            (*params,day,day,day,(page-1)*12)).fetchall()
        return jsonify(trips=[summary(row,day) for row in rows],total=total,page=page,pages=pages,focus=overview(db))

    @app.get('/api/admin/trips/source')
    def trip_source():
        data={key:int(value) if key in ('task_id','guide_id') and value.isascii() and value.isdigit() and len(value)<19 else value for key,value in request.args.items()}
        plan,guide_id,task_id,names=source(data)
        preview={key:value for key,value in plan.items() if key!='reference_body'}
        return jsonify(plan=preview,source={'guide_id':guide_id,'task_id':task_id,'destination':plan['destination'],'updated_at':plan['source_updated_at']},destinations=names)

    @app.post('/api/admin/trips')
    def trip_create():
        data=payload();key=data.get('request_key')
        if key is not None and (not isinstance(key,str) or not re.fullmatch('[a-f0-9]{32}',key)):abort(400,description='提交标识不正确')
        db().execute('SELECT pg_advisory_xact_lock(74390515)')
        if key:
            existing=db().execute('SELECT id FROM trips WHERE create_key=%s',(key,)).fetchone()
            if existing:return jsonify(id=existing['id'],already_saved=True)
        plan=None;guide_id=None;task_id=None;defaults={}
        if data.get('source') is not None:
            plan,guide_id,task_id,_=source(data['source']);defaults={'destination':plan['destination'],**{k:v for k,v in plan['conditions'].items() if k in ('people','companions')}}
        values=meta(data,defaults,plan['days'] if plan else 4)
        if values['state'] not in ('active','archived'):abort(400,description='请选择有效的旅行状态')
        if plan and values['destination']!=plan['destination']:abort(400,description='本次目的地需要与所采用的方案一致')
        values.update(checklist=Jsonb(initial_checklist()),created_by=session['admin_id'],create_key=key)
        row=db().execute('INSERT INTO trips('+','.join(values)+') VALUES('+','.join('%s' for _ in values)+') RETURNING *',list(values.values())).fetchone()
        if plan:
            version,items,progress=add_plan(row,plan,guide_id,task_id)
            db().execute('UPDATE trips SET checklist=%s WHERE id=%s',(Jsonb(items),row['id']))
        audit('trip.create',row['id'],{'destination':row['destination'],'adopted':bool(plan)});db().commit()
        return jsonify(id=row['id'],already_saved=False),201

    @app.get('/api/admin/trips/<int:trip_id>')
    def trip_detail(trip_id):
        row=trip_row(trip_id);plan=current_plan(trip_id)
        if plan:plan={**plan,'snapshot':{key:value for key,value in plan['snapshot'].items() if key!='reference_body'}}
        versions=db().execute('SELECT version,label,created_at FROM trip_plans WHERE trip_id=%s ORDER BY version DESC LIMIT 30',(trip_id,)).fetchall()
        return jsonify(trip=summary(row),plan=plan,versions=versions)

    @app.put('/api/admin/trips/<int:trip_id>')
    def trip_update(trip_id):
        data=payload();row=locked(trip_id,data);defaults={key:row[key] for key in ('title','destination','people','companions','lodging','transport','notes','state')}
        defaults.update(start_date=row['start_date'].isoformat(),end_date=row['end_date'].isoformat())
        values=meta(data,defaults)
        if values['state'] not in ('active','archived'):abort(400,description='请选择有效的旅行状态')
        plan=current_plan(trip_id)
        if plan and (values['end_date']-values['start_date']).days+1!=plan['snapshot']['days']:
            abort(400,description='本次已有 '+str(plan['snapshot']['days'])+' 天计划，请保持天数一致；可以整体调整出发日期')
        if plan and values['destination']!=row['destination']:abort(400,description='已有计划的目的地请通过采用新方案修改')
        revision=save_trip(row,**values);audit('trip.update',trip_id);db().commit();return jsonify(ok=True,revision=revision,trip=summary(trip_row(trip_id)))

    @app.post('/api/admin/trips/<int:trip_id>/plan')
    def trip_plan(trip_id):
        data=payload();row=locked(trip_id,data)
        if 'restore_version' in data:
            version=integer(data['restore_version'],10**8,'计划版本')
            original=db().execute('SELECT * FROM trip_plans WHERE trip_id=%s AND version=%s',(trip_id,version)).fetchone()
            if not original:abort(404,description='计划版本不存在')
            snapshot=original['snapshot'];guide_id=original['source_guide_id'];task_id=original['source_task_id'];label='恢复第 '+str(version)+' 版'
        elif 'source' in data:
            snapshot,guide_id,task_id,_=source(data['source']);label='采用攻略'
        else:
            original=current_plan(trip_id)
            if original:
                snapshot=dict(original['snapshot']);guide_id=original['source_guide_id'];task_id=original['source_task_id']
            else:
                snapshot={'destination':row['destination'],'days':(row['end_date']-row['start_date']).days+1,'conditions':{'people':row['people']},'reference_body':''};guide_id=task_id=None
            snapshot['itinerary']=normalize_itinerary(data.get('itinerary'),snapshot['days'],snapshot['destination']);label='手动调整行程'
        version,items,progress=add_plan(row,snapshot,guide_id,task_id,label)
        revision=save_trip(row,checklist=items,progress=progress,destination=snapshot['destination'])
        audit('trip.plan',trip_id,{'version':version,'label':label});db().commit();return jsonify(ok=True,version=version,revision=revision)

    @app.get('/api/admin/trips/<int:trip_id>/plans/<int:version>')
    def trip_version(trip_id,version):
        trip_row(trip_id)
        plan=db().execute('SELECT * FROM trip_plans WHERE trip_id=%s AND version=%s',(trip_id,version)).fetchone()
        if not plan:abort(404,description='计划版本不存在')
        snapshot=plan['snapshot'];body=snapshot.get('reference_body','')
        return jsonify(plan={**plan,'snapshot':{key:value for key,value in snapshot.items() if key!='reference_body'}},html=render(body))

    @app.post('/api/admin/trips/<int:trip_id>/checklist')
    def trip_checklist(trip_id):
        data=payload();row=locked(trip_id,data);items=[dict(item) for item in row['checklist']]
        action=data.get('action');item=next((item for item in items if item['id']==data.get('id')),None)
        if action=='add':
            if len(items)>=150:abort(400,description='每趟旅行最多 150 条准备事项')
            kind=data.get('kind','prepare')
            if kind not in ('prepare','reservation','packing'):abort(400,description='准备事项分类不正确')
            item={'id':secrets.token_hex(8),'kind':kind,'title':text(data.get('title',''),200,'事项名称',True),
                  'note':text(data.get('note',''),500,'事项备注'),'done':False,'day':None,'plan_version':None};items.append(item)
        elif action in ('update','remove'):
            if not item:abort(404,description='准备事项不存在')
            if action=='remove':items.remove(item)
            else:
                if 'done' in data:
                    if type(data['done']) is not bool:abort(400,description='完成状态格式不正确')
                    item['done']=data['done']
                for key,limit in [('title',200),('note',500)]:
                    if key in data:item[key]=text(data[key],limit,'事项内容',key=='title')
        else:abort(400,description='准备事项操作不正确')
        revision=save_trip(row,checklist=items);audit('trip.checklist',trip_id,{'action':action});db().commit()
        return jsonify(checklist=items,revision=revision)

    @app.post('/api/admin/trips/<int:trip_id>/progress')
    def trip_progress(trip_id):
        data=payload();row=locked(trip_id,data);plan=current_plan(trip_id)
        if not plan:abort(409,description='请先采用或填写旅行计划')
        if type(data.get('plan_version')) is not int or data.get('plan_version')!=plan['version']:abort(409,description='行程已更新，请刷新后再标记')
        day=integer(data.get('day'),len(plan['snapshot']['itinerary']),'旅行日')
        stops=plan['snapshot']['itinerary'][day-1]['stops'];index=integer(data.get('index'),len(stops)-1,'路线地点',0)
        status=data.get('status')
        if status not in ('','done','skipped'):abort(400,description='游玩状态不正确')
        progress=dict(row['progress']);key=str(plan['version'])+':'+str(day)+':'+str(index)
        if status:progress[key]=status
        else:progress.pop(key,None)
        revision=save_trip(row,progress=progress);db().commit();return jsonify(progress=progress,revision=revision)
