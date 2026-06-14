"""Pure-Python .npy row slicing (no numpy). The subset slice-from-master path
relies on these byte copies being identical to the source rows."""
import struct

import pytest

from biblion.npy_slice import _v1_header, read_npy_header, slice_npy_rows


def _write_npy(path, mat):
    """Write a (k, d) `<f4` v1 npy from a list-of-lists, the pure-Python way."""
    k, d = len(mat), len(mat[0])
    payload = b"".join(struct.pack("<f", x) for row in mat for x in row)
    path.write_bytes(_v1_header(k, d) + payload)


def _row_bytes(path, i):
    n, d, _dtype, off = read_npy_header(path)
    with open(path, "rb") as f:
        f.seek(off + i * d * 4)
        return f.read(d * 4)


@pytest.mark.unit
def test_read_npy_header(tmp_path):
    src = tmp_path / "m.npy"
    _write_npy(src, [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    n, d, dtype, off = read_npy_header(src)
    assert (n, d, dtype) == (2, 3, "<f4")
    # header must be 64-byte aligned (magic+version+len+dict).
    assert off % 64 == 0


@pytest.mark.unit
def test_slice_rows_byte_identical_and_reordered(tmp_path):
    src = tmp_path / "m.npy"
    mat = [[0.0, 0.1, 0.2, 0.3],
           [1.0, 1.1, 1.2, 1.3],
           [2.0, 2.1, 2.2, 2.3],
           [3.0, 3.1, 3.2, 3.3]]
    _write_npy(src, mat)

    dst = tmp_path / "s.npy"
    k, d = slice_npy_rows(src, [2, 0], dst)        # reorder: row 2 then row 0
    assert (k, d) == (2, 4)

    n, dd, dtype, _off = read_npy_header(dst)
    assert (n, dd, dtype) == (2, 4, "<f4")
    # Δ=0: sliced rows are byte-for-byte the source rows.
    assert _row_bytes(dst, 0) == _row_bytes(src, 2)
    assert _row_bytes(dst, 1) == _row_bytes(src, 0)


@pytest.mark.unit
def test_slice_rejects_bad_magic_and_oob(tmp_path):
    bad = tmp_path / "bad.npy"
    bad.write_bytes(b"not-an-npy-file-at-all")
    with pytest.raises(ValueError):
        read_npy_header(bad)

    src = tmp_path / "m.npy"
    _write_npy(src, [[1.0, 2.0]])
    with pytest.raises(IndexError):
        slice_npy_rows(src, [5], tmp_path / "s.npy")
