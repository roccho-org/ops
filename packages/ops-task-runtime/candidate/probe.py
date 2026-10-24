"""Run-bound observational fixtures; static selftest is a separate real leaf."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def emit(name, data):
    root = Path('out')
    root.mkdir(exist_ok=True)
    data.update(x=os.environ['OPS_CANDIDATE_X'], inputSha256=hashlib.sha256(Path('input.bin').read_bytes()).hexdigest())
    p = root / (name + '.json')
    with p.with_suffix('.partial').open('x') as f:
        json.dump(data, f, sort_keys=True)
    os.replace(p.with_suffix('.partial'), p)


op = sys.argv[1]
if op == 'run':
    start = time.monotonic_ns()
    emit(sys.argv[2] + '-started', {'pid': os.getpid(), 'start': start})
    time.sleep(2)
    emit(sys.argv[2], {'pid': os.getpid(), 'start': start, 'end': time.monotonic_ns(), 'value': sys.argv[2]})
elif op == 'join':
    a, b = [json.loads(Path('out', n + '.json').read_text()) for n in ('a', 'b')]
    assert a['x'] == b['x'] == os.environ['OPS_CANDIDATE_X']
    assert max(a['start'], b['start']) < min(a['end'], b['end'])
    emit('result', {'status': 'PASS', 'semantic': 'AB', 'join': time.monotonic_ns(), 'start': min(a['start'], b['start']), 'end': max(a['end'], b['end'])})
elif op == 'fail':
    emit('failure', {'status': 'EXPECTED_FAILURE', 'errorClass': 'fixture-root-failure', 'leafExit': 7})
    sys.exit(7)
elif op == 'forbidden':
    emit('forbidden', {'status': 'INVALID'})
else:
    raise SystemExit('unknown operation')
