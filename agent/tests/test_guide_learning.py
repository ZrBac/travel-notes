import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from test_smart_guide import sample
import travel_planner,photo_worker
from guide_visuals import compose

class GuideLearningTests(unittest.TestCase):
 def test_card_coverage_is_per_destination_and_full_dates_must_match_weekday(self):
  g=sample();g['season']='2026年10月30日（周五）';travel_planner.parse_answer(json.dumps(g))
  g['season']='2026年10月30日（周六）'
  with self.assertRaisesRegex(ValueError,'星期'):travel_planner.parse_answer(json.dumps(g))
  g=sample();other=copy.deepcopy(g['itinerary'])
  for d in other:d['destination']='泉州'
  g['itinerary']+=other
  with self.assertRaisesRegex(ValueError,'每个候选地'):travel_planner.parse_answer(json.dumps(g))
 def test_clean_card_citations_and_short_photo_captions(self):
  g=sample();g['summary']='南京[官方资料](https://example.com/info)';g['itinerary'][0]['theme']='文档三·D1｜2026年10月30日周五'
  g=travel_planner.parse_answer(json.dumps(g));self.assertNotIn('文档',g['itinerary'][0]['theme']);self.assertNotIn('](',g['summary'])
  g['highlights'][0]['description']='介绍[官方说明](https://example.com/a?x=1&y=2)<script>bad()</script>'
  photo={'url':'/media/'+'a'*32+'.webp','title':'Very long filename.jpg','author':'Photographer','source':'https://commons.wikimedia.org/wiki/File:Example.jpg','license':'CC BY 4.0','license_url':'https://creativecommons.org/licenses/by/4.0','caption':'同一景点资料照'}
  output=compose(g,{'highlights-0':photo})
  self.assertIn('<a href="https://example.com/a?x=1&amp;y=2">官方说明</a>',output);self.assertNotIn('<script>',output);self.assertIn('同一景点资料照',output);self.assertNotIn('Very long filename',output)
  photo['source']='https://commons.wikimedia.org.evil/wiki/file'
  self.assertNotIn('<img',compose(g,{'highlights-0':photo}))
 def test_curated_subjects_do_not_relabel_lookalike_places_or_dishes(self):
  match=photo_worker.curated_entry({'name':'西双版纳｜中科院热带植物园','photo_query':'Xishuangbanna Tropical Botanical Garden'})
  self.assertIn('Banyan',match['file'])
  self.assertIsNone(photo_worker.curated_entry({'name':'西双版纳｜香茅草烤鱼','photo_query':'dai-style barbecue'},True))
  self.assertIsNone(photo_worker.curated_entry({'name':'福州｜开元寺','photo_query':'Fuzhou Kaiyuan Temple'}))
  self.assertIsNone(photo_worker.curated_entry({'name':'泉州｜蟳埔顺济宫','photo_query':'Quanzhou Tianhou Temple'}))
  self.assertFalse(photo_worker.photo_matches('Xishuangbanna Tropical Botanical Garden','Tropical Botanical Garden, Xishuangbanna - panoramio.jpg',''))
  self.assertFalse(photo_worker.photo_matches('Dai grilled fish','Dai-style barbecue.jpg','Dai-style barbecue with grilled fish, chicken, and vegetables',food=True))
 def test_photo_budget_covers_every_city_and_accepts_two_digit_card_indexes(self):
  names=['甲城','乙城','丙城','丁城'];g={'itinerary':[{'destination':n} for n in names],'highlights':[],'foods':[]}
  for name in names:
   for field in ('highlights','foods'):
    g[field]+=[{'name':name+'｜项目'+str(i),'photo_query':name+field+str(i)} for i in range(4)]
  order,limit=photo_worker.photo_order(g);self.assertEqual(limit,16)
  self.assertEqual([(f,x['name'].split('｜')[0]) for f,_,x in order[:8]],[(f,n) for n in names for f in ('highlights','foods')])
  with tempfile.TemporaryDirectory() as tmp:
   def lookup(query,out,**kwargs):
    out.write_bytes(b'test');return {'source':'https://commons.wikimedia.org/'+query,'width':10,'height':10}
   with patch.object(photo_worker,'lookup',side_effect=lookup):photo_worker.run(g,Path(tmp))
   saved=json.loads((Path(tmp)/'photos.json').read_text());self.assertEqual(len(saved),16);self.assertIn('foods-12',saved)
 def test_playbook_is_part_of_every_prompt_without_fixed_party_size(self):
  task={'prompt':'两人京都旅行','request':{'trip':{'people':2,'destination':'京都'}}}
  prompt=travel_planner.prompt_for(task,[])
  for word in ('27间夜','湿坯','周一闭馆','首日晚到','热带花卉园','最新明确要求优先'):self.assertIn(word,prompt)
  self.assertIn('"people": 2',prompt)

