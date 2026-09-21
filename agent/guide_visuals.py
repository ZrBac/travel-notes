"""Deterministic guide cards; model text is escaped, only cached local pictures render."""
from html import escape
import re
from urllib.parse import urlsplit

TEMPLATES = {'auto':'智能图文攻略', 'culture':'人文城市漫游', 'nature':'山水自然轻游', 'food':'美食街区打卡'}

def compose(guide, photos):
    def text(value): return escape(str(value),quote=True)
    def inline(value):
        value=str(value);parts=[];last=0
        for m in re.finditer(r'\[([^\]]+)\]\((https?://[^\s)]+)\)',value):
            parts.append(text(value[last:m.start()]));url=m[2]
            try: valid=urlsplit(url).scheme in ('http','https') and bool(urlsplit(url).hostname) and not urlsplit(url).username
            except ValueError: valid=False
            parts.append('<a href="'+text(url)+'">'+text(m[1])+'</a>' if valid else text(m[1]));last=m.end()
        parts.append(text(value[last:]));return ''.join(parts)
    def picture(key):
        p=photos.get(key)
        if not p: return ''
        if not re.fullmatch(r'/media/[a-f0-9]{32}\.webp',p.get('url','')): return ''
        source=p.get('source','');license_url=p.get('license_url','')
        try:
            for url,hosts in ((source,('commons.wikimedia.org',)),(license_url,('creativecommons.org','commons.wikimedia.org'))):
                parsed=urlsplit(url)
                if parsed.scheme!='https' or parsed.hostname not in hosts or parsed.username or parsed.password or parsed.port not in (None,443):return ''
        except ValueError:return ''
        field,index=key.split('-');subject=guide[field][int(index)]['name']
        caption=p.get('caption') or ('菜品资料示意；不代表指定门店实拍' if field=='foods' else '景点资料照片；不代表出行当天景况')
        return '<figure class="trip-photo"><img src="'+text(p['url'])+'" alt="'+text(subject)+'"><figcaption>'+text(caption)+' · '+text(p['author'])+' · <a href="'+text(license_url)+'">'+text(p['license'])+'</a> · <a href="'+text(source)+'">图片来源</a> · 已缩放压缩</figcaption></figure>'
    groups=[]
    for field,label in [('highlights','值得停留的风景与人文'),('foods','这一站，吃什么')]:
        cards=[]
        for i,item in enumerate(guide.get(field,[])):
            extra = [('体验',item['experience']),('停留',item['duration']),('出行提示',item['tip'])] if field=='highlights' else [('去哪里找',item['area']),('参考花费',item['price']),('点餐提示',item['tip'])]
            rows=''.join('<p><strong>'+k+'：</strong>'+inline(v)+'</p>' for k,v in extra if v)
            cards.append('<div class="trip-card">'+picture(f'{field}-{i}')+'<div class="trip-card-copy"><h3>'+text(item['name'])+'</h3><p>'+inline(item['description'])+'</p>'+rows+'</div></div>')
        if cards:groups.append('<h2>'+label+'</h2>\n\n<div class="trip-grid">'+''.join(cards)+'</div>')
    if guide.get('template')=='food': groups.reverse()
    if guide.get('template')=='auto':
        summary='<div class="trip-overview"><p><strong>这趟旅行怎么安排</strong></p><p>'+text(guide['planning_summary'])+'</p></div>'
        rows=[];daily=[]
        for day in guide['itinerary']:
            title='D'+str(day['day'])+' · '+day['destination']+'｜'+day['theme']
            route='<span class="trip-arrow">→</span>'.join('<span class="trip-stop">'+str(i+1)+' · '+text(stop)+'</span>' for i,stop in enumerate(day['stops']))
            rows.append('<tr><th>'+text('D'+str(day['day'])+' · '+day['destination'])+'</th><td><strong>'+text(day['theme'])+'</strong><br>'+text(' → '.join(day['stops']))+'</td><td>'+text(day['stay'])+'</td><td>'+text(day['pace'])+'</td></tr>')
            slots=''.join('<tr><th>'+text(slot['period'])+'</th><td>'+text(slot['plan'])+'</td><td>'+text(slot['transport'])+'</td><td>'+text(slot['reservation'])+'</td></tr>' for slot in day['slots'])
            daily.append('<div class="trip-day"><h3>'+text(title)+'</h3><div class="trip-route">'+route+'</div><p><strong>怎么走：</strong>'+text(day['transport'])+'</p><div class="trip-table-wrap"><table><thead><tr><th>时段</th><th>地点与体验</th><th>交通与预计耗时</th><th>预约与提醒</th></tr></thead><tbody>'+slots+'</tbody></table></div><div class="trip-meals"><p><strong>午餐：</strong>'+text(day['lunch'])+'</p><p><strong>晚餐：</strong>'+text(day['dinner'])+'</p></div><p><strong>住宿 / 返程：</strong>'+text(day['stay'])+'<br><strong>当天强度：</strong>'+text(day['pace'])+'</p></div>')
        overview='<h2>行程一览</h2><div class="trip-table-wrap"><table><thead><tr><th>天数 / 目的地</th><th>主题与游玩顺序</th><th>住宿 / 返程</th><th>节奏与体力</th></tr></thead><tbody>'+''.join(rows)+'</tbody></table></div>'
        note='<p>照片为资料参考，不代表出行当天景况；美食图片为菜品示意。交通耗时和费用请结合实际日期复查。</p>'
        return '\n\n'.join([summary,overview,groups[0] if groups else '', '<h2>每天怎么走</h2>'+''.join(daily),groups[1] if len(groups)>1 else '',guide['body'],note])
    prefix='<div class="trip-overview"><p class="trip-kicker">行笺 · '+text(TEMPLATES.get(guide.get('template'),'图文旅行手册'))+'</p><p>先看特色，再看日程。照片为资料参考，不代表出行当天景况；美食图片为菜品示意，不代表指定门店出品。</p></div>'
    return '\n\n'.join([prefix,*groups,guide['body']]) if groups else guide['body']
