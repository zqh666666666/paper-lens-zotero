from pathlib import Path
import json, zipfile
root = Path(__file__).resolve().parents[1]
manifest = json.loads((root/'manifest.json').read_text())
out = root/'dist'/f"paper-lens-{manifest['version']}.xpi"
out.parent.mkdir(exist_ok=True)
files = [root/'manifest.json', root/'bootstrap.js', root/'LICENSE', *sorted(p for p in (root/'src').rglob('*') if p.is_file())]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, path.read_bytes())
print(out)
