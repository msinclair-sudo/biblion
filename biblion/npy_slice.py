"""Pure-Python `.npy` row-slicing -- no numpy, so this stays in the light core
env (numpy is an optional `[embed]` extra; see pyproject.toml).

Mirrors the toy's reader (network_toy/app/src/datasource/npy.js): only v1/v2
magic, `'<f4'` (little-endian float32), 2-D C-order. That's all `biblion
advanced embedding` (embed.py) ever writes. Used to carve a subset's
`embeddings.npy` straight out of the project master by copying whole rows --
SPECTER2 is set-independent, so the bytes are identical to a re-embed.
"""
import re
import struct
from pathlib import Path

_MAGIC = b"\x93NUMPY"


def read_npy_header(path):
    """Return (n, d, dtype, data_offset) for a 2-D `.npy` at `path`.

    data_offset is the byte position where row 0 begins. Raises ValueError on a
    bad magic / non-2-D shape; the dtype is returned verbatim (callers that copy
    raw bytes must check it is `'<f4'`).
    """
    with open(path, "rb") as f:
        pre = f.read(8)  # magic(6) + version(2)
        if pre[:6] != _MAGIC:
            raise ValueError(f"[npy] not an .npy file (bad magic): {path}")
        if pre[6] == 1:
            (hlen,) = struct.unpack("<H", f.read(2))
            hdr_start = 10
        else:
            (hlen,) = struct.unpack("<I", f.read(4))
            hdr_start = 12
        header = f.read(hlen).decode("ascii")
        data_offset = hdr_start + hlen

    m = re.search(r"'descr':\s*'([^']+)'", header)
    if not m:
        raise ValueError(f"[npy] no descr in header: {header!r}")
    dtype = m.group(1)
    m = re.search(r"'shape':\s*\(([^)]*)\)", header)
    if not m:
        raise ValueError(f"[npy] no shape in header: {header!r}")
    dims = [int(x) for x in re.findall(r"\d+", m.group(1))]
    if len(dims) != 2:
        raise ValueError(f"[npy] expected 2-D shape; got {dims}")
    n, d = dims
    return n, d, dtype, data_offset


def _v1_header(k, d):
    """Build a padded v1 header (magic + len + dict) for a (k, d) `<f4` array."""
    body = "{'descr': '<f4', 'fortran_order': False, 'shape': (%d, %d), }" % (k, d)
    # numpy aligns the whole header (magic+version+len+dict) to 64 bytes,
    # terminated by '\n'. magic=6, version=2, len=2 -> 10 bytes precede the dict.
    pad = (64 - (10 + len(body) + 1) % 64) % 64
    body = body + " " * pad + "\n"
    return _MAGIC + b"\x01\x00" + struct.pack("<H", len(body)) + body.encode("ascii")


def slice_npy_rows(src, row_indices, dst):
    """Write a (k, d) `<f4` `.npy` at `dst` from rows `row_indices` of `src`.

    Copies each wanted row's d*4 raw bytes -- no float parsing, so the output is
    byte-identical to the source rows. `src` must be `'<f4'`.
    """
    n, d, dtype, data_offset = read_npy_header(src)
    if dtype != "<f4":
        raise ValueError(f"[npy] expected dtype '<f4'; got {dtype!r}")
    rowbytes = d * 4
    src = Path(src)
    with open(src, "rb") as f, open(dst, "wb") as out:
        out.write(_v1_header(len(row_indices), d))
        for idx in row_indices:
            if not (0 <= idx < n):
                raise IndexError(f"[npy] row {idx} out of range (n={n})")
            f.seek(data_offset + idx * rowbytes)
            out.write(f.read(rowbytes))
    return len(row_indices), d
