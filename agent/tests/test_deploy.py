"""Exercise publishing against temporary code with service controls mocked."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import service
from artifacts import copy_code,compare,manifest,fingerprint


class DeployTests(unittest.TestCase):
    def setup(self,root):
        live=root/'live';live.mkdir();(live/'app.py').write_text('version=1\n')
        private=root/'private';candidate=private/'1'/'candidate';copy_code(live,candidate);(candidate/'app.py').write_text('version=2\n')
        report=compare(live,candidate);report['publishable']=True
        (private/'1'/'report.json').write_text(json.dumps(report))
        task={'id':2,'kind':'publish','parent_id':1,'request':{'artifact':report['artifact']}}
        return live,private,task
    def test_publish_and_failure_restore(self):
        for success in (True,False):
            with self.subTest(success=success),tempfile.TemporaryDirectory() as d:
                live,private,task=self.setup(Path(d));updates=[];reports=[]
                with patch.object(service,'LIVE',live),patch.object(service,'PRIVATE',private),patch.object(service,'checked',return_value=''),patch.object(service,'update',side_effect=lambda *a,**k:(updates.append(a),reports.append(k.get('report')))),patch.object(service,'probe',return_value=success),patch.object(service.time,'sleep'):
                    if success:
                        service.deploy(task);self.assertEqual((live/'app.py').read_text(),'version=2\n');self.assertEqual(updates[-1][1],'done');self.assertEqual(reports[-2]['outcome'],'published');self.assertNotIn('尚未发布',reports[-2]['reason'])
                    else:
                        with self.assertRaises(RuntimeError):service.deploy(task)
                        self.assertEqual((live/'app.py').read_text(),'version=1\n')
                    self.assertFalse((private/'deployment.json').exists())
    def test_stale_or_tampered_candidate_never_publishes(self):
        for tamper in ('live','candidate'):
            with self.subTest(tamper=tamper),tempfile.TemporaryDirectory() as d:
                live,private,task=self.setup(Path(d));target=live if tamper=='live' else private/'1'/'candidate';(target/'app.py').write_text('version=3\n')
                with patch.object(service,'LIVE',live),patch.object(service,'PRIVATE',private),patch.object(service,'checked') as controls,patch.object(service,'update'):
                    with self.assertRaises(ValueError):service.deploy(task)
                    controls.assert_not_called()
    def test_interrupted_publish_recovers_saved_code(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);live,private,task=self.setup(root);copy_code(live,private/'2'/'rescue');(live/'app.py').write_text('broken\n');(private/'deployment.json').write_text(json.dumps({'task_id':2}))
            with patch.object(service,'LIVE',live),patch.object(service,'PRIVATE',private),patch.object(service,'checked'):
                service.recover_release()
            self.assertEqual((live/'app.py').read_text(),'version=1\n');self.assertFalse((private/'deployment.json').exists())

    def test_business_review_is_checked_again_before_any_release_side_effects(self):
        for reviewed in (False,True):
            with self.subTest(reviewed=reviewed),tempfile.TemporaryDirectory() as d:
                live,private,task=self.setup(Path(d))
                (live/'trip_api.py').write_text('v=1')
                candidate=private/'1'/'candidate';(candidate/'trip_api.py').write_text('v=2')
                report=compare(live,candidate);report['publishable']=True
                (private/'1'/'report.json').write_text(json.dumps(report));task['request']={'artifact':report['artifact'],'reviewed':reviewed}
                with patch.object(service,'LIVE',live),patch.object(service,'PRIVATE',private),patch.object(service,'checked',return_value='') as controls,patch.object(service,'update'),patch.object(service,'probe',return_value=True):
                    if reviewed:
                        service.deploy(task);self.assertEqual((live/'trip_api.py').read_text(),'v=2')
                    else:
                        with self.assertRaises(ValueError):service.deploy(task)
                        controls.assert_not_called();self.assertEqual((live/'trip_api.py').read_text(),'v=1')

    def test_protected_candidate_still_cannot_publish_even_with_reviewed_flag(self):
        with tempfile.TemporaryDirectory() as d:
            live,private,task=self.setup(Path(d));candidate=private/'1'/'candidate'
            (candidate/'schema.sql').write_text('new schema')
            report=compare(live,candidate);report['publishable']=True
            (private/'1'/'report.json').write_text(json.dumps(report));task['request']={'artifact':report['artifact'],'reviewed':True}
            with patch.object(service,'LIVE',live),patch.object(service,'PRIVATE',private),patch.object(service,'checked') as controls,patch.object(service,'update'):
                with self.assertRaises(ValueError):service.deploy(task)
                controls.assert_not_called();self.assertFalse((live/'schema.sql').exists())


if __name__=='__main__':unittest.main()
