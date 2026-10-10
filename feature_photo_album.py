"""Small, private photo facts and conservative album suggestions; no network calls."""
from datetime import datetime
import hashlib
import math
import re

from PIL import Image, ImageFilter, ImageStat


def capture_facts(image):
    facts = {'version': 1, 'source_width': image.width, 'source_height': image.height}
    try:
        exif = image.getexif()
        detail = exif.get_ifd(34665) if 34665 in exif else {}
        # DateTimeOriginal / DateTimeDigitized are capture times; generic
        # DateTime can be an editing time and must never order a trip.
        for raw in (detail.get(36867) or exif.get(36867), detail.get(36868) or exif.get(36868)):
            if not isinstance(raw, str): continue
            try: captured = datetime.strptime(raw.strip('\x00 '), '%Y:%m:%d %H:%M:%S')
            except ValueError: continue
            if 1900 <= captured.year <= 2200:
                facts['taken_at'] = captured.isoformat(timespec='seconds'); break
        offset = detail.get(36881) or exif.get(36881)
        if facts.get('taken_at') and isinstance(offset, str) and re.fullmatch(r'[+-](?:0\d|1[0-4]):[0-5]\d', offset):
            facts['utc_offset'] = offset
        gps = exif.get_ifd(34853) if 34853 in exif else {}
        def coordinate(values, reference, negative):
            if len(values) != 3: raise ValueError('Invalid coordinate')
            degree, minute, second = map(float, values)
            if degree < 0 or not 0 <= minute < 60 or not 0 <= second < 60: raise ValueError('Invalid coordinate')
            return (degree+minute/60+second/3600) * (-1 if reference == negative else 1)
        if gps and gps.get(1) in ('N', 'S') and gps.get(3) in ('E', 'W'):
            lat = coordinate(gps[2], gps[1], 'S'); lon = coordinate(gps[4], gps[3], 'W')
            if math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
                facts['gps'] = {'lat': round(lat, 5), 'lng': round(lon, 5)}
    except (ValueError, TypeError, KeyError, OverflowError, OSError, AttributeError, ZeroDivisionError):
        # Optional malformed EXIF must not prevent a valid photo upload.
        pass
    return facts


def visual_facts(image):
    with image.convert('RGB') as rgb:
        rgb.thumbnail((320, 320))
        with rgb.convert('L') as gray, gray.resize((9, 8)) as dh, gray.resize((8, 8)) as ah, rgb.resize((32, 32)) as tiny:
            values = list(dh.get_flattened_data()); avg = list(ah.get_flattened_data())
            dhash = sum((values[y*9+x] > values[y*9+x+1]) << (y*8+x) for y in range(8) for x in range(8))
            mean = sum(avg)/64
            ahash = sum((value > mean) << i for i, value in enumerate(avg))
            with gray.filter(ImageFilter.FIND_EDGES) as edges, (edges.crop((1, 1, edges.width-1, edges.height-1)) if min(edges.size)>2 else edges.copy()) as center:
                sharpness = ImageStat.Stat(center).var[0] if center.width and center.height else 0
            return {'dhash': f'{dhash:016x}', 'ahash': f'{ahash:016x}',
                    'pixel_hash': hashlib.sha256(tiny.tobytes()).hexdigest(),
                    'color': [round(v, 1) for v in ImageStat.Stat(tiny).mean],
                    'sharpness': round(sharpness, 2), 'aspect': round(image.width/image.height, 4)}


def similar(a, b):
    if a.get('pixel_hash') and a.get('pixel_hash') == b.get('pixel_hash'): return True
    try:
        if min(a['sharpness'], b['sharpness']) < 4: return False
        return (abs(math.log(a['aspect']/b['aspect'])) < .12
                and (int(a['dhash'], 16)^int(b['dhash'], 16)).bit_count() <= 5
                and (int(a['ahash'], 16)^int(b['ahash'], 16)).bit_count() <= 5
                and math.dist(a['color'], b['color']) < 32)
    except (KeyError, ValueError, TypeError, ZeroDivisionError): return False


def album_plan(photos, metadata):
    groups = []
    for i, photo in enumerate(photos):
        for group in groups:
            # Complete-link clusters avoid chaining unlike scenes together.
            if all(similar(metadata.get(photo['url'], {}), metadata.get(photos[j]['url'], {})) for j in group):
                group.append(i); break
        else: groups.append([i])
    duplicates = {}; suggested = set(range(len(photos)))
    for number, group in enumerate((g for g in groups if len(g) > 1), 1):
        def quality(i):
            facts = metadata.get(photos[i]['url'], {})
            return (math.log1p(facts.get('sharpness', 0))+.12*math.log1p(facts.get('source_width', 0)*facts.get('source_height', 0)), -i)
        best = max(group, key=quality)
        for i in group:
            duplicates[i] = {'similar_group': number, 'recommended': i == best}
            if i != best: suggested.discard(i)
    ordered = sorted(range(len(photos)), key=lambda i: (not bool(metadata.get(photos[i]['url'], {}).get('taken_at')),
                     metadata.get(photos[i]['url'], {}).get('taken_at', ''), i))
    items = []; locations = []
    for i in ordered:
        photo = photos[i]; facts = metadata.get(photo['url'], {})
        location = None; gps = facts.get('gps')
        if gps:
            for number, group in enumerate(locations, 1):
                if all(gps_distance(gps, other) <= 250 for other in group):
                    location = number; group.append(gps); break
            else: locations.append([gps]); location = len(locations)
        items.append({'index': i, 'url': photo['url'], 'caption': photo['caption'], 'taken_at': facts.get('taken_at', ''),
                      'utc_offset': facts.get('utc_offset', ''), 'gps': gps, 'location_group': location,
                      'day': facts.get('taken_at', '')[:10] or '日期待补充', 'suggested': i in suggested,
                      'quality_note': '画面细节较少或偏虚，可检查' if facts.get('sharpness', 100) < 4 else '',
                      **duplicates.get(i, {})})
    days = sorted({item['day'] for item in items if item['taken_at']})
    return {'items': items, 'dates': {'start_date': days[0], 'end_date': days[-1]} if days else None,
            'similar_groups': len([g for g in groups if len(g) > 1]),
            'missing_dates': sum(not item['taken_at'] for item in items)}


def gps_distance(a, b):
    lat1, lat2 = math.radians(a['lat']), math.radians(b['lat'])
    dlat = lat2-lat1; dlon = math.radians(b['lng']-a['lng'])
    angle = math.sin(dlat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    return 6_371_000*2*math.asin(math.sqrt(min(1, max(0, angle))))
