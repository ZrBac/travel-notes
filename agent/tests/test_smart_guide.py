import copy,json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import travel_planner
from guide_visuals import compose

def sample():
 g={k:('住宿预算和预约需要核实，雨天安排休息。'*20 if k=='body' else '南京参考') for k in travel_planner.LIMITS}
 g.update(days=2,template='auto',planning_summary='结合南京的人文、河岸自然与地方风味，把相近区域安排在同一天，留出休息和预约余量。')
 for key,fields in travel_planner.CARD_FIELDS.items():g[key]=[{k:('' if k=='photo_query' else '具体介绍') for k in fields} for _ in range(4)]
 g['itinerary']=[]
 for day in (1,2):
  g['itinerary'].append({'day':day,'destination':'南京','theme':'人文与街区','stops':['住宿区域','博物馆','河岸街区'],'transport':'地铁加步行，时长参考估计','pace':'轻松，步行预计约3公里','lunch':'当地鸭血粉丝汤，街区内用餐','dinner':'地方家常菜，返回住宿区域','stay':'市中心住宿区域',
   'slots':[{'period':period,'plan':'街区走访与休息','transport':'地铁或步行，预计20分钟','reservation':'馆舍需要预约，出发前复查'} for period in ('上午','下午','晚上')]})
 return g

class SmartGuideTests(unittest.TestCase):
 def parse(self,g):return travel_planner.parse_answer(json.dumps(g,ensure_ascii=False))
 def test_complete_route_and_deterministic_tables(self):
  g=self.parse(sample());g['itinerary'][0]['stops'][1]='<script>alert(1)</script>'
  html=compose(g,{})
  self.assertIn('trip-route',html);self.assertEqual(html.count('class="trip-day"'),2)
  self.assertEqual(html.count('<thead>'),3);self.assertIn('2 · &lt;script&gt;',html);self.assertNotIn('<script>',html)
  self.assertLess(html.index('行程一览'),html.index('值得停留'))
  self.assertLess(html.index('每天怎么走'),html.index('这一站，吃什么'))
 def test_missing_duplicate_or_out_of_order_days_rejected(self):
  for mutation in ('missing','duplicate','bad_slot','too_many_stops','wrong_type','no_plan'):
   g=sample()
   if mutation=='missing':g['itinerary'].pop()
   if mutation=='duplicate':g['itinerary'][1]['day']=1
   if mutation=='bad_slot':g['itinerary'][0]['slots'].reverse()
   if mutation=='too_many_stops':g['itinerary'][0]['stops']=['站点']*9
   if mutation=='wrong_type':g['itinerary'][0]['day']=True
   if mutation=='no_plan':del g['itinerary']
   with self.subTest(mutation=mutation),self.assertRaises(ValueError):self.parse(g)
 def test_compare_requires_complete_days_for_each_candidate(self):
  g=sample();other=copy.deepcopy(g['itinerary'])
  for day in other:day['destination']='泉州'
  g['itinerary']+=other;self.assertEqual(len(self.parse(g)['itinerary']),4)
  g['itinerary'].pop()
  with self.assertRaises(ValueError):self.parse(g)
 def test_new_schema_is_auto_and_legacy_guides_still_parse(self):
  self.assertEqual(travel_planner.OUTPUT_SCHEMA['properties']['template']['enum'],['auto'])
  g=sample();g.pop('planning_summary');g.pop('itinerary');g['template']='nature'
  self.assertEqual(self.parse(g)['template'],'nature')


class PhotoSubjectTests(unittest.TestCase):
 def test_search_result_must_match_subject_not_just_category(self):
  from photo_worker import photo_matches
  self.assertFalse(photo_matches('lemongrass grilled fish','Grilled pork, lemongrass, garlic, fish sauce.jpg','Restaurant dish'))
  self.assertFalse(photo_matches('bamboo sticky rice','Sticky Rice.jpg','sticky rice'))
  self.assertFalse(photo_matches('Xishuangbanna Zongfo Temple','WatChienglarn.jpg','Wat Chienglarn at Jinghong, Xishuangbanna, Yunnan, China.'))
  self.assertFalse(photo_matches('green papaya salad','Grilled yellow snapper with green papaya salad and tostones.jpg','Grilled fish with salad',food=True))
  self.assertTrue(photo_matches('pineapple sticky rice','Glutinous Rice in Pineapple.jpg','',food=True))
  self.assertTrue(photo_matches('Manting Park','Manting Imperial Garden.jpg',''))
  self.assertTrue(photo_matches('pineapple sticky rice','Sweet Black Glutinous Rice in Pineapple.jpg',''))
  self.assertTrue(photo_matches('Xishuangbanna Tropical Botanical Garden','Tropical Botanical Garden, Xishuangbanna - panoramio.jpg',''))
