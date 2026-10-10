"""Deterministic worker contracts, protected deployment classification and runtime labels."""
import copy
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

ROOT=Path(os.environ.get('TRAVEL_AGENT_CODE_ROOT',Path(__file__).resolve().parents[2]/'agent'))
if not ROOT.is_dir():ROOT=Path('/opt/travel-agent')
# The website candidate sandbox cannot see agent code: it runs application API
# tests only. These worker contracts are exercised at controller rollout.
AVAILABLE=(ROOT/'trip_workflows.py').is_file()
if AVAILABLE:
    def module(name):
        spec=importlib.util.spec_from_file_location('travel_contract_'+name,ROOT/(name+'.py'))
        loaded=importlib.util.module_from_spec(spec);spec.loader.exec_module(loaded);return loaded
    sys.path.insert(0,str(ROOT))
    workflow=module('trip_workflows');artifacts=module('artifacts');service=module('service')
    sys.path.pop(0)


@unittest.skipUnless(AVAILABLE,'Controller contracts run during the controller release')
class WorkerContractTests(unittest.TestCase):
    def fixture(self,action='adjust_day'):
        from test_trips import itinerary
        return {'workflow':action,'context':{'day':1,'trip':{'id':1,'destination':'南京','revision':2,'progress':{'1:1:0':'done'}},
                'plan':{'version':1,'itinerary':itinerary()},'notes':[{'id':7,'captured_date':'2026-11-06','place':'老街','note':'喜欢散步，下午想休息','photos':[{'url':'/media/'+'a'*32+'.webp','caption':'真实照片'}]}]}}

    def result(self,action='adjust_day'):
        from test_trips import itinerary
        value={'summary':'调整剩余路线','body':'根据真实记录整理。','sources':'','warnings':[]}
        if action=='adjust_day':value['day_plan']=itinerary()[0]
        elif action=='check_departure':value['checks']=[]
        elif action=='recap':value['title']='真实旅行回忆'
        else:value['suggestions']=[{'field':'walking','value':'午后休息','reason':'随记明确要求','note_ids':[7]}]
        return value

    def test_structured_schemas_and_valid_outputs_for_each_workflow(self):
        def strict(value):
            if isinstance(value,dict):
                if value.get('type')=='object':self.assertFalse(value['additionalProperties']);self.assertEqual(set(value['required']),set(value['properties']))
                for v in value.values():strict(v)
            elif isinstance(value,list):
                for v in value:strict(v)
        for action in workflow.ACTIONS:
            task={'request':self.fixture(action)};strict(workflow.output_schema(task))
            result=self.result(action);self.assertEqual(workflow.parse_answer(json.dumps(result),task['request']),result)

    def test_no_images_in_prompt_or_fabricated_recap_and_no_snapshot_mutation(self):
        info=self.fixture('recap');original=copy.deepcopy(info)
        prompt=workflow.prompt_for({'request':info,'prompt':'整理回来后的回忆'})
        self.assertNotIn('/media/',prompt);self.assertIn('不猜图片内容',prompt);self.assertIn('真实照片',prompt);self.assertEqual(info,original)
        for body in ('![图](/media/fake.webp)','<img src="https://fake.test/a.jpg">','照片 /media/aaa.webp'):
            result=self.result('recap');result['body']=body
            with self.assertRaises(ValueError):workflow.parse_answer(json.dumps(result),info)

    def test_day_selection_and_marked_route_prefix_are_hard_boundaries(self):
        info=self.fixture();result=self.result();result['day_plan']['stops'].append('新景点')
        workflow.parse_answer(json.dumps(result),info)
        for data in ({'day':2},{'day':True},{'destination':'其他城市'},{'stops':['篡改历史']},{'slots':[]}):
            invalid=copy.deepcopy(result);invalid['day_plan'].update(data)
            with self.assertRaises(ValueError):workflow.parse_answer(json.dumps(invalid),info)

    def test_preferences_need_existing_note_evidence_and_match_field_limits(self):
        info=self.fixture('preferences');valid=self.result('preferences')
        for change in ({'note_ids':[]},{'note_ids':[99]},{'field':'password'},{'field':'walking','value':'长'*121},{'field':'pace','value':'宽松'},{'field':'people','value':'99'}):
            data=copy.deepcopy(valid);data['suggestions'][0].update(change)
            with self.assertRaises(ValueError):workflow.parse_answer(json.dumps(data),info)

    def test_protected_files_cannot_enter_review_publish_route_or_root_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            old=Path(temp)/'old';new=Path(temp)/'new';old.mkdir();new.mkdir()
            for name in ('app.py','schema.sql','database.py','agent_api.py','trip_api.py','requirements.txt'):
                (old/name).write_text('original');(new/name).write_text('candidate')
            for name in ('feature_gallery.py','psycopg.py','ops.py','releases.py'):(new/name).write_text('candidate')
            report=artifacts.compare(old,new)
            self.assertEqual(set(report['review_files']),{'agent_api.py','trip_api.py','feature_gallery.py'})
            self.assertEqual(set(report['manual_files']),{'schema.sql','database.py','requirements.txt','psycopg.py','ops.py','releases.py'})
            self.assertTrue(next(f['automatic'] for f in report['files'] if f['path']=='app.py'))

    def test_runtime_metadata_is_observed_and_not_inferred_from_root_config(self):
        with tempfile.TemporaryDirectory() as temp:
            log=Path(temp)/'model.log'
            log.write_text(json.dumps({'type':'thread.started','thread_id':'fixture'})+'\n'+json.dumps({'type':'turn.completed','usage':{'input_tokens':10}}))
            value=service.model_output(log);self.assertIsNone(value['execution']['model']);self.assertEqual(value['execution']['source'],'cli_default')
            log.write_text(json.dumps({'type':'turn_context','payload':{'model':'fixture-model','reasoning_effort':'max'}}))
            value=service.model_output(log);self.assertEqual(value['execution']['model'],'fixture-model');self.assertEqual(value['execution']['effort'],'max');self.assertEqual(value['execution']['source'],'runtime')

    def test_manual_changes_are_tested_before_review_instead_of_early_stop(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);baseline=root/'baseline';work=root/'work';baseline.mkdir();work.mkdir()
            (baseline/'schema.sql').write_text('old schema');(work/'schema.sql').write_text('candidate schema')
            (root/'model.log').write_text('')
            process=Mock();process.poll.return_value=0;process.returncode=0
            active={'task':{'id':17,'kind':'change','request':{}},'root':root,'work':work,'process':process,'unit':'fixture','started':__import__('time').time(),'phase':'model','last_save':0}
            data={'result':'修改完成','last_message':'修改完成','progress':[],'usage':{},'errors':[],'completed':True,'web_search_count':0,'execution':{}}
            with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'model_output',return_value=data),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'start_tests') as test:
                self.assertFalse(service.finish_step(active));test.assert_called_once()
                report=test.call_args.args[1];self.assertEqual(report['manual_files'],['schema.sql']);self.assertFalse(report['publishable'])
                self.assertNotIn('manual',[c.args[1] for c in update.call_args_list if len(c.args)>1])
            (root/'tests.log').write_text('测试通过')
            active.update(phase='tests',report=report)
            with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'review_package') as package,patch.object(service,'update') as update:
                self.assertTrue(service.finish_step(active));package.assert_called_once()
                report=update.call_args.kwargs['report'];self.assertTrue(report['tests_passed']);self.assertFalse(report['publishable']);self.assertEqual(update.call_args.args[1],'manual')
