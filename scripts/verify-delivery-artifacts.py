"""Read-only delivery check; stream hashes without extracting archives or creating bytecode."""
import hashlib
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET


def digest(handle):
    value = hashlib.sha256()
    for block in iter(lambda: handle.read(65536), b''):
        value.update(block)
    return value.hexdigest()


def check(root):
    root = pathlib.Path(root).resolve(strict=True)
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    artifact = root / f"{package['name']}-{package['version']}.vsix"
    manifest = root / 'dist/panel-build-manifest.json'
    if manifest.exists():
        rows = json.loads(manifest.read_text(encoding='utf-8'))['files']
    else:
        rows = [{'path': name} for name in package['files']]
    with zipfile.ZipFile(artifact) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), 'Duplicate archive entries'
        assert not any('__pycache__' in name or name.endswith('.pyc') or '/node_modules/' in name for name in names), 'Unexpected runtime cache/dependency'
        packed = json.loads(archive.read('extension/package.json').decode('utf-8'))
        assert (packed['name'], packed['publisher'], packed['version']) == (package['name'], package['publisher'], package['version']), 'Package identity mismatch'
        identity = next(node for node in ET.fromstring(archive.read('extension.vsixmanifest')).iter() if node.tag.split('}')[-1] == 'Identity')
        assert (identity.attrib['Id'], identity.attrib['Publisher'], identity.attrib['Version']) == (package['name'], package['publisher'], package['version']), 'VSIX identity mismatch'
        for row in rows:
            name = row['path']
            assert not pathlib.PurePosixPath(name).is_absolute() and '..' not in pathlib.PurePosixPath(name).parts
            info = archive.getinfo('extension/' + name)
            assert info.file_size <= 16 * 1024 * 1024, 'Unbounded package member'
            with (root / name).open('rb') as source, archive.open(info) as member:
                expected, actual = digest(source), digest(member)
            assert expected == actual, f'Artifact differs from source: {name}'
            if row.get('sha256'):
                assert actual == row['sha256'], f'Build manifest mismatch: {name}'
    print(f"{package['name']} {package['version']}: {len(rows)} hashes/identity verified, {artifact.stat().st_size} bytes")


for directory in sys.argv[1:]:
    check(directory)
