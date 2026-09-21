"""Bounded Commons photo acquisition, run as the unprivileged travelagent user."""
import io
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from html import unescape
from PIL import Image, ImageOps

ALLOWED={'commons.wikimedia.org','upload.wikimedia.org','thumb.wikimedia.org'}
MAX_BYTES=6*1024*1024
Image.MAX_IMAGE_PIXELS=16_000_000
MAX_PHOTOS=16
PHOTO_SECONDS=180
CATALOG=json.loads(Path(__file__).with_name('photo_catalog.json').read_text())

def check_url(url):
    p=urlsplit(url)
    if p.scheme!='https' or p.hostname not in ALLOWED or p.port not in (None,443) or p.username or p.password: raise ValueError('图片地址不在允许范围')
    return url

class Redirects(HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        check_url(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def fetch(url,limit=MAX_BYTES):
    check_url(url)
    with build_opener(Redirects()).open(Request(url,headers={'User-Agent':'XingjianTravel/1.0 (https://travel.example.com; travel reference photos)'}),timeout=10) as r:
        if int(r.headers.get('Content-Length','0'))>limit:raise ValueError('图片过大')
        chunks=[];size=0;start=time.monotonic()
        while True:
            part=r.read(min(65536,limit+1-size))
            if not part:break
            chunks.append(part);size+=len(part)
            if size>limit or time.monotonic()-start>20:raise ValueError('图片过大或读取超时')
        return b''.join(chunks)

def plain(value):return re.sub(r'\s+',' ',unescape(re.sub('<[^>]*>','',str(value)))).strip()[:500]


def photo_matches(query,title,description,food=False):
    """Search hits can match categories or sauce ingredients; require subject evidence."""
    if title in CATALOG['rejected_files']:return False
    if 'botanical' in query.lower() and re.search(r'flowers? and plants|热带花卉园',title+' '+description,re.I):return False
    aliases={'park':'garden','parks':'garden','gardens':'garden','sticky':'glutinous','glutinous':'glutinous','grilled':'grill','grilling':'grill'}
    def words(value):
        value=value.lower().replace('_',' ')
        # Fish sauce does not make a pork/chicken dish a photograph of fish.
        value=re.sub(r'\b(?:fish|oyster|soy)\s+sauce\b','sauce',value)
        tokens=re.findall(r'[a-z][a-z0-9]*',value)
        return {aliases.get(t,t[:-1] if len(t)>4 and t.endswith('s') and not t.endswith('ss') else t) for t in tokens if t not in {'the','of','in','at','and','a','an','with','by','to'}}
    wanted=words(query);actual=words(title+' '+description)
    if food:
        primary=words(re.split(r'\bwith\b|,',title,flags=re.I)[0]+' '+re.split(r'\bwith\b|,',description,flags=re.I)[0])
        subjects=wanted & {'fish','pork','beef','chicken','duck','rice','noodle','salad','soup','bread','cake','dumpling','papaya','pineapple','tofu'}
        if subjects and not (subjects & primary):return False
    if not wanted:return query.strip().lower() in (title+' '+description).lower()
    return all(term in actual or (len(term)>=5 and any(word.startswith(term) for word in actual)) for term in wanted)

def curated_entry(item, food=False):
    """Only reuse a reviewed subject; a query alone cannot relabel a different dish."""
    item=item or {}
    name=re.split(r'[｜|]',item.get('name',''))[-1].strip()
    query=item.get('photo_query','').strip().casefold()
    owner=re.split(r'[｜|]',item.get('name',''))[0].strip()
    for entry in CATALOG['entries']:
        if entry['field']!=('foods' if food else 'highlights'):continue
        # Ambiguous names (e.g. 开元寺) additionally require the local query or city.
        if name in entry['names'] and (query in entry['queries'] or owner==entry['destination']):
            return entry
    return None


def candidates(query, title=None):
    params={'action':'query','prop':'imageinfo','iiprop':'url|extmetadata|mime','iiurlwidth':960,'format':'json'}
    if title:params['titles']='File:'+title
    else:params.update(generator='search',gsrsearch=query+' filetype:bitmap',gsrnamespace=6,gsrlimit=5)
    data=json.loads(fetch('https://commons.wikimedia.org/w/api.php?'+urlencode(params),1024*1024))
    return sorted(data.get('query',{}).get('pages',{}).values(),key=lambda p:p.get('index',999))


def lookup(query,out,food=False,item=None,excluded=()):
    entry=curated_entry(item,food)
    searches=[entry] if entry else []
    if query:searches.append(None)
    for known in searches:
      try:pages=candidates(query,known['file'] if known else None)
      except Exception:continue
      for p in pages:
        info=(p.get('imageinfo') or [{}])[0];meta=info.get('extmetadata',{})
        get=lambda k:plain(meta.get(k,{}).get('value',''))
        license_name=get('LicenseShortName');license_url=get('LicenseUrl')
        if license_url.startswith('//'):license_url='https:'+license_url
        license_url=license_url.replace('http://creativecommons.org/','https://creativecommons.org/')
        if not license_url and license_name in ('Public domain','CC0'):license_url='https://creativecommons.org/publicdomain/mark/1.0/'
        if not (re.fullmatch(r'CC BY(?:-SA)? (?:[1-4]\.0|2\.5)',license_name) or license_name in ('CC0','Public domain')):continue
        lic=urlsplit(license_url)
        if lic.scheme!='https' or lic.hostname not in ('creativecommons.org','commons.wikimedia.org') or lic.username or lic.password or lic.port not in (None,443):continue
        if info.get('mime') not in ('image/jpeg','image/png','image/webp'):continue
        title=p.get('title','').removeprefix('File:')
        if title in CATALOG['rejected_files']:continue
        if re.search(r'\b(map|logo|flag|icon|diagram)\b',title.replace('_',' '),re.I):continue
        if known:
            if title!=known['file']:continue
        elif not photo_matches(query,title,get('ImageDescription'),food=food):continue
        url=info.get('thumburl');source=info.get('descriptionurl','')
        if not url or not source.startswith('https://commons.wikimedia.org/') or source in excluded:continue
        try:
            raw=fetch(url)
            with Image.open(io.BytesIO(raw)) as im:
                if im.width*im.height>16_000_000 or min(im.size)<240:continue
                im.thumbnail((960,960))
                with ImageOps.exif_transpose(im).convert('RGB') as photo:
                    photo.save(out,'WEBP',quality=77,method=4);width,height=photo.size
            if out.stat().st_size>500_000:out.unlink();continue
            caption=known['caption'] if known else ('菜品资料示意；不代表当地或指定门店实拍' if food else '景点资料照片；地点以来源页描述为准，不代表出行当天景况')
            return {'title':plain(title),'author':get('Artist') or get('Credit') or '详见来源页','license':license_name,'license_url':license_url,'source':source,'width':width,'height':height,'caption':caption,'reviewed':bool(known)}
        except Exception:continue
    return None


def photo_order(guide):
    """Give every destination a scene and a dish before trying second pictures."""
    names=list(dict.fromkeys(d.get('destination') for d in guide.get('itinerary',[]) if d.get('destination')))
    buckets={name:{'highlights':[],'foods':[]} for name in names}
    for field in ('highlights','foods'):
        for i,item in enumerate(guide.get(field,[])):
            name=re.split(r'[｜|]',item.get('name',''))[0].strip()
            if len(names)==1:name=names[0]
            buckets.setdefault(name,{'highlights':[],'foods':[]})[field].append((field,i,item))
    ordered=[]
    for i in range(max((len(v) for b in buckets.values() for v in b.values()),default=0)):
        for bucket in buckets.values():
            for field in ('highlights','foods'):
                if i<len(bucket[field]):ordered.append(bucket[field][i])
    return ordered,min(MAX_PHOTOS,max(8,4*len(buckets)))


def run(guide,out):
    out.mkdir(exist_ok=True,mode=0o700);result={};start=time.monotonic();seen=set()
    items,limit=photo_order(guide)
    for field,i,item in items:
        if len(result)>=limit or time.monotonic()-start>PHOTO_SECONDS:break
        query=item.get('photo_query','').strip()[:160]
        if not query and not curated_entry(item,field=='foods'):continue
        key=f'{field}-{i}'
        try:
            photo=lookup(query,out/(key+'.webp'),food=field=='foods',item=item,excluded=seen)
            if photo:result[key]={**photo,'file':key+'.webp'};seen.add(photo['source'])
        except Exception:continue
    (out/'photos.json').write_text(json.dumps(result,ensure_ascii=False))
    print(json.dumps({'photos':len(result),'elapsed_seconds':round(time.monotonic()-start)}),flush=True)

if __name__=='__main__':run(json.loads(Path(sys.argv[1]).read_text()),Path(sys.argv[2]))
