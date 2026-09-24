import importlib.util,json,os,subprocess,sys,tempfile,time,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard',Path(__file__).resolve().parents[1]/'guard.py');guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

class GuardTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def command(self,result='login_ready',sleep=0):
        script=self.root/'fake.py';script.write_text("import os,json,time\nfrom pathlib import Path\np=Path(os.environ['XHS_STATE_DIR'])\n(p/'launched').write_text('yes')\ntime.sleep("+str(sleep)+")\n(p/'last-run.json').write_text(json.dumps({'result':"+repr(result)+",'requests':3,'request_types':{'document':1}}))\n")
        return [sys.executable,str(script)]
    def test_success_sets_gap_and_second_run_never_launches(self):
        cmd=self.command();r=guard.check(self.root,cmd,now=1000);self.assertEqual(r['next_allowed_at'],1600)
        (self.root/'launched').unlink();r=guard.check(self.root,cmd,now=1100)
        self.assertEqual(r['result'],'cooldown');self.assertFalse(r['browser_started']);self.assertFalse((self.root/'launched').exists())
    def test_blocked_sets_longer_cooldown(self):
        r=guard.check(self.root,self.command('blocked'),now=1000);self.assertEqual(r['next_allowed_at'],2800)
        self.assertEqual(guard.read_state(self.root)['last_result'],'blocked')
    def test_failed_process_still_reserves_cooldown(self):
        r=guard.check(self.root,['/missing-command'],now=1000);self.assertEqual(r['result'],'error');self.assertEqual(r['next_allowed_at'],1900)
    def test_invalid_state_fails_closed(self):
        (self.root/'control.json').write_text('broken');r=guard.check(self.root,self.command(),now=1000)
        self.assertEqual(r['result'],'state_error');self.assertFalse((self.root/'launched').exists())
    def test_concurrent_process_is_rejected_before_launch(self):
        script=Path(guard.__file__);cmd=self.command(sleep=.8)
        entry="import sys;sys.path.insert(0,"+repr(str(script.parent))+");import guard;guard.check("+repr(str(self.root))+","+repr(cmd)+",now=1000)"
        process=subprocess.Popen([sys.executable,'-c',entry]);self.addCleanup(lambda:process.poll() is None and process.kill())
        deadline=time.monotonic()+3
        while not (self.root/'launched').exists() and time.monotonic()<deadline:time.sleep(.02)
        self.assertTrue((self.root/'launched').exists());r=guard.check(self.root,cmd,now=1000)
        self.assertEqual(r['result'],'busy');self.assertFalse(r['browser_started']);self.assertEqual(process.wait(timeout=3),0)
    def test_process_timeout_has_cooldown(self):
        r=guard.check(self.root,self.command(sleep=1),now=1000,timeout=.05)
        self.assertEqual(r['result'],'timeout');self.assertEqual(r['next_allowed_at'],1900)
    def test_state_is_private(self):
        guard.check(self.root,self.command(),now=1000);self.assertEqual((self.root/'control.json').stat().st_mode&0o777,0o600)

if __name__=='__main__':unittest.main()
