"""After verified backup extraction/config restoration, rebuild Certbot links."""
import json
from pathlib import Path
import sys

root=Path('/etc/letsencrypt')
links=json.loads(Path(sys.argv[1]).read_text())
for name,target in links.items():
    path=Path('/')/name
    if not path.is_relative_to(root/'live') or '..' in path.parts:
        raise ValueError('Invalid certificate link path')
    resolved=(path.parent/target).resolve(strict=True)
    if not resolved.is_relative_to(root/'archive') or not resolved.is_file():
        raise ValueError('Invalid certificate link target')
    if path.is_symlink():
        if path.resolve()==resolved:continue
        path.unlink()
    elif path.exists():raise ValueError('Refusing to replace an existing regular file: '+str(path))
    path.parent.mkdir(parents=True,exist_ok=True)
    path.symlink_to(target)
print('Certificate links restored. Run nginx -t before reloading.')
