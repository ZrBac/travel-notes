"""Private album preview, using capture metadata saved before web compression."""
from flask import abort, jsonify
from psycopg.types.json import Jsonb
from PIL import Image

from feature_photo_album import album_plan, visual_facts


def metadata_for(db, photos, data_dir):
    names = [photo['url'].rsplit('/', 1)[1] for photo in photos]
    rows = db().execute('SELECT filename,photo_metadata FROM media WHERE filename=ANY(%s) AND deleted_at IS NULL ORDER BY filename FOR SHARE', (names,)).fetchall()
    if len(rows) != len(names): abort(409, description='部分照片已移入回收站，请重新选择')
    result = {}
    for row in rows:
        facts = dict(row['photo_metadata'] or {})
        if not facts.get('pixel_hash'):
            path = data_dir/'uploads'/row['filename']
            if path.is_symlink() or not path.is_file(): abort(409, description='照片文件已不存在，请重新选择')
            try:
                with Image.open(path) as picture: facts.update(visual_facts(picture))
            except (OSError, ValueError): abort(409, description='照片暂时无法读取，请重新上传')
            # Legacy web images can supply visual similarity, never their lost EXIF.
            db().execute('UPDATE media SET photo_metadata=%s WHERE filename=%s', (Jsonb(facts), row['filename']))
        result['/media/'+row['filename']] = facts
    return result


def register(app, db, payload, validate_record, data_dir):
    from record_assistant_api import normalize_snapshot, check_source

    @app.post('/api/admin/photo-album/preview')
    def preview_album():
        db().execute('SELECT pg_advisory_xact_lock(74390511)')
        snapshot = normalize_snapshot(payload().get('record'), validate_record, allow_missing_destination=True)
        check_source(db, snapshot)
        if not snapshot['photos']: abort(400, description='先上传或选择几张旅行照片')
        result = album_plan(snapshot['photos'], metadata_for(db, snapshot['photos'], data_dir))
        db().commit()
        return jsonify(album=result)
