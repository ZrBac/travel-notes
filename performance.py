"""File fingerprints and pre-generated display images; originals remain untouched."""
import hashlib
import os
import re
import tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageOps

BASE=Path(__file__).parent
DATA=Path(os.environ.get('TRAVEL_DATA','/var/lib/travel-notes'))
IMAGE_WIDTHS=(320,480,640,1280)


@lru_cache(maxsize=64)
def _fingerprint(filename,mtime,size):
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()[:16]


def fingerprint(path):
    stat=path.stat()
    return _fingerprint(str(path),stat.st_mtime_ns,stat.st_size)


def page_html(filename):
    text=(BASE/'static'/filename).read_text()
    def version(match):
        relative=match.group(2)
        return match.group(1)+'?v='+fingerprint(BASE/'static'/relative)
    return re.sub(r'((?:src|href)="/static/([^"?]+\.(?:js|css)))(?=")',version,text)


def image_variant_path(path,width):
    if width not in IMAGE_WIDTHS: raise ValueError('Unsupported display size')
    stat=path.stat()
    key=hashlib.sha256(f'{path}:{stat.st_mtime_ns}:{stat.st_size}:{width}:webp78-v1'.encode()).hexdigest()
    return DATA/'image-cache'/(key+'.webp')


def _save_variant(picture,result,width):
    result.parent.mkdir(exist_ok=True)
    with picture.copy() as scaled:
        scaled.thumbnail((width,width))
        with tempfile.NamedTemporaryFile(dir=result.parent,suffix='.webp',delete=False) as temporary:
            temp=Path(temporary.name)
        try:
            scaled.save(temp,'WEBP',quality=78,method=4)
            temp.chmod(0o640);temp.replace(result)
        finally: temp.unlink(missing_ok=True)


def prepare_image_variants(path):
    """Decode once; finish display sizes before an upload becomes visible."""
    missing=[(width,image_variant_path(path,width)) for width in IMAGE_WIDTHS]
    missing=[(width,result) for width,result in missing if not result.is_file()]
    if missing:
        with Image.open(path) as original, ImageOps.exif_transpose(original) as oriented, oriented.convert('RGB') as picture:
            for width,result in missing:_save_variant(picture,result,width)


def remove_image_variants(path):
    if path.is_file():
        for width in IMAGE_WIDTHS:image_variant_path(path,width).unlink(missing_ok=True)


def image_variant(path,width):
    result=image_variant_path(path,width)
    if not result.is_file():
        with Image.open(path) as original, ImageOps.exif_transpose(original) as oriented, oriented.convert('RGB') as picture:
            _save_variant(picture,result,width)
    return result


@lru_cache(maxsize=256)
def _dimensions(filename,mtime,size):
    with Image.open(filename) as image:return image.size


def lazy_image(match):
    tag=match.group(0)
    src=re.search(r'\bsrc="(/media/([a-f0-9]{32}\.webp))"',tag)
    if src:
        path=DATA/'uploads'/src.group(2)
        if path.is_file():
            stat=path.stat();width,height=_dimensions(str(path),stat.st_mtime_ns,stat.st_size)
            tag=tag.replace('src="'+src.group(1)+'"','src="'+src.group(1)+'?w=1280"')
            tag=tag.replace('<img ',f'<img width="{width}" height="{height}" ',1)
    return tag.replace('<img ', '<img loading="lazy" decoding="async" ',1)
