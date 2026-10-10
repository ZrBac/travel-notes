"""Private EXIF, album suggestions and isolated vision input/output contracts."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw, TiffImagePlugin
from psycopg.types.json import Jsonb
import test_record_assistant as records
import test_app as base
from database import connect
from feature_photo_album import capture_facts, visual_facts, album_plan


class PhotoAlbumTests(unittest.TestCase):
    setUp=base.AppTests.setUp
    login=base.AppTests.login
    mutate=base.AppTests.mutate
    prepare=records.RecordAssistantTests.prepare
    snapshot=records.RecordAssistantTests.snapshot
    submit=records.RecordAssistantTests.submit
    photo=records.RecordAssistantTests.photo
    preview=records.RecordAssistantTests.preview
    endpoint=records.RecordAssistantTests.endpoint
    def photo_with_exif(self, captured='2026:11:06 10:30:00', color='green', gps=True):
        image=Image.new('RGB',(400,300),color);draw=ImageDraw.Draw(image)
        draw.rectangle((30,30,200,230),fill='white');draw.line((0,280,390,0),fill='black',width=4)
        exif=Image.Exif();exif[36867]=captured;exif[36881]='+08:00'
        if gps:
            rat=TiffImagePlugin.IFDRational
            exif[34853]={1:'N',2:(rat(31),rat(12),rat(0)),3:'E',4:(rat(121),rat(30),rat(0))}
        buf=io.BytesIO();image.save(buf,'JPEG',exif=exif);buf.seek(0)
        response=self.client.post('/api/upload',data={'image':(buf,'family.jpeg')},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(response.status_code,201,response.json);return response.json['url']

    def album(self, snapshot):
        return self.mutate('POST','/api/admin/photo-album/preview',{'record':snapshot})

    def test_capture_metadata_is_private_and_stripped_from_public_web_images(self):
        self.prepare();photo=self.photo_with_exif();name=photo.rsplit('/',1)[1]
        with connect() as c: facts=c.execute('SELECT photo_metadata FROM media WHERE filename=%s',(name,)).fetchone()['photo_metadata']
        self.assertEqual(facts['taken_at'],'2026-11-06T10:30:00');self.assertEqual(facts['utc_offset'],'+08:00')
        self.assertEqual(facts['gps'],{'lat':31.2,'lng':121.5});self.assertEqual(facts['source_width'],400)
        self.assertNotIn('photo_metadata',self.client.get('/api/admin/media').json['media'][0])
        snapshot=self.snapshot(photos=[{'url':photo,'caption':''}])
        rid=self.mutate('POST','/api/records',{**snapshot,'title':'公开图册','status':'public'}).json['id']
        public=self.visitor.get('/api/records/'+str(rid)).json
        self.assertNotIn('gps',json.dumps(public));self.assertNotIn('taken_at',json.dumps(public))
        for suffix in ('','?w=640'):
            response=self.visitor.get(photo+suffix,buffered=True);self.assertEqual(response.status_code,200)
            with Image.open(io.BytesIO(response.data)) as downloaded:
                self.assertFalse(downloaded.getexif());self.assertNotIn('exif',downloaded.info)
        self.assertEqual(self.visitor.post('/api/admin/photo-album/preview',json={'record':snapshot}).status_code,401)
        self.assertEqual(self.client.post('/api/admin/photo-album/preview',json={'record':snapshot}).status_code,403)
        private=self.album(snapshot);self.assertEqual(private.headers['Cache-Control'],'no-store')
        self.assertEqual(private.json['album']['items'][0]['gps'],facts['gps'])

    def test_ordering_duplicate_suggestions_no_content_write_and_legacy_fallback(self):
        self.prepare();late=self.photo_with_exif('2026:11:07 09:00:00');early=self.photo_with_exif();duplicate=self.photo_with_exif();unknown=self.photo('blue')
        with connect() as c:c.execute("UPDATE media SET photo_metadata='{}' WHERE filename=%s",(unknown.rsplit('/',1)[1],))
        snapshot=self.snapshot(destination='',photos=[{'url':late,'caption':'晚一天'}, {'url':unknown,'caption':''}, {'url':early,'caption':'第一天'}, {'url':duplicate,'caption':''}])
        response=self.album(snapshot);self.assertEqual(response.status_code,200,response.json);plan=response.json['album']
        self.assertEqual([p['index'] for p in plan['items']],[2,3,0,1]);self.assertEqual(plan['missing_dates'],1)
        self.assertEqual(plan['dates'],{'start_date':'2026-11-06','end_date':'2026-11-07'})
        self.assertGreaterEqual(plan['similar_groups'],1);self.assertLess(sum(p['suggested'] for p in plan['items']),4)
        self.assertFalse(next(p for p in plan['items'] if p['url']==unknown)['taken_at'])
        with connect() as c:
            self.assertEqual(c.execute('SELECT count(*) n FROM travel_records').fetchone()['n'],0)
            self.assertEqual(c.execute('SELECT count(*) n FROM media').fetchone()['n'],4)
            facts=c.execute('SELECT photo_metadata FROM media WHERE filename=%s',(unknown.rsplit('/',1)[1],)).fetchone()['photo_metadata']
            self.assertIn('pixel_hash',facts);self.assertNotIn('taken_at',facts)
        self.assertEqual(self.album(self.snapshot()).status_code,400)

    def test_vision_allows_photos_without_text_or_destination_and_uses_real_dates(self):
        self.prepare();photo=self.photo_with_exif();snapshot=self.snapshot(destination='',photos=[{'url':photo,'caption':''}])
        r=self.submit(snapshot,action='record_photos',prompt='',request_key='b'*32);self.assertEqual(r.status_code,201,r.json);tid=r.json['id']
        with connect() as c:info=c.execute('SELECT request FROM agent_tasks WHERE id=%s',(tid,)).fetchone()['request']
        self.assertEqual(info['record_snapshot'],snapshot)
        self.assertEqual(info['context']['photos'][0]['taken_at'],'2026-11-06T10:30:00')
        self.assertNotIn(photo,json.dumps(info['context']));self.assertNotIn('gps',json.dumps(info['context']))
        self.assertEqual(self.submit(snapshot,action='record_generate',prompt='').status_code,400)
        self.assertEqual(self.submit(self.snapshot(),action='record_photos').status_code,400)
        r=self.submit(snapshot,action='record_photos',request_key='b'*32);self.assertEqual(r.json['id'],tid)
        self.assertEqual(self.mutate('POST','/api/admin/media/'+photo.rsplit('/',1)[1],{'action':'trash'}).status_code,409)

    def test_vision_preview_checks_correspondence_and_stale_snapshot(self):
        self.prepare();photo=self.photo();snapshot=self.snapshot(photos=[{'url':photo,'caption':'自己的说明'}])
        tid=self.submit(snapshot,action='record_photos').json['id']
        result={'photos':[{'marker':'[[相册01]]','caption':'街边的绿色建筑','subject':'人文','confidence':'medium','place_hint':'','highlight':True,'quality_note':''}],'warnings':[],'body':'说明'}
        def done(value):
            with connect() as c:c.execute("UPDATE agent_tasks SET status='done',report=%s WHERE id=%s",(Jsonb({'workflow_result':value}),tid))
        done(result);preview=self.preview(tid,snapshot);self.assertEqual(preview.status_code,200,preview.json)
        self.assertEqual(preview.json['proposal']['photos'][0]['url'],photo)
        self.assertEqual(preview.json['proposal']['photos'][0]['original_caption'],'自己的说明')
        self.assertEqual(self.preview(tid,{**snapshot,'summary':'后来补充'}).status_code,409)
        for change in ({'marker':'[[相册02]]'},{'caption':'多'*201},{'confidence':'unknown'},{'highlight':1}):
            broken=copy.deepcopy(result);broken['photos'][0].update(change);done(broken);self.assertEqual(self.preview(tid,snapshot).status_code,409)


class PhotoAlgorithms(unittest.TestCase):
    def test_low_detail_different_colors_are_not_duplicates_and_tiny_images_are_valid(self):
        red=Image.new('RGB',(100,80),'red');blue=Image.new('RGB',(100,80),'blue')
        photos=[{'url':'red','caption':''},{'url':'blue','caption':''}]
        plan=album_plan(photos,{'red':visual_facts(red),'blue':visual_facts(blue)})
        self.assertEqual(plan['similar_groups'],0);self.assertTrue(all(p['suggested'] for p in plan['items']))
        self.assertIn('pixel_hash',visual_facts(Image.new('RGB',(1,1),'white')))

    def test_best_duplicate_prefers_resolution_and_keeps_unknown_dates_unassigned(self):
        photos=[{'url':'a','caption':''},{'url':'b','caption':''}]
        facts={'a':{'pixel_hash':'same','sharpness':20,'source_width':200,'source_height':100},'b':{'pixel_hash':'same','sharpness':20,'source_width':400,'source_height':200}}
        plan=album_plan(photos,facts);self.assertFalse(plan['items'][0]['suggested']);self.assertTrue(plan['items'][1]['suggested'])
        self.assertIsNone(plan['dates']);self.assertEqual(plan['missing_dates'],2)

    def test_generic_edit_time_is_not_capture_time_and_malformed_optional_exif_is_ignored(self):
        image=Image.new('RGB',(80,60));exif=image.getexif();exif[306]='2026:10:01 09:00:00'
        self.assertNotIn('taken_at',capture_facts(image))
        exif[36867]='not a date';self.assertNotIn('taken_at',capture_facts(image))

    def test_location_groups_keep_distant_places_separate(self):
        photos=[{'url':str(i),'caption':''} for i in range(3)]
        facts={'0':{'gps':{'lat':31.2,'lng':121.5}},'1':{'gps':{'lat':31.2001,'lng':121.5001}},'2':{'gps':{'lat':31.25,'lng':121.5}}}
        items=album_plan(photos,facts)['items']
        self.assertEqual(items[0]['location_group'],items[1]['location_group'])
        self.assertNotEqual(items[0]['location_group'],items[2]['location_group'])


class PhotoWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root=Path(__file__).resolve().parents[1]/'agent'
        for module in ('photo_workflows','photo_inputs'):
            spec=importlib.util.spec_from_file_location(module,root/(module+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);setattr(cls,module,value)

    def task(self):
        return {'prompt':'说明画面，不猜店名','request':{'workflow':'record_photos','context':{'record':{'destination':''},'photos':[{'marker':'[[相册01]]','caption':''}]}}}

    def test_vision_contract_has_one_result_per_image_and_rejects_fabricated_mappings(self):
        task=self.task();schema=self.photo_workflows.output_schema(task);self.assertFalse(schema['additionalProperties'])
        self.assertIn('实际照片已随提示附上',self.photo_workflows.prompt_for(task));self.assertIn('不识别人脸身份',self.photo_workflows.prompt_for(task))
        result={'photos':[{'marker':'[[相册01]]','caption':'山间的湖泊','subject':'风景','confidence':'high','place_hint':'','highlight':True,'quality_note':''}],'warnings':[]}
        parsed=self.photo_workflows.parse_answer(json.dumps(result),task['request']);self.assertIn('山间的湖泊',parsed['body'])
        for value in ({**result,'photos':[]},{**result,'photos':[dict(result['photos'][0],marker='[[相册99]]')]},{**result,'photos':[dict(result['photos'][0],caption='字'*201)]}):
            with self.assertRaises(ValueError):self.photo_workflows.parse_answer(json.dumps(value),task['request'])

    def test_vision_input_is_resized_stripped_and_cannot_read_symlinks_or_other_files(self):
        with tempfile.TemporaryDirectory() as temp:
            uploads=Path(temp)/'uploads';uploads.mkdir();work=Path(temp)/'work';work.mkdir()
            name='a'*32+'.webp';Image.new('RGB',(1800,1200),'green').save(uploads/name,'WEBP')
            task=self.task();task['request']['record_snapshot']={'photos':[{'url':'/media/'+name,'caption':''}]}
            paths=self.photo_inputs.prepare(task,uploads,work);self.assertEqual(len(paths),1)
            with Image.open(paths[0]) as image:self.assertEqual(image.format,'JPEG');self.assertLessEqual(max(image.size),960);self.assertFalse(image.getexif())
            self.photo_inputs.cleanup(work);self.assertFalse(paths[0].exists())
            (uploads/name).unlink();(uploads/name).symlink_to('/etc/passwd')
            with self.assertRaises(OSError):self.photo_inputs.prepare(task,uploads,work)
            task['request']['record_snapshot']['photos'][0]['url']='/media/../../etc/passwd'
            with self.assertRaises(ValueError):self.photo_inputs.prepare(task,uploads,work)
