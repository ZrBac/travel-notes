import json
from pathlib import Path
import sys,tempfile,time,unittest
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import service
from artifacts import manifest

class WebsiteRepairTests(unittest.TestCase):
 def task(self):return {'id':501,'kind':'change','parent_id':None,'request':{},'prompt':'修复网站功能'}
 def active(self,root,phase='tests'):
  work=root/'work';work.mkdir();(root/'prompt.txt').write_text('原始需求');(root/'tests.log').write_text('FAILED: actual regression')
  process=MagicMock(returncode=1);process.poll.return_value=1
  return {'task':self.task(),'phase':phase,'root':root,'work':work,'process':process,'unit':'unused','started':time.time(),'task_started':time.time(),'last_save':time.time(),
          'report':{'publishable':False,'files':[],'usage':{'input_tokens':123}},'resume_note':'从最新正式代码开始'}
 def test_first_failure_retries_once_with_actual_feedback_and_same_sandbox(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);active=self.active(root);target=root/'must-not-change';target.write_text('safe')
   (active['work']/'TEST_FAILURE.md').symlink_to(target)
   with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'own_tree'),patch.object(service,'launch') as launch:
    self.assertFalse(service.finish_step(active));self.assertEqual(active['phase'],'model');self.assertEqual(active['repair_attempt'],1)
    self.assertIn('actual regression',(active['work']/'TEST_FAILURE.md').read_text());self.assertEqual(target.read_text(),'safe')
    self.assertNotIn('TEST_FAILURE.md',manifest(active['work']))
    args=launch.call_args.args;self.assertEqual(args[1],'travelagent');self.assertIn('workspace-write',args[3]);self.assertNotIn('danger-full-access',args[3])
    self.assertEqual(update.call_args.args[1],'running');self.assertFalse(update.call_args.args[3]['publishable'])
    self.assertTrue((root/'tests-first.log').is_file())
    active['phase']='tests';active['process']=MagicMock(returncode=1);active['process'].poll.return_value=1
    self.assertTrue(service.finish_step(active));self.assertEqual(launch.call_count,1);self.assertEqual(update.call_args.args[1],'failed')
 def test_success_is_ready_not_published_and_preserves_retry_history(self):
  with tempfile.TemporaryDirectory() as d:
   active=self.active(Path(d));active['process'].returncode=0;active['process'].poll.return_value=0
   active['report'].update(repair_attempt=1,repair_history=[{'tests':'first failure'}])
   with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'start_repair') as repair:
    self.assertTrue(service.finish_step(active));repair.assert_not_called();self.assertEqual(update.call_args.args[1],'ready')
    report=update.call_args.kwargs['report'];self.assertEqual(report['repair_history'][0]['tests'],'first failure');self.assertEqual(report['outcome'],'candidate')
 def test_cancel_and_total_timeout_prevent_retry(self):
  for cancel,elapsed,expected in [(True,0,'cancelled'),(False,1221,'failed')]:
   with self.subTest(expected=expected),tempfile.TemporaryDirectory() as d:
    active=self.active(Path(d));active['task_started']=time.time()-elapsed
    with patch.object(service,'read',return_value={'cancel_requested':cancel}),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'start_repair') as repair:
     self.assertTrue(service.finish_step(active));repair.assert_not_called();self.assertEqual(update.call_args.args[1],expected)
 def test_backup_busy_does_not_consume_repair_attempt(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);active=self.active(root)
   with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'update',side_effect=service.DatabaseBusy),patch.object(service,'own_tree'),patch.object(service,'launch') as launch:
    with self.assertRaises(service.DatabaseBusy):service.finish_step(active)
    self.assertFalse(active.get('repair_attempt'));launch.assert_not_called()
 def test_reseal_removes_stale_files_and_manual_changes_do_not_retry(self):
  for name,expected in [('app.py','tests'),('migration.sql','manual'),('README.md','done')]:
   with self.subTest(name=name),tempfile.TemporaryDirectory() as d:
    root=Path(d);active=self.active(root,'model');baseline=root/'baseline';baseline.mkdir();(baseline/'app.py').write_text('v=1');(baseline/'README.md').write_text('old')
    for p in baseline.iterdir():(active['work']/p.name).write_text(p.read_text())
    (active['work']/name).write_text('changed');candidate=root/'candidate';candidate.mkdir();(candidate/'stale.sql').write_text('must disappear')
    active['process'].returncode=0;active['process'].poll.return_value=0
    data={'completed':True,'errors':[],'result':'实现说明','progress':[],'usage':{'input_tokens':10},'web_search_count':0}
    with patch.object(service,'read',return_value={'cancel_requested':False}),patch.object(service,'stop_unit'),patch.object(service,'update') as update,patch.object(service,'model_output',return_value=data),patch.object(service,'start_tests') as tests,patch.object(service,'start_repair') as repair:
     result=service.finish_step(active);self.assertFalse((candidate/'stale.sql').exists());repair.assert_not_called()
     if expected=='tests':self.assertFalse(result);tests.assert_called_once()
     else:self.assertTrue(result);tests.assert_not_called();self.assertEqual(update.call_args.args[1],expected);self.assertFalse(update.call_args.kwargs['report']['publishable'])
 def test_followup_context_includes_errors_and_current_code_origin(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'PROJECT_CONTEXT.md').write_text('项目说明')
   prior={'prompt':'之前需求','result':'未完成','parent_id':None,'status':'failed','report':{'tests':'FileNotFoundError: migrations/example.sql','reason':'missing artifact','manual_files':['migrations/example.sql']}}
   with patch.object(service,'BASE',root),patch.object(service,'snapshot',return_value={}),patch.object(service,'read',return_value=prior) as read:
    text=service.prompt_for({**self.task(),'parent_id':20},root,'最新正式代码，无旧候选')
    self.assertIn('FileNotFoundError',text);self.assertIn('failed',text);self.assertIn('最新正式代码',(root/'TASK_CONTEXT.md').read_text());self.assertIn("IS DISTINCT FROM 'travel'",read.call_args.args[0])
 def test_usage_is_aggregated_without_boolean_or_negative_values(self):
  r=service.execution_report({'previous_usage':{'input_tokens':123},'repair_attempt':1},{'input_tokens':7,'output_tokens':10,'bad':True,'invalid':-1})
  self.assertEqual(r['usage'],{'input_tokens':130,'output_tokens':10})

if __name__=='__main__':unittest.main()
