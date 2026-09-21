import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from artifacts import manifest,compare,copy_code,replace,fingerprint


class ArtifactTests(unittest.TestCase):
    def test_links_and_special_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'app.py').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):manifest(root)
            (root/'app.py').unlink();os.mkfifo(root/'app.py')
            with self.assertRaises(ValueError):manifest(root)
            (root/'app.py').unlink();(root/'static').mkdir();(root/'static'/'linked').symlink_to('/etc',target_is_directory=True)
            with self.assertRaises(ValueError):manifest(root)
    def test_review_blocks_operations_and_new_root_modules(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'old';new=Path(d)/'new';old.mkdir()
            (old/'app.py').write_text('a=1\n');(old/'ops.py').write_text('x=1\n');copy_code(old,new)
            (new/'app.py').write_text('a=2\n');report=compare(old,new)
            self.assertEqual(report['manual_files'],[]);self.assertIn('+a=2',report['diff'])
            (new/'ops.py').write_text('x=2\n');(new/'json.py').write_text('shadow=True\n')
            self.assertEqual(compare(old,new)['manual_files'],['json.py','ops.py'])
    def test_migrations_are_retained_but_always_require_manual_review(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'old';work=Path(d)/'work';sealed=Path(d)/'sealed'
            old.mkdir();(old/'app.py').write_text('a=1\n');copy_code(old,work)
            (work/'migrations').mkdir();migration=work/'migrations'/'add_admin.sql'
            migration.write_text('-- Parameterized migration requires separate execution\n')
            copy_code(work,sealed)
            self.assertEqual((sealed/'migrations'/'add_admin.sql').read_bytes(),migration.read_bytes())
            self.assertEqual(compare(old,sealed)['manual_files'],['migrations/add_admin.sql'])
            digest=fingerprint(manifest(sealed));(sealed/'migrations'/'add_admin.sql').write_text('-- changed\n')
            self.assertNotEqual(digest,fingerprint(manifest(sealed)))
            (work/'migrations'/'unsafe.sql').symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):manifest(work)

    def test_sealed_digest_changes_and_replacement_preserves_runtime(self):
        with tempfile.TemporaryDirectory() as d:
            old=Path(d)/'old';new=Path(d)/'new';old.mkdir();(old/'app.py').write_text('a=1\n');copy_code(old,new)
            digest=fingerprint(manifest(new));(new/'app.py').write_text('a=2\n')
            self.assertNotEqual(digest,fingerprint(manifest(new)))
            (old/'uploads').mkdir();(old/'uploads'/'image').write_text('original');replace(new,old)
            self.assertEqual((old/'app.py').read_text(),'a=2\n');self.assertEqual((old/'uploads'/'image').read_text(),'original')


if __name__=='__main__':unittest.main()
