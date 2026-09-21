"""Split completed visual comparisons without asking a model to rewrite facts."""
import re
from html import escape
from bs4 import BeautifulSoup


def destinations(guide):
    return list(dict.fromkeys(day.get('destination') for day in guide.get('itinerary', [])
                              if isinstance(day, dict) and isinstance(day.get('destination'), str)))


def split_guides(guide, trip, render):
    names = destinations(guide)
    if not 2 <= len(names) <= 4:
        raise ValueError('需要包含 2～4 个候选地的完整逐日路线，才能拆分发布')
    # Some older model results used full-width separators inside Markdown tables.
    body = '\n'.join(line.replace('｜', '|') if line.lstrip().startswith('|') else line
                     for line in guide['body'].splitlines())
    soup = BeautifulSoup(render(body), 'html.parser')
    days = soup.select('.trip-day')
    itinerary = guide['itinerary']
    overview = soup.select_one('.trip-table-wrap table')
    rows = overview.select('tbody > tr') if overview else []
    if len(days) != len(itinerary) or len(rows) != len(itinerary):
        raise ValueError('原攻略缺少完整图文路线，请先让助手按目的地补齐后再拆分')

    def owner(text):
        matches = [name for name in names if name in text]
        return matches[0] if len(matches) == 1 else None

    chapters = {}
    for heading in soup.find_all('h2', recursive=False):
        name = owner(heading.get_text())
        if name:
            if name in chapters:
                raise ValueError('同一候选地存在多个章节，请先整理为每个目的地一个独立章节')
            nodes = []
            for node in heading.next_siblings:
                if getattr(node, 'name', None) == 'h2': break
                nodes.append(str(node))
            chapters[name] = (heading.get_text(), ''.join(nodes))
    if set(chapters) != set(names):
        raise ValueError('住宿、预算等还混在一起。请继续要求助手：每个候选地用一个二级标题单独整理住宿、预算、预约和天气，再点击拆分发布。')
    grids = soup.select('.trip-grid')
    if len(grids) != 2:
        raise ValueError('景点或美食图文不完整，请先补齐后再拆分')
    cards = {}
    for field, grid in zip(('highlights', 'foods'), grids):
        nodes = grid.select(':scope > .trip-card')
        items = guide.get(field, [])
        if len(nodes) != len(items) or any(not owner(item['name']) for item in items):
            raise ValueError('景点或美食未明确所属候选地，请先补充城市名称')
        cards[field] = list(zip(items, nodes))

    result = []
    for name in names:
        indices = [i for i, day in enumerate(itinerary) if day['destination'] == name]
        if [itinerary[i]['day'] for i in indices] != list(range(1, guide['days'] + 1)):
            raise ValueError(name + '的每日路线不完整，暂不能发布')
        heading, practical = chapters[name]
        title = re.sub(r'^(?:文档|第)[一二三四五六七八九十0-9]+[章节篇]?\s*[｜|：:·、. -]*', '', heading).strip()[:100]
        selected = {field: [(item, node) for item, node in pairs if owner(item['name']) == name]
                    for field, pairs in cards.items()}
        if not selected['highlights'] or not selected['foods']:
            raise ValueError(name + '缺少景点或美食介绍，请补齐后再拆分')
        summary = (name + ' · ' + '；'.join(item['description'] for item, _ in selected['highlights']))[:300]
        conditions = ' · '.join(str(x) for x in (trip.get('dates'), str(guide['days'])+' 天',
                                    str(trip.get('people', 1))+' 人', trip.get('rooms')) if x)
        overview_html = '<h2>行程一览</h2><div class="trip-table-wrap"><table>' + str(overview.thead) + '<tbody>' + ''.join(str(rows[i]) for i in indices) + '</tbody></table></div>'
        blocks = ['<p>'+escape(conditions)+'</p>', overview_html]
        for field, label in (('highlights', '值得停留的风景与人文'), ('foods', '这一站，吃什么')):
            blocks.append('<h2>'+label+'</h2><div class="trip-grid">'+''.join(str(node) for _, node in selected[field])+'</div>')
            if field == 'highlights':
                blocks.append('<h2>每天怎么走</h2>'+''.join(str(days[i]) for i in indices))
        blocks += ['<h2>住宿、预算与出行准备</h2>'+practical,
                   '<p>攻略参考：价格、预约、交通和房态请在出发前复查。照片为资料参考，不代表出行当天景况。</p>']
        final = '\n\n'.join(blocks)
        image = next((node.select_one('img') for _, node in selected['highlights'] if node.select_one('img')), None)
        cover = image.get('src', '').split('?')[0] if image else '/static/assets/lake.jpg'
        links = {}
        for link in BeautifulSoup(practical, 'html.parser').select('a[href]'):
            if link['href'].startswith(('https://', 'http://')): links[link['href']] = link.get_text()
        # Keep inline citations from card text as well as practical chapters.
        for field in selected.values():
            for item, _ in field:
                for label, url in re.findall(r'\[([^\]]+)\]\((https?://[^\s)]+)\)', ' '.join(item.values())):
                    links[url] = label
        result.append({**{key: guide.get(key, '') for key in ('country', 'days', 'season')},
                       'title': title, 'destination': name, 'summary': summary, 'body': final,
                       'budget': '详见本篇预算表（参考估算）', 'cover': cover,
                       'sources': '\n'.join('['+label+']('+url+')' for url, label in links.items())[:5000]})
    return result
