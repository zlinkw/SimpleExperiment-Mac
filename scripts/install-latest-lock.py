import fcntl
import os
import stat
import sys

target = os.path.abspath(sys.argv[1])
parent = os.path.dirname(target)
if os.path.realpath(parent) != parent:
    raise RuntimeError('Unsafe install lock parent')
fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Unsafe install lock target')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('LOCKED', flush=True)
    sys.stdin.readline()
finally:
    os.close(fd)
