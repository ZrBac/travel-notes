"""Bounded, offline parsing of uploaded travel HTML and optional ZIP assets."""
import base64
import binascii
import hashlib
import io
import json
import posixpath
import re
import secrets
import stat
import zipfile
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

from bs4 import BeautifulSoup, Comment
from markdownify import MarkdownConverter
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD = 8 * 1024 * 1024
MAX_EXPANDED = 24 * 1024 * 1024
MAX_IMAGES = 60
STATIC_HANDBOOK_CSP = (
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; "
    "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; "
    "form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox"
)


class ImportProblem(ValueError):
    pass


def decode_html(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        encodings = ['utf-16']
    else:
        declared = re.search(br'charset\s*=\s*[\'\"]?([\w-]+)', raw[:4096], re.I)
        encoding = declared.group(1).decode('ascii').lower() if declared else ''
        encodings = ['utf-8-sig'] + (['gb18030'] if encoding in ('gbk','gb2312','gb18030') else []) + ['gb18030']
    for encoding in dict.fromkeys(encodings):
        try:
            text = raw.decode(encoding)
            if '\x00' not in text:
                return text, encoding
        except UnicodeError:
            pass
    raise ImportProblem('文件编码无法识别，请将 HTML 另存为 UTF-8 后上传。')


def unpack(raw, filename):
    if not raw or len(raw) > MAX_UPLOAD:
        raise ImportProblem('请选择非空文件，HTML 或 ZIP 最大 8 MB。')
    suffix = PurePosixPath(filename.lower()).suffix
    if suffix in ('.html', '.htm'):
        return raw, PurePosixPath(filename).name, {}
    if suffix != '.zip':
        raise ImportProblem('仅支持 .html、.htm 或包含一份 HTML 的 .zip 文件。')
    assets = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > 200 or sum(i.file_size for i in entries) > MAX_EXPANDED:
                raise ImportProblem('ZIP 最多 200 个文件，解压后总大小不能超过 24 MB。')
            for item in entries:
                name = item.filename
                parts = PurePosixPath(name).parts
                if '\\' in name or '\x00' in name or name.startswith('/') or '..' in parts or re.match(r'^[A-Za-z]:', name):
                    raise ImportProblem('ZIP 包含不支持的文件路径，请重新打包 HTML 和图片文件夹。')
                if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
                    raise ImportProblem('不支持带密码或包含符号链接的 ZIP。')
                if item.is_dir() or '__MACOSX' in parts or PurePosixPath(name).name.startswith('.'):
                    continue
                name = posixpath.normpath(name)
                if name in assets or item.file_size > MAX_UPLOAD:
                    raise ImportProblem('ZIP 有重名文件或单个文件超过 8 MB。')
                with archive.open(item) as source:
                    data = source.read(MAX_UPLOAD + 1)
                if len(data) > MAX_UPLOAD:
                    raise ImportProblem('ZIP 内单个文件超过 8 MB。')
                assets[name] = data
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, OSError) as exc:
        raise ImportProblem('ZIP 无法读取，请使用普通 ZIP 格式重新打包。') from exc
    pages = [n for n in assets if PurePosixPath(n.lower()).suffix in ('.html', '.htm')]
    if len(pages) != 1:
        raise ImportProblem('每次导入一篇攻略：ZIP 内需要且只能有一份 HTML，其他文件可为图片和样式。')
    name = pages[0]
    return assets[name], name, assets


def local_asset(url, page, assets):
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme or parsed.netloc or '\\' in url or url.startswith('/'):
        return None
    key = posixpath.normpath(posixpath.join(posixpath.dirname(page), unquote(parsed.path)))
    if key == '..' or key.startswith('../'):
        return None
    return assets.get(key)


def web_url(url):
    if len(url) > 3000 or re.search(r'[\x00-\x20\x7f\\]', url):
        return False
    try:
        parsed = urlsplit(url)
        return parsed.scheme.lower() in ('http', 'https') and bool(parsed.hostname) and not parsed.username and not parsed.password
    except ValueError:
        return False


def chinese_number(value):
    if value.isdigit():
        return int(value)
    digits = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}
    if value == '十': return 10
    if '十' in value:
        first, last = value.split('十', 1)
        return digits.get(first, 1) * 10 + digits.get(last, 0)
    return digits.get(value, 0)


def metadata(soup, filename):
    metas = {}
    for item in soup.find_all('meta'):
        name = str(item.get('name') or item.get('property') or '').lower()
        metas[name] = str(item.get('content', '')).strip()
    h1 = soup.find('h1')
    title = metas.get('travel:title') or (h1.get_text(' ', strip=True) if h1 else '') or metas.get('og:title') or (soup.title.get_text(' ', strip=True) if soup.title else '') or PurePosixPath(filename).stem
    title = re.sub(r'\s+', ' ', title).strip()[:100]
    text = soup.get_text('\n', strip=True)
    def labeled(labels, limit):
        match = re.search(r'(?:^|\n)\s*(?:'+labels+r')\s*[:：]\s*([^\n]+)', text)
        return match.group(1).strip()[:limit] if match else ''
    destination = metas.get('travel:destination') or labeled('目的地|旅行目的地',80)
    if not destination:
        prefix = re.split(r'[|｜·]|[0-9一二两三四五六七八九十]+\s*[天日]', title)[0]
        prefix = re.sub(r'^\s*(?:20\d{2}\s*年?\s*)?', '', prefix)
        prefix = re.sub(r'(?:旅行|旅游)?(?:攻略|手册|行程|之旅).*$', '', prefix).strip(' ·：:-')
        if 1 <= len(prefix) <= 25 and prefix not in ('旅行','旅游','出游','行程','我的','秋游','春游'):
            destination = prefix
    days = chinese_number(metas.get('travel:days',''))
    if not days:
        match = re.search(r'([0-9一二两三四五六七八九十]{1,3})\s*[天日](?:[0-9一二两三四五六七八九十]{1,3}晚)?',title)
        days = chinese_number(match.group(1)) if match else 0
    if not days:
        headings = ' '.join(h.get_text(' ',strip=True) for h in soup.find_all(re.compile('^h[1-6]$')))
        numbers = [int(n) for n in re.findall(r'\b(?:Day\s*|D)(\d{1,3})\b',headings,re.I)]
        numbers += [chinese_number(n) for n in re.findall(r'第([0-9一二两三四五六七八九十]{1,3})天',headings)]
        days = max(numbers, default=1)
    summary = metas.get('travel:summary') or metas.get('description') or metas.get('og:description') or ''
    if not summary:
        summary = next((p.get_text(' ',strip=True) for p in soup.find_all('p') if len(p.get_text(strip=True)) >= 20), '')
    tags = re.split(r'[,，;；\n]+', metas.get('travel:tags') or metas.get('keywords',''))
    return dict(title=title,destination=destination[:80],country=(metas.get('travel:country') or labeled('国家|国家／地区|国家/地区',50))[:50],summary=summary[:300],days=min(365,max(1,days)),
                season=(metas.get('travel:season') or labeled('出行日期|旅行日期|适合季节|日期',60))[:60],budget=(metas.get('travel:budget') or labeled('人均预算|人均费用|预算',60))[:60],
                tags=list(dict.fromkeys(t.strip()[:24] for t in tags if t.strip()))[:12],status='draft',sample=False,verified_at='',category_id=None)


class GuideConverter(MarkdownConverter):
    def convert_a(self, el, text, parent_tags):
        # Fragment links would replace the site's hash router; retain their label.
        if str(el.get('href','')).startswith('#'):
            return text
        return super().convert_a(el,text,parent_tags)

    def convert_img(self, el, text, parent_tags):
        return '\n\n'+super().convert_img(el,text,parent_tags)+'\n\n'

    def convert_details(self, el, text, parent_tags):
        return '\n\n'+text.strip()+'\n\n'

    def convert_summary(self, el, text, parent_tags):
        return '\n\n**'+text.strip()+'**\n\n'

    def convert_span(self, el, text, parent_tags):
        # CSS badges and adjacent spans have visual gaps which disappear in plain text.
        return ' '+text+' ' if text.strip() else text


def parse_upload(raw, filename, directory):
    source, page, assets = unpack(raw, filename)
    text, encoding = decode_html(source)
    text = re.sub(r'^\s*```(?:html)?\s*\n([\s\S]*?)\n```\s*$', r'\1', text, flags=re.I)
    if not re.search(r'<(?:html|body|main|article|section|div|h[1-6]|p|table)\b', text, re.I):
        raise ImportProblem('没有找到 HTML 攻略正文，请上传网页文件而不是截图或纯文本。')
    soup = BeautifulSoup(text,'html.parser')
    count = 0
    for node in soup.descendants:
        count += 1
        if count > 40000:
            raise ImportProblem('HTML 结构过大，请按单篇攻略拆分。')
    for node in soup.find_all(True):
        if sum(1 for _ in node.parents) > 100:
            raise ImportProblem('HTML 嵌套过深，请简化页面结构后导入。')
    info = metadata(soup,page)
    warnings = []
    removed_scripts = len(soup.find_all('script'))
    for node in list(soup.find_all(string=lambda s:isinstance(s,Comment))): node.extract()
    for node in list(soup.find_all(['script','iframe','object','embed','base','noscript','template'])):
        node.decompose()
    if removed_scripts:
        warnings.append('原文含交互脚本：保存静态内容，脚本不会执行；原始上传文件仍可下载。')
    for node in list(soup.find_all(['svg','canvas','video','audio'])):
        label = node.get('aria-label') or node.get('title') or '动态图形或多媒体'
        p = soup.new_tag('p');p.string = '［'+str(label)[:100]+'：请下载源文件查看］';node.replace_with(p)
        if '动态图形和多媒体仅保留说明，原文件可下载查看。' not in warnings:
            warnings.append('动态图形和多媒体仅保留说明，原文件可下载查看。')
    for node in list(soup.find_all('link')):
        if 'stylesheet' in node.get('rel',[]):
            css = local_asset(str(node.get('href','')),page,assets)
            if css is not None and len(css) <= 300000:
                css_text,_ = decode_html(css)
                style = soup.new_tag('style');style.string = css_text;node.replace_with(style)
                continue
            if '外部样式未载入，网站阅读版会使用统一排版。' not in warnings:
                warnings.append('外部样式未载入，网站阅读版会使用统一排版。')
        node.decompose()
    for node in list(soup.find_all('meta')): node.decompose()
    if any(re.search(r'url\s*\(|@import',node.get_text() if node.name=='style' else str(node.get('style','')),re.I) for node in soup.find_all(True)):
        warnings.append('CSS 背景图片和外部字体不在正文配图中；需要保存的照片请使用 img 标签和本地或内嵌图片。')
    for node in list(soup.find_all('form')): node.unwrap()
    for node in list(soup.find_all(['input','textarea','select','button'])):
        if node.name == 'input': value = str(node.get('value','')) if node.get('type') != 'password' else ''
        elif node.name == 'select':
            selected = node.find('option',selected=True) or node.find('option')
            value = selected.get_text(' ',strip=True) if selected else ''
        elif node.name == 'button': value = ''
        else: value = node.get_text(' ',strip=True)
        node.replace_with(soup.new_string(value))

    pictures = []
    by_hash = {}
    failed_images = 0
    links = []
    for img in list(soup.find_all('img')):
        url = str(img.get('src') or img.get('data-src') or '').strip()
        alt = str(img.get('alt') or '攻略图片')[:150]
        image_bytes = None
        if url.lower().startswith('data:'):
            match = re.fullmatch(r'data:image/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)',url,re.I)
            if match:
                try: image_bytes = base64.b64decode(re.sub(r'\s+','',match.group(1)),validate=True)
                except (ValueError,binascii.Error): pass
        else:
            image_bytes = local_asset(url,page,assets)
        try:
            if not image_bytes or len(image_bytes) > MAX_UPLOAD: raise ValueError('missing image')
            digest = hashlib.sha256(image_bytes).hexdigest()
            record = by_hash.get(digest)
            if not record:
                if len(pictures) >= MAX_IMAGES: raise ImportProblem('一篇攻略最多导入 60 张不同图片，请分篇存档。')
                with Image.open(io.BytesIO(image_bytes)) as original:
                    if original.width*original.height > 25_000_000: raise ValueError('image too large')
                    picture = ImageOps.exif_transpose(original).convert('RGB')
                    picture.thumbnail((1600,1600))
                    name = secrets.token_hex(16)+'.webp'
                    target = directory/name
                    picture.save(target,'WEBP',quality=80,method=4)
                    target.chmod(0o640)
                    record = dict(filename=name,name=alt,bytes=target.stat().st_size,width=picture.width,height=picture.height)
                pictures.append(record);by_hash[digest]=record
            img.attrs = {'src':'/media/'+record['filename'],'alt':alt,'width':str(record['width']),'height':str(record['height']),'loading':'lazy','decoding':'async'}
        except ImportProblem:
            raise
        except (ValueError,OSError,UnidentifiedImageError,Image.DecompressionBombError):
            failed_images += 1
            replacement = soup.new_tag('p')
            if web_url(url):
                anchor = soup.new_tag('a',href=url);anchor.string=alt+'（外链图片，未存入本站）';replacement.append(anchor)
            else: replacement.string = '［'+alt+'：未找到可导入的图片，请补充上传］'
            img.replace_with(replacement)
    if failed_images:
        warnings.append(f'{failed_images} 处图片未能本地保存：网络图片保留来源链接；本地图片请和 HTML 一起打包 ZIP 上传，也可导入后补图。')

    safe_tags = set('html head title body style main article section header footer nav aside div span p br hr h1 h2 h3 h4 h5 h6 strong em b i u s small mark sup sub ul ol li dl dt dd blockquote pre code table thead tbody tfoot tr th td caption colgroup col a img figure figcaption details summary'.split())
    safe_attrs = {'class','id','style','title','lang','dir','colspan','rowspan','align','width','height','scope','start','open','aria-label','role','loading','decoding'}
    for node in list(soup.find_all(True)):
        if node.name not in safe_tags:
            node.unwrap();continue
        for attr in list(node.attrs):
            if attr not in safe_attrs and not (node.name=='img' and attr in ('src','alt')) and not (node.name=='a' and attr=='href'):
                del node[attr]
        if node.name=='a':
            href = str(node.get('href','')).strip()
            if web_url(href):
                if href not in links: links.append(href)
                node['rel']='noopener noreferrer';node['target']='_blank'
            elif re.fullmatch(r'#[\w\-:.\u4e00-\u9fff]+',href): node['href']=href
            else: node.attrs.pop('href',None)
    # Both online and downloaded snapshots use UTF-8, regardless of source encoding.
    snapshot_head = soup.head
    if snapshot_head is None:
        snapshot_head = soup.new_tag('head')
        (soup.html or soup).insert(0,snapshot_head)
    snapshot_head.insert(0,soup.new_tag('meta',charset='utf-8'))
    snapshot_head.insert(1,soup.new_tag('meta',attrs={'name':'viewport','content':'width=device-width, initial-scale=1'}))
    # Keep static layout as a separate snapshot; its stricter CSP also blocks CSS network requests.
    snapshot = str(soup)
    snapshot = '<!doctype html>\n'+snapshot
    # The reading copy deliberately omits navigation and display-only styles.
    for node in list(soup.select('head, style, nav, [role="navigation"], .toc, .nav')): node.decompose()
    first_heading=soup.find('h1')
    if first_heading and re.sub(r'\s+',' ',first_heading.get_text(' ',strip=True)).strip()==info['title']:
        first_heading.decompose()
    for node in soup.find_all('h1'): node.name='h2'
    for node in soup.find_all(['h5','h6']): node.name='h4'
    for node in soup.find_all('details'): node.attrs['open']=''
    container = soup.body or soup
    body = GuideConverter(heading_style='ATX',bullets='-',escape_misc=True,keep_inline_images_in=['td','th','h1','h2','h3'],table_infer_header=True).convert_soup(container).strip()
    if not body or len(soup.get_text(strip=True)) < 3:
        raise ImportProblem('没有解析到可存档的正文，页面可能完全依靠脚本生成；请让 GPT 输出直接含正文的静态 HTML。')
    if len(body) > 98000:
        raise ImportProblem('解析后的正文超过 98,000 字符，请拆成多篇攻略。')
    info.update(body=body,cover='/media/'+pictures[0]['filename'] if pictures else '/static/assets/lake.jpg',sources=('导入文件：'+filename+'\n保留原文信息，未额外核实旅行资料。\n\n'+'\n'.join(links))[:5000])
    if not info['destination']: warnings.append('未识别到明确目的地，请在保存前填写。')
    return dict(guide=info,images=pictures,warnings=warnings,stats=dict(images=len(pictures),unresolved_images=failed_images,headings=len(soup.find_all(re.compile('^h[1-6]$'))),tables=len(soup.find_all('table')),characters=len(body)),snapshot=snapshot,encoding=encoding,html_filename=page,source_filename=filename,source_sha256=hashlib.sha256(raw).hexdigest())
