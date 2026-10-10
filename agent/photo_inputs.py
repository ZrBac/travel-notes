"""Copy only explicit validated album photos into the isolated vision workspace."""
import os
import re
import stat
from pathlib import Path

from PIL import Image


def prepare(task, uploads, work):
    if task['request'].get('workflow') != 'record_photos': return []
    photos = task['request'].get('record_snapshot', {}).get('photos', [])
    if not 1 <= len(photos) <= 30: raise ValueError('识图需要 1～30 张实际照片')
    paths = []
    try:
        for i, photo in enumerate(photos, 1):
            url = photo.get('url', '')
            if not isinstance(url, str) or not re.fullmatch(r'/media/[a-f0-9]{32}\.webp', url): raise ValueError('识图照片地址不正确')
            source = Path(uploads)/url.rsplit('/', 1)[1]
            descriptor = os.open(source, os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 32*1024**2: raise ValueError('识图照片文件不正确')
                with Image.open(stream) as original:
                    if original.format != 'WEBP' or original.width*original.height > 2400*2400: raise ValueError('识图只读取网站压缩后的照片')
                    with original.convert('RGB') as picture:
                        picture.thumbnail((960, 960))
                        target = Path(work)/f'photo-{i:02d}.jpg'
                        if target.exists() or target.is_symlink(): raise ValueError('识图目录中已有同名文件')
                        paths.append(target)
                        with target.open('xb') as output: picture.save(output, 'JPEG', quality=78, optimize=True)
                        target.chmod(0o600)
        return paths
    except Exception:
        for path in paths: path.unlink(missing_ok=True)
        raise


def cleanup(work):
    for path in Path(work).glob('photo-*.jpg'):
        if re.fullmatch(r'photo-\d{2}\.jpg', path.name): path.unlink(missing_ok=True)
