"""Byte/provenance assertions, without a legal compliance verdict."""
import base64
import hashlib
import json
from pathlib import Path

def verify_dependency_licenses(runtime, packet):
    binding=runtime['dependencyLicenses']
    data=Path(packet).read_bytes()
    assert hashlib.sha256(data).hexdigest()==binding['sha256'], 'dependency license packet bytes'
    value=json.loads(data)
    assert value['runtimeClosureSha256']==runtime['closureSha256']
    assert [{'path':r['path'],'narHash':r['narHash']} for r in value['entries']]==runtime['closure'], 'dependency license exact closure'
    for row in value['entries']:
        assert row['evaluatedOutput']==row['path']
        assert row['sourceNarHash']==value['sourceNarHashes'][row['source']]
        assert row['licenseDeclaration'] or row['noticeBytes'], 'missing license declaration/notice'
        for notice in row['noticeBytes']:
            assert hashlib.sha256(base64.b64decode(notice['base64'],validate=True)).hexdigest()==notice['sha256']
    return {'status':value['status'],'paths':len(value['entries']),'packetSha256':binding['sha256'],'claim':value['claim']}
