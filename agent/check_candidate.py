"""Trusted checks, executed as a separate unprivileged test user."""
import ast
import os
from pathlib import Path
import subprocess
import sys

root=Path(sys.argv[1]).resolve()
os.chdir(root)
for name in root.glob('*.py'): ast.parse(name.read_text(),filename=str(name))
for name in (root/'static').glob('*.js'):
    subprocess.run(['/usr/bin/node','--check',str(name)],check=True,timeout=20)
# Always run the baseline test suite, even if a candidate changes/removes its tests.
for test_root in [Path(sys.argv[2]),root/'tests']:
    subprocess.run([sys.executable,'-m','unittest','discover','-s',str(test_root),'-p','test*.py'],
                   env={**os.environ,'PYTHONPATH':str(root),'TRAVEL_CANDIDATE_ROOT':str(root)},check=True,timeout=240)
print('语法检查、基线测试与候选测试全部通过。',flush=True)
