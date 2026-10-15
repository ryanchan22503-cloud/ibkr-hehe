"""Bounded Windows DPAPI operations using only the standard library."""
import base64
import ctypes
from ctypes import wintypes
import json
import sys


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def transform(operation, data):
    if sys.platform != "win32" or operation not in ("protect", "unprotect") or not 0 < len(data) <= 512_000:
        raise ValueError("Invalid operation")
    crypt = ctypes.WinDLL("crypt32.dll", use_last_error=True, winmode=0x800)
    kernel = ctypes.WinDLL("kernel32.dll", use_last_error=True, winmode=0x800)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    pointer = ctypes.POINTER(Blob)
    crypt.CryptProtectData.argtypes = [pointer, wintypes.LPCWSTR, pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, pointer]
    crypt.CryptUnprotectData.argtypes = [pointer, ctypes.POINTER(wintypes.LPWSTR), pointer, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, pointer]
    crypt.CryptProtectData.restype = crypt.CryptUnprotectData.restype = wintypes.BOOL
    source_buffer = ctypes.create_string_buffer(data)
    entropy = b"IBKR Options Advisor: OpenAI settings v1"
    entropy_buffer = ctypes.create_string_buffer(entropy)
    source = Blob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    extra = Blob(len(entropy), ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    function = crypt.CryptProtectData if operation == "protect" else crypt.CryptUnprotectData
    try:
        # Current-user scope (no LOCAL_MACHINE flag); never display a prompt.
        if not function(ctypes.byref(source), None, ctypes.byref(extra), None, None, 1, ctypes.byref(output)):
            raise OSError("Windows protection failed")
        if not 0 < output.size <= 512_000:
            raise ValueError("Unexpected output size")
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.memset(source_buffer, 0, len(source_buffer))
        if output.data:
            ctypes.memset(output.data, 0, output.size)
            kernel.LocalFree(output.data)


def main():
    try:
        raw = sys.stdin.buffer.read(700_001)
        if len(raw) > 700_000:
            raise ValueError("Input too large")
        request = json.loads(raw)
        if not isinstance(request, dict) or set(request) != {"operation", "data"}:
            raise ValueError("Invalid request")
        value = base64.b64decode(request["data"], validate=True)
        sys.stdout.write(base64.b64encode(transform(request["operation"], value)).decode("ascii"))
    except Exception:
        sys.stderr.write("Windows settings protection failed.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
