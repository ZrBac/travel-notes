import hashlib
import io
import json
import os
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ops import choose_recovery, clean_data
from backup import prune_backups, verify_archive
from releases import unpack_release, replace_code
import releases


class OperationsTests(unittest.TestCase):
    def test_recovery_threshold_cooldown_and_database_failure(self):
        services={s:'active' for s in ('postgresql','travel-notes','nginx')}
        state={}
        for i in range(2):
            state,target=choose_recovery(state,0,502,services,10000+i*120)
            self.assertIsNone(target)
        state,target=choose_recovery(state,0,502,services,10240)
        self.assertEqual(target,'travel-notes')
        state['last_recovery']=10240
        self.assertIsNone(choose_recovery(state,0,502,services,10360)[1])
        self.assertEqual(choose_recovery(state,200,502,services,13000)[1],'nginx')
        self.assertIsNone(choose_recovery(state,503,503,services,13000)[1])
        self.assertIsNone(choose_recovery(state,0,502,{**services,'postgresql':'failed'},13000)[1])
        self.assertIsNone(choose_recovery(state,0,502,{**services,'travel-notes':'inactive'},13000)[1])
        state['maintenance_until']=14000
        paused,target=choose_recovery(state,0,502,services,13000)
        self.assertEqual(paused['failures'],0);self.assertIsNone(target)
        healthy,_=choose_recovery(state,200,200,services,15000)
        self.assertEqual(healthy['failures'],0)

    def test_cleanup_preserves_uploads_active_previews_and_other_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);timestamp=time.time()
            for token,created in [('a'*32,timestamp-90000),('b'*32,timestamp-20),('keep-me',0)]:
                path=root/'html-imports'/token;path.mkdir(parents=True)
                (path/'manifest.json').write_text(json.dumps({'created':created}))
            original=root/'uploads'/'original.webp';original.parent.mkdir();original.write_bytes(b'keep')
            cache=root/'image-cache';cache.mkdir();expired=cache/'old.webp';expired.write_bytes(b'cache');os.utime(expired,(0,0))
            fresh=cache/'fresh.webp';fresh.write_bytes(b'cache')
            (cache/'linked.webp').symlink_to(original)
            self.assertEqual(clean_data(root,timestamp),2)
            self.assertEqual(original.read_bytes(),b'keep')
            self.assertTrue((root/'html-imports'/('b'*32)).exists())
            self.assertTrue((root/'html-imports'/'keep-me').exists())
            self.assertTrue(fresh.exists())

    def test_backup_retention_keeps_two_copies_even_over_size_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for i in range(9):(root/f'travel-pg-202609{i:02d}.tar.gz').write_bytes(b'x'*10)
            other=root/'old-sqlite.tar.gz';other.write_bytes(b'preserve')
            prune_backups(root,keep=7,max_bytes=1000)
            self.assertEqual(len(list(root.glob('travel-pg-*'))),7)
            prune_backups(root,keep=7,max_bytes=1)
            self.assertEqual(len(list(root.glob('travel-pg-*'))),2)
            self.assertTrue(other.exists())

    def archive(self,path,files):
        with tarfile.open(path,'w:gz') as archive:
            for name,content in files.items():
                raw=content.encode() if isinstance(content,str) else content
                info=tarfile.TarInfo(name);info.size=len(raw)
                archive.addfile(info,io.BytesIO(raw))

    def test_backup_hash_validation_catches_corruption_and_missing_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'backup.tar.gz'
            manifest={'sha256':{'database.dump':hashlib.sha256(b'correct').hexdigest()}}
            self.archive(path,{'manifest.json':json.dumps(manifest),'database.dump':'correct'})
            self.assertEqual(verify_archive(path),manifest)
            self.archive(path,{'manifest.json':json.dumps(manifest),'database.dump':'corrupt'})
            with self.assertRaises(ValueError):verify_archive(path)
            self.archive(path,{'manifest.json':json.dumps(manifest)})
            with self.assertRaises(ValueError):verify_archive(path)

    def test_code_restore_checks_paths_and_preserves_runtime_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'release.tar.gz';stage=root/'stage';stage.mkdir()
            manifest={'files':{'app.py':hashlib.sha256(b'new source').hexdigest()}}
            self.archive(path,{'release.json':json.dumps(manifest),'app/app.py':'new source'})
            unpack_release(path,stage)
            live=root/'live';live.mkdir();(live/'app.py').write_text('old source');(live/'removed.py').write_text('old')
            for directory in ('uploads','.venv','content'):
                p=live/directory;p.mkdir();(p/'preserve').write_text('keep')
            replace_code(stage/'app',manifest,live)
            self.assertEqual((live/'app.py').read_text(),'new source');self.assertFalse((live/'removed.py').exists())
            for directory in ('uploads','.venv','content'):self.assertEqual((live/directory/'preserve').read_text(),'keep')
            manifest={'files':{'../../escape':hashlib.sha256(b'x').hexdigest()}}
            self.archive(path,{'release.json':json.dumps(manifest),'app/../../escape':'x'})
            with self.assertRaises(ValueError):unpack_release(path,stage)
            self.assertFalse((root/'escape').exists())

    def test_rollback_restores_previous_code_if_health_check_fails(self):
        for healthy in (True,False):
            with self.subTest(healthy=healthy),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);live=root/'app';live.mkdir()
                for name,value in [('app.py','old code'),('schema.sql','same schema'),('requirements.txt','same dependencies')]:
                    (live/name).write_text(value)
                with patch.object(releases,'BASE',live),patch.object(releases,'ROOT',root/'releases'):
                    saved=releases.checkpoint('old');name=saved.name.removesuffix('.tar.gz')
                    (live/'app.py').write_text('current code')
                    with patch('releases.subprocess.run') as run,patch('ops.probe',return_value=200 if healthy else 500),patch('releases.time.sleep'):
                        if healthy:
                            releases.rollback(name)
                            self.assertEqual((live/'app.py').read_text(),'old code')
                        else:
                            with self.assertRaises(RuntimeError):releases.rollback(name)
                            self.assertEqual((live/'app.py').read_text(),'current code')
                        self.assertEqual(run.call_args_list[0].args[0],['systemctl','start','travel-notes-backup.service'])
                        self.assertEqual(run.call_args_list[-1].args[0][-1],'resume')

    def test_schema_change_blocks_automatic_rollback_before_any_side_effect(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);live=root/'app';live.mkdir()
            for name in ('app.py','schema.sql','requirements.txt'):(live/name).write_text('old')
            with patch.object(releases,'BASE',live),patch.object(releases,'ROOT',root/'releases'):
                saved=releases.checkpoint('old');(live/'schema.sql').write_text('new schema')
                with patch('releases.subprocess.run') as run:
                    with self.assertRaises(ValueError):releases.rollback(saved.name.removesuffix('.tar.gz'))
                    run.assert_not_called()


if __name__=='__main__':unittest.main()
