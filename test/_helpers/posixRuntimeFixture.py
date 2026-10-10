"""POSIX calls over retained real NTFS inputs; actual bytes, inodes and ChangeTime."""
import os
import pathlib
import posixpath
import stat
from types import SimpleNamespace


def bind_posix_runtime(agent, base):
    def native(value):
        text = os.fspath(value)
        if os.name == "nt" and (text == "/fixture" or text.startswith("/fixture/")):
            return os.path.join(base, *text[len("/fixture"):].lstrip("/").split("/"))
        return text

    def virtual(value):
        text = os.fspath(value)
        if os.name != "nt":
            return text
        plain = os.path.normpath(text).removeprefix("\\\\?\\")
        plain_base = os.path.normpath(base).removeprefix("\\\\?\\")
        try:
            if os.path.normcase(os.path.commonpath([plain_base, plain])) != os.path.normcase(plain_base):
                return "/outside"
            relative = os.path.relpath(plain, plain_base).replace("\\", "/")
            return "/fixture" if relative == "." else "/fixture/" + relative
        except ValueError:
            return "/outside"

    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes

        class FileBasicInfo(ctypes.Structure):
            _fields_ = [(key, ctypes.c_longlong) for key in ("CreationTime", "LastAccessTime", "LastWriteTime", "ChangeTime")] + [("FileAttributes", wintypes.DWORD)]

        # https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info
        query = ctypes.WinDLL("kernel32", use_last_error=True).GetFileInformationByHandleEx
        query.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        query.restype = wintypes.BOOL

        class StatView:
            def __init__(self, info, change_time):
                self.info = info
                self.st_ctime_ns = change_time
            def __getattr__(self, name):
                return getattr(self.info, name)

        def descriptor_info(descriptor):
            info, basic = os.fstat(descriptor), FileBasicInfo()
            if not query(msvcrt.get_osfhandle(descriptor), 0, ctypes.byref(basic), ctypes.sizeof(basic)):
                raise ctypes.WinError(ctypes.get_last_error())
            return StatView(info, (basic.ChangeTime - 116444736000000000) * 100)

        def path_info(value, follow=True):
            file = native(value)
            info = os.stat(file) if follow else os.lstat(file)
            if not stat.S_ISREG(info.st_mode):
                return info
            descriptor = os.open(file, os.O_RDONLY | os.O_BINARY)
            try:
                opened = descriptor_info(descriptor)
                if (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
                    raise ValueError("Native fixture path changed during metadata query")
                return StatView(info, opened.st_ctime_ns)
            finally:
                os.close(descriptor)

        class Proxy(SimpleNamespace):
            def __getattr__(self, key):
                return getattr(os, key)

        paths = SimpleNamespace(**{key: getattr(posixpath, key) for key in ("join", "dirname", "basename", "splitext", "isabs", "normpath", "relpath", "commonpath")})
        paths.abspath = lambda value: posixpath.normpath(value if str(value).startswith("/") else posixpath.join("/fixture", value))
        paths.realpath = lambda value: virtual(os.path.realpath(native(value)))
        for key in ("exists", "isfile", "isdir", "lexists", "getsize", "getmtime"):
            setattr(paths, key, lambda value, key=key: getattr(os.path, key)(native(value)))

        def walk(value, *args, **kwargs):
            for current, dirs, files in os.walk(native(value), *args, **kwargs):
                yield virtual(current), dirs, files

        agent.os = Proxy(path=paths, sep="/", listdir=lambda value: os.listdir(native(value)),
                         makedirs=lambda value, *args, **kwargs: os.makedirs(native(value), *args, **kwargs),
                         stat=path_info, lstat=lambda value: path_info(value, False), fstat=descriptor_info, walk=walk,
                         open=lambda value, flags, *args, **kwargs: os.open(native(value), flags | os.O_BINARY, *args, **kwargs))
        agent.open = lambda value, *args, **kwargs: open(native(value), *args, **kwargs)
        agent.pathlib = SimpleNamespace(Path=lambda value: pathlib.Path(native(value)))
        original_glob = agent.glob
        agent.glob = SimpleNamespace(glob=lambda value, *args, **kwargs: [virtual(item) for item in original_glob.glob(native(value), *args, **kwargs)])
    return native, virtual
