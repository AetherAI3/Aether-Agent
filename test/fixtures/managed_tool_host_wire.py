"""Independent Python mirror of the managed tool host wire rules (stdlib only).

docs/CONTRACTS.md section 5. Imports nothing from the TypeScript side or from
any other mirror: this module carries its own strict frame lexer, RFC 8785
encoder, digests and closed-shape checks. Refusal messages are byte-identical
to src/core/managed_tool_host, so every golden vector proves both languages
refuse it for its stated reason. Validators live in
managed_tool_host_objects.py, cross-object checks in managed_tool_host_cross.py
and the harness in managed_tool_host_verify.py.

Cross-language traps handled on purpose:

* RFC 8785 sorts keys by UTF-16 code unit; Python's sorted() compares code
  points. Keys sort on their UTF-16-BE encoding.
* re's `$` matches before a trailing newline and its default classes are
  Unicode-aware; every pattern uses fullmatch and explicit ASCII ranges.
* String length counts Unicode scalar values (code points) on both sides.
* The lexer is json.loads with hooks plus an explicit pre-scan: json.loads
  alone accepts duplicate members, NaN, -0 and big integers and decodes
  escaped controls and lone surrogates silently.
* json.loads("4.0") is a float here but the integer 4 in JavaScript; the
  frame lexer refuses both spellings, and the fixture holds no such value.
* No backslash character appears in this file; escapes are built with chr().
"""

from __future__ import annotations

import base64
import decimal
import hashlib
import json
import re
from typing import Any, Callable, NoReturn

BACKSLASH = chr(92)
QUOTE = chr(34)
LF = chr(10)
MAX_SAFE = 2**53 - 1
MAX_SAFE_DIGITS = str(MAX_SAFE)
MAX_FRAME_BYTES = 262144
MAX_FRAME_DEPTH = 16
MAX_STRING_SCALARS = 256
MAX_ARRAY_ENTRIES = 32
CLOCK_SKEW_MS = 30000


class ContractError(ValueError):
    """A refusal at the managed tool host contract boundary."""


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = _Missing()


def fail(message: str) -> NoReturn:
    raise ContractError(message)


# --- RFC 8785 --------------------------------------------------------------------

class CanonicalError(ValueError):
    """A value with no RFC 8785 form."""


_SHORT_ESCAPES = {34: BACKSLASH + QUOTE, 92: BACKSLASH + BACKSLASH, 8: BACKSLASH + "b", 12: BACKSLASH + "f",
                  10: BACKSLASH + "n", 13: BACKSLASH + "r", 9: BACKSLASH + "t"}


def _canonical_string(value: str) -> str:
    out = [QUOTE]
    for ch in value:
        code = ord(ch)
        if 0xD800 <= code <= 0xDFFF:
            raise CanonicalError("lone surrogate")
        if code in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[code])
        elif code < 0x20:
            out.append(BACKSLASH + "u" + format(code, "04x"))
        else:
            out.append(ch)
    out.append(QUOTE)
    return "".join(out)


def _canonical_number(value: float) -> str:
    """ECMAScript Number::toString from Python's shortest round-trip digits."""
    if value != value or value in (float("inf"), float("-inf")):
        raise CanonicalError("NaN and Infinity have no JSON form")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    parts = decimal.Decimal(repr(abs(value))).normalize().as_tuple()
    digits = "".join(str(d) for d in parts.digits)
    k = len(digits)
    n = int(parts.exponent) + k
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        exponent = n - 1
        mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
        body = mantissa + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
    return sign + body


def canonical(value: Any) -> str:
    """RFC 8785 text of a JSON value; MISSING members are omitted like JavaScript undefined."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _canonical_number(value)
    if isinstance(value, str):
        return _canonical_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(entry) for entry in value) + "]"
    if isinstance(value, dict):
        keys = sorted((key for key in value if value[key] is not MISSING), key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(_canonical_string(key) + ":" + canonical(value[key]) for key in keys) + "}"
    raise CanonicalError("unsupported value")


def canonical_bytes(value: Any) -> int:
    return len(canonical(value).encode("utf-8"))


def preimage(schema: str, value: Any) -> bytes:
    return (schema + LF + canonical(value)).encode("utf-8")


def digest_for(schema: str, value: Any) -> str:
    return "sha256:" + hashlib.sha256(preimage(schema, value)).hexdigest()


def omit(record: dict, fields: tuple) -> dict:
    return {key: value for key, value in record.items() if key not in fields}


# --- Strict frame lexer -----------------------------------------------------------------

_BOM = bytes((0xEF, 0xBB, 0xBF))
_HEX = "0123456789abcdefABCDEF"
_NUMBER_RUN = frozenset("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-")
_CANONICAL_INTEGER = re.compile("0|[1-9][0-9]*")


class _Duplicate(Exception):
    pass


class _NotJson(Exception):
    pass


def _is_control(code: int) -> bool:
    return code < 0x20 or 0x7F <= code <= 0x9F


def _hex4(text: str, at: int) -> int | None:
    digits = text[at:at + 4]
    return int(digits, 16) if len(digits) == 4 and all(ch in _HEX for ch in digits) else None


def _scan_string(text: str, i: int) -> int:
    """Pre-scan one string body from index i; returns the index after its closing quote."""
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == QUOTE:
            return i + 1
        if _is_control(ord(ch)):
            fail("Frame contains a control character.")
        if ch != BACKSLASH:
            i += 1
            continue
        marker = text[i + 1] if i + 1 < n else ""
        if marker != "" and marker in "bfnrt":
            fail("Frame contains a control character.")
        if marker != "u":
            i += 2
            continue
        unit = _hex4(text, i + 2)
        if unit is None:
            return n  # a malformed escape: json.loads names it invalid JSON
        if 0xD800 <= unit <= 0xDBFF:
            low = _hex4(text, i + 8) if text[i + 6:i + 8] == BACKSLASH + "u" else None
            if low is None or not 0xDC00 <= low <= 0xDFFF:
                fail("Frame contains an unpaired surrogate.")
            i += 12
            continue
        if 0xDC00 <= unit <= 0xDFFF:
            fail("Frame contains an unpaired surrogate.")
        if _is_control(unit):
            fail("Frame contains a control character.")
        i += 6
    return n


def _prescan(text: str) -> None:
    """Document-order checks json.loads cannot make: depth, number spelling, escapes."""
    depth = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == QUOTE:
            i = _scan_string(text, i + 1)
            continue
        if ch in "{[":
            depth += 1
            if depth > MAX_FRAME_DEPTH:
                fail("Frame nests deeper than 16 levels.")
        elif ch in "}]":
            depth -= 1
        elif ch == "-" or "0" <= ch <= "9":
            j = i
            while j < n and text[j] in _NUMBER_RUN:
                j += 1
            token = text[i:j]
            if not _CANONICAL_INTEGER.fullmatch(token):
                fail("Frame contains a non-canonical number.")
            if len(token) > len(MAX_SAFE_DIGITS) or (len(token) == len(MAX_SAFE_DIGITS) and token > MAX_SAFE_DIGITS):
                fail("Frame contains an integer above 2^53 - 1.")
            i = j
            continue
        i += 1


def _pairs(pairs: list) -> dict:
    out: dict = {}
    for key, value in pairs:
        if key in out:
            raise _Duplicate()
        out[key] = value
    return out


def _not_json(_token: str) -> Any:
    raise _NotJson()


def parse_frame(data: bytes) -> Any:
    if len(data) > MAX_FRAME_BYTES:
        fail("Frame exceeds 262144 bytes.")
    if data[:3] == _BOM:
        fail("Frame starts with a byte order mark.")
    try:
        # utf-8-sig would strip a leading BOM, so the guard above is the only rule that refuses one.
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        fail("Frame is not valid UTF-8.")
    _prescan(text)
    try:
        # strict=False: the pre-scan is the only rule that refuses a control character in a string.
        return json.loads(text, object_pairs_hook=_pairs, parse_float=_not_json, parse_constant=_not_json, parse_int=int,
                          strict=False)
    except _Duplicate:
        fail("Frame contains a duplicate object member.")
    except (_NotJson, json.JSONDecodeError):
        fail("Frame is not valid JSON.")


# --- Closed-shape checks ---------------------------------------------------------------------

Check = Callable[[Any, str], Any]

ID = re.compile("[A-Za-z0-9][A-Za-z0-9._:-]{7,127}")
DIGEST = re.compile("sha256:[0-9a-f]{64}")
SCHEMA_ID = re.compile("aether[.][a-z0-9.-]+/[1-9][0-9]*")
TOOL_NAME = re.compile("[a-z][a-z0-9_]{0,63}")
DIAGNOSTIC_CODE = re.compile("[A-Z][A-Z0-9_]{0,63}")
PRINTABLE_ASCII = re.compile("[ -~]{1,64}")
BASE64URL = re.compile("[A-Za-z0-9_-]+")
TIMESTAMP = re.compile("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})[.]([0-9]{3})Z")
_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
ORIGIN = re.compile("https://(" + _LABEL + "(?:[.]" + _LABEL + ")+)(?::([1-9][0-9]{0,4}))?")
_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def plain_object(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        fail(f"{path} must be a JSON object.")
    return value


def closed(value: Any, path: str, fields: tuple) -> dict:
    raw = plain_object(value, path)
    for key in raw:
        if key not in fields:
            fail(f"{path} contains an unsupported field.")
    return raw


def envelope(value: Any, label: str, schema: str, fields: tuple) -> dict:
    raw = plain_object(value, label)
    if raw.get("schema", MISSING) != schema:
        fail(f"{label} schema must be {schema}.")
    return closed(raw, label, fields)


def field_of(raw: dict, prefix: str) -> Callable[[str, Check], Any]:
    return lambda field, check: check(raw.get(field, MISSING), prefix + field)


def record(pairs: list) -> dict:
    """An output object; members a deleted guard let through as MISSING are left out."""
    return {key: value for key, value in pairs if value is not MISSING}


def _grammar(pattern: "re.Pattern[str]", message: str) -> Check:
    def check(value: Any, path: str) -> Any:
        if not isinstance(value, str) or not pattern.fullmatch(value):
            fail(f"{path} {message}")
        return value
    return check


ident = _grammar(ID, "must be an ID.")
digest = _grammar(DIGEST, "must be a sha256 digest.")
tool_name = _grammar(TOOL_NAME, "must be a tool name.")
diagnostic_code = _grammar(DIAGNOSTIC_CODE, "must be an uppercase code of 1 to 64 characters.")
printable_ascii = _grammar(PRINTABLE_ASCII, "must be 1 to 64 printable ASCII characters.")


def device_id(value: Any, path: str) -> Any:
    if not isinstance(value, str) or not ID.fullmatch(value) or not value.startswith("scdev_"):
        fail(f"{path} must be an scdev_ device ID.")
    return value


def schema_id(value: Any, path: str) -> Any:
    if not isinstance(value, str) or len(value) > 128 or not SCHEMA_ID.fullmatch(value):
        fail(f"{path} must be a schema ID.")
    return value


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _real_instant(match: "re.Match[str]") -> bool:
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    if not 1 <= month <= 12:
        return False
    month_days = 29 if month == 2 and _is_leap(year) else _DAYS_IN_MONTH[month - 1]
    return year >= 1 and 1 <= day <= month_days and hour <= 23 and minute <= 59 and second <= 59


def timestamp(value: Any, path: str) -> Any:
    match = TIMESTAMP.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        fail(f"{path} must be a UTC timestamp with milliseconds.")
    if match is not None and not _real_instant(match):
        fail(f"{path} is not a real UTC instant.")
    return value


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant)."""
    y = year - 1 if month <= 2 else year
    era = y // 400
    year_of_era = y - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    return era * 146097 + year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year - 719468


def epoch_ms(value: str) -> int:
    match = TIMESTAMP.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        fail("epochMs requires a validated timestamp.")
    year, month, day, hour, minute, second, millis = (int(part) for part in match.groups())
    return ((_days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60000 + second * 1000 + millis


def clock(now: Any) -> int:
    if type(now) is not int or abs(now) > MAX_SAFE:
        fail("now must be an integer of epoch milliseconds.")
    return now


def integer(value: Any, path: str, low: int, high: int) -> Any:
    if type(value) is not int:
        fail(f"{path} must be an integer.")
    if value < low or value > high:
        fail(f"{path} is out of range.")
    return value


def int_range(low: int, high: int) -> Check:
    return lambda value, path: integer(value, path, low, high)


uint53 = int_range(0, MAX_SAFE)
positive53 = int_range(1, MAX_SAFE)
tool_version = int_range(1, 65535)


def boolean(value: Any, path: str) -> Any:
    if type(value) is not bool:
        fail(f"{path} must be a boolean.")
    return value


def choice(value: Any, allowed: tuple, path: str) -> Any:
    if not isinstance(value, str) or value not in allowed:
        fail(f"{path} is not an allowed value.")
    return value


def one_of(allowed: tuple) -> Check:
    return lambda value, path: choice(value, allowed, path)


def constant(expected: Any) -> Check:
    def check(value: Any, path: str) -> Any:
        if type(value) is not type(expected) or value != expected:
            fail(f"{path} must be {json.dumps(expected)}.")
        return value
    return check


def constant_list(expected: tuple) -> Check:
    def check(value: Any, path: str) -> Any:
        if not isinstance(value, list) or len(value) != len(expected) or any(value[i] != entry for i, entry in enumerate(expected)):
            fail(f"{path} must be {json.dumps(list(expected), separators=(',', ':'))}.")
        return list(value) if isinstance(value, list) else value
    return check


def nullable(check: Check) -> Check:
    return lambda value, path: None if value is None else check(value, path)


def _string_hygiene(value: str, path: str) -> None:
    if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
        fail(f"{path} contains an unpaired surrogate.")
    if any(_is_control(ord(ch)) for ch in value):
        fail(f"{path} contains a control character.")


def text(value: Any, path: str, low: int, high: int) -> Any:
    if not isinstance(value, str):
        fail(f"{path} must be a string.")
    _string_hygiene(value, path)
    if not low <= len(value) <= high:
        fail(f"{path} must be {low} to {high} characters.")
    return value


def safe_text(value: Any, path: str) -> Any:
    return text(value, path, 1, MAX_STRING_SCALARS)


def base64url(value: Any, path: str, size: int) -> Any:
    chars = 43 if size == 32 else 86
    if not isinstance(value, str) or len(value) != chars or not BASE64URL.fullmatch(value):
        fail(f"{path} must be {chars} unpadded base64url characters.")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != value:
        fail(f"{path} is not canonical base64url.")
    return value


def bytes32(value: Any, path: str) -> Any:
    return base64url(value, path, 32)


def bytes64(value: Any, path: str) -> Any:
    return base64url(value, path, 64)


def decode_base64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def https_origin(value: Any, path: str) -> Any:
    match = ORIGIN.fullmatch(value) if isinstance(value, str) and len(value) <= MAX_STRING_SCALARS else None
    host = match.group(1) if match else ""
    port = int(match.group(2)) if match and match.group(2) is not None else None
    top_label = host[host.rfind(".") + 1:]
    if match is None or len(host) > 253 or not re.search("[a-z]", top_label) or port == 443 or (port is not None and port > 65535):
        fail(f"{path} must be a lowercase https origin.")
    return value


def array(value: Any, path: str, low: int, high: int) -> Any:
    if not isinstance(value, list):
        fail(f"{path} must be an array.")
    if not low <= len(value) <= high:
        fail(f"{path} must contain {low} to {high} entries.")
    return value


def items(values: Any, path: str, item: Check) -> list:
    return [item(entry, f"{path}[{index}]") for index, entry in enumerate(values)] if isinstance(values, list) else []


def strictly_ascending(entries: list, key: Callable[[Any], Any], repeated: str, unordered: str) -> None:
    """Unique and strictly ascending; equal neighbours are a repetition, not disorder."""
    if len({key(entry) for entry in entries}) != len(entries):
        fail(repeated)
    for previous, current in zip(entries, entries[1:]):
        if key(previous) > key(current):
            fail(unordered)


def string_set(low: int, high: int, item: Check) -> Check:
    def check(value: Any, path: str) -> Any:
        entries = items(array(value, path, low, high), path, item)
        strictly_ascending(entries, lambda entry: entry, f"{path} must not contain duplicates.", f"{path} must be in ascending code point order.")
        return entries
    return check


def _json_string(value: str, path: str) -> str:
    _string_hygiene(value, path)
    if len(value) > MAX_STRING_SCALARS:
        fail(f"{path} contains a string longer than 256 characters.")
    return value


def _walk(value: Any, path: str, max_depth: int, depth: int) -> Any:
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value < 0 or value > MAX_SAFE:
            fail(f"{path} contains a number that is not an integer from 0 to 2^53 - 1.")
        return value
    if isinstance(value, float):
        fail(f"{path} contains a number that is not an integer from 0 to 2^53 - 1.")
    if isinstance(value, str):
        return _json_string(value, path)
    is_list = isinstance(value, list)
    if not is_list and not isinstance(value, dict):
        fail(f"{path} contains a value that is not JSON.")
    if depth + 1 > max_depth:
        fail(f"{path} nests deeper than {max_depth} levels.")
    if is_list:
        if len(value) > MAX_ARRAY_ENTRIES:
            fail(f"{path} contains an array longer than 32 entries.")
        return [_walk(entry, path, max_depth, depth + 1) for entry in value]
    out = {}
    for key, entry in value.items():
        if not isinstance(key, str):
            fail(f"{path} contains a value that is not JSON.")
        out[_json_string(key, path)] = _walk(entry, path, max_depth, depth + 1)
    return out


def json_value(value: Any, path: str, max_depth: int) -> Any:
    return _walk(value, path, max_depth, 0)


def lifetime(label: str, start: str, start_field: str, end: str, max_ms: int, human: str) -> None:
    begin = epoch_ms(start)
    until = epoch_ms(end)
    if until <= begin:
        fail(f"{label} expires_at must be later than {start_field}.")
    if until - begin > max_ms:
        fail(f"{label} lifetime exceeds {human}.")


def fresh(label: str, start: str, start_field: str, end: str, now: int) -> None:
    if epoch_ms(start) > now + CLOCK_SKEW_MS:
        fail(f"{label} {start_field} is in the future.")
    if now >= epoch_ms(end) + CLOCK_SKEW_MS:
        fail(f"{label} has expired.")


def match_digest(label: str, field: str, claimed: Any, computed: str) -> None:
    if claimed != computed:
        fail(f"{label} {field} does not match its contents.")
