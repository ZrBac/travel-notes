import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import service
import travel_planner


def answer():
    return {'title':'南京四天三晚','destination':'南京','country':'中国','summary':'文化旅行','season':'秋季','budget':'估算',
            'body':'## 日程\n'+('行程参考，门票和预约请核实。'*20),'sources':'[资料](https://example.com)','days':4}


class TravelPlannerTests(unittest.TestCase):
    def task(self):return {'id':1001,'kind':'chat','parent_id':None,'request':{'assistant':'travel','trip':{'days':4,'people':9,'rooms':'9 间'}},'prompt':'四天三晚'}
    def test_scope_and_prompt_have_no_site_context(self):
        task=self.task();self.assertTrue(travel_planner.is_travel(task))
        self.assertFalse(travel_planner.is_travel({**task,'kind':'change'}))
        with tempfile.TemporaryDirectory() as tmp,patch.object(service,'snapshot') as snapshot:
            prompt=service.prompt_for(task,Path(tmp))
            snapshot.assert_not_called();self.assertIn('9 间',prompt);self.assertIn('先联网检索',prompt);self.assertNotIn('TASK_CONTEXT.md',prompt)
            self.assertEqual(list(Path(tmp).iterdir()),[])
    def test_strict_output_rejects_broken_or_oversized_results(self):
        self.assertEqual(travel_planner.parse_answer(json.dumps(answer()))['days'],4)
        for value in ('not json','{}',json.dumps({**answer(),'days':True}),json.dumps({**answer(),'body':'short'}),json.dumps({**answer(),'title':'x'*101})):
            with self.assertRaises(ValueError):travel_planner.parse_answer(value)
    def test_travel_launch_is_readonly_search_enabled_without_source_copy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);private=root/'private';private.mkdir();work=root/'work';work.mkdir()
            with patch.object(service,'PRIVATE',private),patch.object(service,'WORK',work),patch.object(service,'own_tree'),patch.object(service,'update'),patch.object(service,'copy_code') as copy,patch.object(service,'launch') as launch:
                service.begin(self.task());copy.assert_not_called()
                args=launch.call_args.args[3]
                self.assertEqual(args[args.index('--sandbox')+1],'read-only')
                self.assertIn('web_search="live"',args);self.assertIn('shell_tool',args);self.assertIn('--output-schema',args)
                self.assertFalse((private/'1001'/'baseline').exists());self.assertFalse((work/'1001'/'.venv').exists())
    def test_web_search_events_and_final_result_are_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'model.log'
            events=[{'type':'item.completed','item':{'id':'s1','type':'web_search','query':'南京文旅'}},
                    {'type':'item.completed','item':{'type':'agent_message','text':'先查资料'}},
                    {'type':'item.completed','item':{'type':'agent_message','text':json.dumps(answer())}},
                    {'type':'turn.completed','usage':{'input_tokens':100}}]
            path.write_text('\n'.join(json.dumps(e) for e in events))
            data=service.model_output(path);self.assertEqual(data['web_search_count'],1)
            self.assertEqual(travel_planner.parse_answer(data['last_message'])['destination'],'南京')
            process=MagicMock();process.poll.return_value=0;process.returncode=0
            active={'task':self.task(),'phase':'model','process':process,'root':Path(tmp),'unit':'unused','started':service.time.time(),'last_save':service.time.time()}
            with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'start_tests') as tests:
                self.assertTrue(service.finish_step(active));tests.assert_not_called()
                args=update.call_args.args;self.assertEqual(args[1],'done');self.assertEqual(args[3]['travel_guide']['days'],4)
