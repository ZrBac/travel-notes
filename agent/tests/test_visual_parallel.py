import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import service
import travel_planner
from guide_visuals import compose
from photo_worker import check_url

class VisualParallelTests(unittest.TestCase):
 def task(self,id,travel=False):return {'id':id,'kind':'chat','parent_id':None,'cancel_requested':False,'request':{'assistant':'travel'} if travel else {},'prompt':'测试'}
 def test_both_lanes_start_before_either_finishes(self):
  a=self.task(1);b=self.task(2,True);active={}
  def read(sql,**kw):return b if "= 'travel'" in sql else a
  def begin(t):return {'task':t,'unit':'test-'+str(t['id'])}
  with patch.object(service,'read',side_effect=read),patch.object(service,'begin',side_effect=begin),patch.object(service,'finish_step',return_value=False),patch.object(service.shutil,'disk_usage',return_value=MagicMock(free=4*1024**3)):
   service.scheduler_step(active);self.assertEqual(set(active),{'website','travel'})
   service.scheduler_step(active);self.assertEqual(len(active),2)
 def test_one_failure_does_not_stop_other_lane(self):
  active={'website':{'task':self.task(1),'unit':'website'},'travel':{'task':self.task(2,True),'unit':'travel'}}
  with patch.object(service,'finish_step',side_effect=[RuntimeError('website failed'),False]),patch.object(service,'stop_unit') as stop,patch.object(service,'update'),patch.object(service,'cleanup_task'):
   service.scheduler_step(active);self.assertEqual(set(active),{'travel'});stop.assert_called_once_with('website')
 def test_photo_hosts_block_ssrf_and_credentials(self):
  for url in ('http://commons.wikimedia.org/a','https://127.0.0.1/a','https://commons.wikimedia.org.evil/a','https://user@commons.wikimedia.org/a','https://commons.wikimedia.org:8443/a','file:///etc/passwd'):
   with self.assertRaises(ValueError):check_url(url)
  self.assertEqual(check_url('https://thumb.wikimedia.org/a'),'https://thumb.wikimedia.org/a')
 def test_structured_output_requires_food_and_escapes_cards(self):
  guide={k:'参考安排'*100 if k=='body' else '参考' for k in travel_planner.LIMITS};guide.update(days=4,template='culture')
  for key,fields in travel_planner.CARD_FIELDS.items():guide[key]=[{k:('' if k=='photo_query' else '<script>alert(1)</script>') for k in fields} for _ in range(4)]
  parsed=travel_planner.parse_answer(json.dumps(guide));html=compose(parsed,{})
  self.assertNotIn('<script>',html);self.assertIn('trip-card',html)
  invalid=copy.deepcopy(guide);invalid['foods']=[]
  with self.assertRaises(ValueError):travel_planner.parse_answer(json.dumps(invalid))
