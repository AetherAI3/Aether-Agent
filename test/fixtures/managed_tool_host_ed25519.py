"""Pure-Python RFC 8032 Ed25519 for the managed tool host mirror (stdlib only).

Independent of Node's OpenSSL-backed implementation, so agreement on the
golden signatures is evidence rather than a tautology. verify() follows RFC
8032 section 5.1.7: both points must decode (y < p, and no x = 0 with the sign
bit set), S must be below the group order L, and [S]B must equal R + [k]A.
sign() exists only to self-check the fixture's test keys.
"""

from __future__ import annotations

import hashlib

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)
IDENTITY = (0, 1, 1, 0)


def _inverse(x: int) -> int:
    return pow(x, P - 2, P)


def _add(a: tuple, b: tuple) -> tuple:
    """Extended twisted Edwards addition (RFC 8032 section 5.1.4)."""
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    aa = (y1 - x1) * (y2 - x2) % P
    bb = (y1 + x1) * (y2 + x2) % P
    cc = 2 * t1 * t2 * D % P
    dd = 2 * z1 * z2 % P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _multiply(scalar: int, point: tuple) -> tuple:
    result = IDENTITY
    while scalar > 0:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _equal(a: tuple, b: tuple) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % P == 0 and (a[1] * b[2] - b[1] * a[2]) % P == 0


def _recover_x(y: int, sign: int) -> int | None:
    if y >= P:
        return None
    x2 = (y * y - 1) * _inverse(D * y * y + 1) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P != 0:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


_BASE_Y = 4 * _inverse(5) % P
_BASE_X = _recover_x(_BASE_Y, 0)
BASE = (_BASE_X, _BASE_Y, 1, _BASE_X * _BASE_Y % P)


def _compress(point: tuple) -> bytes:
    z_inverse = _inverse(point[2])
    x = point[0] * z_inverse % P
    y = point[1] * z_inverse % P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(encoded: bytes) -> tuple | None:
    if len(encoded) != 32:
        return None
    y = int.from_bytes(encoded, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % P)


def _hash_scalar(data: bytes) -> int:
    return int.from_bytes(hashlib.sha512(data).digest(), "little") % L


def _expand(seed: bytes) -> tuple[int, bytes]:
    digest = hashlib.sha512(seed).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar &= (1 << 254) - 8
    scalar |= 1 << 254
    return scalar, digest[32:]


def public_key(seed: bytes) -> bytes:
    if len(seed) != 32:
        raise ValueError("an Ed25519 seed is 32 bytes")
    scalar, _ = _expand(seed)
    return _compress(_multiply(scalar, BASE))


def sign(seed: bytes, message: bytes) -> bytes:
    scalar, prefix = _expand(seed)
    encoded_a = _compress(_multiply(scalar, BASE))
    r = _hash_scalar(prefix + message)
    encoded_r = _compress(_multiply(r, BASE))
    k = _hash_scalar(encoded_r + encoded_a + message)
    return encoded_r + int.to_bytes((r + k * scalar) % L, 32, "little")


def verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    point_a = _decompress(public)
    point_r = _decompress(signature[:32])
    if point_a is None or point_r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    k = _hash_scalar(signature[:32] + public + message)
    return _equal(_multiply(s, BASE), _add(point_r, _multiply(k, point_a)))
