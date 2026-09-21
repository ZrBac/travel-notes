"""Generate display assets and lightweight handbook pages without losing originals."""
import argparse
import base64
import hashlib
import io
import json
import re
import shutil
from pathlib import Path

from PIL import Image, ImageOps

BASE=Path(__file__).parent


def display_image(source,target,width):
    with Image.open(source) as original:
        picture=ImageOps.exif_transpose(original).convert('RGB')
        picture.thumbnail((width,width));picture.save(target,'WEBP',quality=78,method=4)
        return picture.size


def static_images():
    folder=BASE/'static'/'optimized';folder.mkdir(exist_ok=True)
    catalog={};before=after=0
    for source in sorted((BASE/'static'/'assets').glob('*.jpg')):
        digest=hashlib.sha256(source.read_bytes()+b'webp78-v1').hexdigest()[:16]
        sizes={};before+=source.stat().st_size
        for width in (640,1280):
            target=folder/f'{source.stem}-{digest}-{width}.webp'
            display_image(source,target,width)
            sizes[width]='/static/optimized/'+target.name
            if width==640:after+=target.stat().st_size
        catalog['/static/assets/'+source.name]=sizes
    script='const travelImageCatalog='+json.dumps(catalog,separators=(',',':'))+';\n'
    script+="function travelImageUrl(url,width=640){if(travelImageCatalog[url])return travelImageCatalog[url][width];if(/^\\/media\\/[a-f0-9]{32}\\.webp$/.test(url))return url+'?w='+width;return url;}\n"
    (BASE/'static'/'image-utils.js').write_text(script)
    print(json.dumps({'default_image_original_bytes':before,'card_image_bytes':after}))


def handbook(guide_id):
    folder=Path('/var/lib/travel-notes/uploads/handbooks')
    page=folder/f'{guide_id}.html';original=folder/f'{guide_id}.original.html'
    if not original.exists():shutil.copy2(page,original)
    text=original.read_text();assets=folder/str(guide_id);assets.mkdir(mode=0o750,exist_ok=True)
    image_files=set()
    def replace_image(match):
        tag=match.group(0);source=re.search(r'src="data:image/(?:jpeg|png|webp);base64,([^"]+)"',tag)
        if not source:return tag
        data=base64.b64decode(source.group(1),validate=True)
        name=hashlib.sha256(data+b'webp78-1280-v1').hexdigest()[:32]+'.webp'
        target=assets/name;width,height=display_image(io.BytesIO(data),target,1280);image_files.add(target)
        tag=tag.replace(source.group(0),f'src="/guides/{guide_id}/handbook/images/{name}"')
        tag=re.sub(r'\s(?:width|height)="[^"]*"','',tag)
        return tag.replace('<img ',f'<img width="{width}" height="{height}" ',1)
    text=re.sub(r'<img\b[^>]*>',replace_image,text)
    text=text.replace('离线实景图','实景参考图').replace('真实照片与关键站台图已内嵌','真实照片与关键站台图可按章节查看')
    marker='<div class="hero">'
    text=text.replace(marker,f'<a class="handbook-back" href="/guides/{guide_id}/handbook?download=1">下载离线手册（含全部图片） ↓</a>\n'+marker,1)
    temporary=page.with_suffix('.tmp');temporary.write_text(text);temporary.chmod(0o640);temporary.replace(page)
    print(json.dumps({'guide_id':guide_id,'original_html_bytes':original.stat().st_size,'optimized_html_bytes':page.stat().st_size,'unique_images':len(image_files),'image_bytes':sum(p.stat().st_size for p in image_files)}))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--static',action='store_true');parser.add_argument('--handbook',type=int)
    args=parser.parse_args()
    if args.static:static_images()
    if args.handbook:handbook(args.handbook)
