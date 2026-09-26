"""Собирает dist/index.html: встраивает модели (base64) прямо в страницу."""
import base64, pathlib
root = pathlib.Path(__file__).parent
page = (root / 'web/index.html').read_text()
blocks = []
for name in ('elf_archer_v2', 'elf_archer_blender', 'kaykit_rogue_hooded'):
    b64 = base64.b64encode((root / f'web/models/{name}.glb').read_bytes()).decode()
    blocks.append(f'<script type="text/plain" data-model="models/{name}.glb.b64.txt">{b64}</script>')
marker = '<script type="importmap">'
page = page.replace(marker, '\n'.join(blocks) + '\n' + marker, 1)
out = root / 'dist/index.html'
out.write_text(page)
print(out, out.stat().st_size)
