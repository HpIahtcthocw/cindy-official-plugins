"""Build the settings-page ZIP from an explicit extension and reviewed vendor file list."""
from pathlib import Path
import json
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent / 'my-browser'
files = ['manifest.json', 'background.js', 'policy.js', 'network-guard.js', 'popup.html', 'popup.js',
         'ui.js', 'learning-core.js', 'content.js', 'library.html', 'library.js', 'reader-pdf.js', 'ocr.js', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png']
files += json.loads((root / 'extension/vendor-files.json').read_text())
if any(Path(name).is_absolute() or '..' in Path(name).parts for name in files):
    raise ValueError('Unsafe extension asset path')
files.append('THIRD-PARTY-LICENSES.txt')
target = root / 'downloads' / 'my-browser-chromium.zip'
target.parent.mkdir(exist_ok=True)
with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
    for name in files:
        entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        entry.compress_type = ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, (root / name if name == 'THIRD-PARTY-LICENSES.txt' else root / 'extension' / name).read_bytes())
print(target)
