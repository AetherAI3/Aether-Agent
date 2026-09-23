"""Independent Python mirror of the agent-browser-ats-order/1 validators.

docs/CONTRACTS.md section 4. It imports nothing from the TypeScript side; the
only shared code is the RFC 8785 encoder in ats_contracts_golden_verify.py,
itself an independent mirror. The decisions live in
ats_browser_order_gate.py and the fixture harness in
ats_browser_order_verify.py. ATSv2 lifts these modules (not the harness).
Refusal messages are byte-identical to the TypeScript validators, so every
negative vector proves that BOTH languages refuse it for its STATED reason
rather than for some other reason that happens to fire first.

Cross-language traps handled on purpose here:

* Python's ``re`` lets ``$`` match before a trailing newline and lets ``\\d``
  match every Unicode digit; JavaScript does neither. Every pattern below
  uses ``fullmatch`` and ``[0-9]``.
* JavaScript measures string length in UTF-16 code units, so limits here do
  too.
* ``json.loads`` keeps ``4.0`` a float where ``JSON.parse`` yields the integer
  4, so Python refuses a whole number written with a fraction that TypeScript
  would accept. The fixture holds no such value; producers must emit plain
  integers.
* A missing key is not ``null``: ``closed()`` fills absent keys with a
  MISSING sentinel that every validator refuses.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from typing import Any, Callable, NoReturn

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ats_contracts_golden_verify import digest_of  # noqa: E402  independent JCS mirror


class ContractError(ValueError):
    """A document refused at the contract boundary."""


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


MISSING = _Missing()
MAX_SAFE_INTEGER = 2**53 - 1


def fail(message: str) -> NoReturn:
    raise ContractError(message)


# --- Primitives (mirrors src/core/ats_contracts/primitives.ts) ---------------

IDENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
OPAQUE_REF = re.compile(r"[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{8,128}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
TIMESTAMP = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?Z")


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def closed(value: Any, name: str, allowed: tuple) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{name} must be a plain object.")
    for key in value:
        if key not in allowed:
            fail(f"{name} contains an unsupported field.")
    return {key: value.get(key, MISSING) for key in allowed}


def schema_tag(value: Any, expected: str, name: str) -> str:
    if not (isinstance(value, str) and value == expected):
        fail(f"{name} must declare schema {expected}.")
    return expected


def choice(value: Any, allowed: tuple, name: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        fail(f"{name} is unsupported.")
    return value


def pinned(value: Any, expected: Any, name: str) -> Any:
    if type(value) is not type(expected) or value != expected:
        fail(f"{name} must be {json.dumps(expected)}.")
    return expected


def integer(value: Any, name: str, low: int, high: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or abs(value) > MAX_SAFE_INTEGER:
        fail(f"{name} must be a whole number.")
    if value < low or value > high:
        fail(f"{name} is out of range.")
    return value


def text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str):
        fail(f"{name} must be a string.")
    if not value:
        fail(f"{name} must not be empty.")
    if utf16_length(value) > maximum:
        fail(f"{name} exceeds its {maximum} character limit.")
    if CONTROL.search(value):
        fail(f"{name} contains control characters.")
    return value


def _pattern(regex: "re.Pattern[str]", message: str) -> Callable[[Any, str], str]:
    def check(value: Any, name: str) -> str:
        if not isinstance(value, str) or not regex.fullmatch(value):
            fail(f"{name} {message}")
        return value

    return check


ident = _pattern(IDENT, "must be a bounded identifier.")
opaque_ref = _pattern(OPAQUE_REF, "must be a prefixed opaque reference, never a provider account number.")
digest = _pattern(DIGEST, "must be a sha256:<hex> digest.")
version = _pattern(VERSION, "must be a bounded version string.")


def timestamp(value: Any, name: str) -> str:
    if not isinstance(value, str) or utf16_length(value) > 40:
        fail(f"{name} must be an RFC 3339 UTC timestamp.")
    match = TIMESTAMP.fullmatch(value)
    if not match:
        fail(f"{name} must be an RFC 3339 UTC timestamp ending in Z.")
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ""
    # ECMAScript Date.parse (V8) refuses an out-of-range field outright — month
    # 1-12, day 1-31, minute and second 0-59, hour 0-23, or 24 only as exactly
    # 24:00:00 with an all-zero fraction — which TypeScript reports as "not a
    # real instant". Year 0000 is valid (proleptic Gregorian, a leap year).
    exact_midnight = hour == 24 and minute == 0 and second == 0 and not fraction.strip("0")
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute <= 59 and second <= 59 and (hour <= 23 or exact_midnight)):
        fail(f"{name} is not a real instant.")
    # It rolls a day beyond its month, or 24:00, into the next day instead;
    # TypeScript catches that by re-deriving the fields.
    days_in_month = 29 if month == 2 and _is_leap(year) else _DAYS_IN_MONTH[month - 1]
    if day > days_in_month or hour == 24:
        fail(f"{name} is not a real calendar date.")
    return value


_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's algorithm)."""
    year -= month <= 2
    era = year // 400
    year_of_era = year - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146097 + day_of_era - 719468


def epoch_ms(value: str) -> int:
    """Milliseconds since the epoch of a validated timestamp; extra fraction digits truncate as in V8."""
    match = TIMESTAMP.fullmatch(value)
    if match is None:
        fail("epoch_ms requires a validated timestamp.")
    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    millis = int((match.group(7) or "").ljust(3, "0")[:3])
    return (((_days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis


def nullable(value: Any, name: str, inner: Callable[[Any, str], Any]) -> Any:
    return None if value is None else inner(value, name)


def bounded_list(value: Any, name: str, maximum: int, item: Callable[[Any, str], Any]) -> list[Any]:
    if not isinstance(value, list):
        fail(f"{name} must be an array.")
    if len(value) > maximum:
        fail(f"{name} exceeds its {maximum} entry limit.")
    return [item(entry, f"{name}[{index}]") for index, entry in enumerate(value)]


def minor_units(value: Any, name: str) -> int:
    return integer(value, name, 0, MAX_MINOR)


def positive_minor(value: Any, name: str) -> int:
    return integer(value, name, 1, MAX_MINOR)


def signed_minor(value: Any, name: str) -> int:
    return integer(value, name, -MAX_MINOR, MAX_MINOR)


def digest_equals(a: Any, b: Any) -> bool:
    return isinstance(a, str) and isinstance(b, str) and a == b


# --- Contract vocabulary (mirrors browser_order.ts) --------------------------

CALL_SCHEMA = "aether.ats.browser-order-call/1"
RESULT_SCHEMA = "aether.ats.browser-order-result/1"
OPERATIONS = (
    "verify_session", "read_market", "read_account", "prepare_ticket", "verify_ticket",
    "commit_once", "read_order", "read_positions", "cancel_order", "end_control",
)
EFFECTS = {
    "verify_session": "observe", "read_market": "observe", "read_account": "observe",
    "prepare_ticket": "prepare", "verify_ticket": "observe", "commit_once": "mutate",
    "read_order": "observe", "read_positions": "observe", "cancel_order": "mutate",
    "end_control": "release",
}
SITE_MODES = ("paper", "live")
BROWSER_ENVIRONMENTS = ("provider_sandbox", "provider_live")
REFUSAL_CODES = (
    "observe_only", "user_authenticating", "user_control", "session_generation_mismatch",
    "binding_mismatch", "adapter_mismatch", "deadline_exceeded", "ticket_mismatch",
    "ui_drift", "navigation_drift", "duplicate_commit", "unsupported", "halted",
)
RESULT_STATUSES = ("ok", "refused", "ambiguous")
END_CONTROL_REASONS = ("complete", "user_takeover", "halt", "deadline", "session_change", "error")
ORDER_SIDES = ("buy", "sell")
ORDER_TYPES = ("market", "limit")
SESSION_STATES = ("user_authenticating", "observe_only", "verified")
PRIMARY_INDICATORS = ("paper", "live", "absent")
SECONDARY_INDICATORS = ("paper", "live", "absent", "not_supported")
TRADING_PERMISSIONS = ("equity_orders", "none")
CONTROL_HOLDERS = ("user", "ats", "none")
RELEASED_HOLDERS = ("user", "none")
QUOTE_CLASSES = ("account_executable", "display_only")
SUBMIT_CONTROLS = ("enabled", "disabled")
SUBMISSIONS = ("confirmed", "site_rejected")
ORDER_LOOKUPS = ("found", "not_found", "indeterminate")
ORDER_EVIDENCE_SOURCES = ("order_history", "order_detail")
SITE_ORDER_STATUSES = ("working", "partially_filled", "filled", "cancelled", "rejected", "expired")
CANCEL_STATES = ("cancel_confirmed", "already_final")

MAX_CALL_WINDOW_MS = 120_000
MAX_MUTATION_WINDOW_MS = 30_000
MAX_CLOCK_SKEW_MS = 5_000
MAX_GENERATION = 2_147_483_647
MAX_TICKET_QUANTITY = 1_000_000
MAX_POSITION_QUANTITY = 1_000_000_000
MAX_POSITIONS = 500
MAX_MINOR = 1_000_000_000_000

HOST_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HTTPS_ORIGIN = re.compile(rf"https://({HOST_LABEL}(?:\.{HOST_LABEL})+)(?::([1-9][0-9]{{0,4}}))?")
FIVE_DIGITS = re.compile(r"[0-9]{5,}")
# Built with chr() so no escape layer can turn the class into literal characters.
MASKED_LABEL_CHARACTERS = re.compile("[A-Za-z0-9 ._()#*" + chr(0x2022) + chr(0x2026) + "-]+")
EQUITY_SYMBOL = re.compile(r"[A-Z]{1,6}(?:[.-][A-Z]{1,4})?")

TICKET_FIELDS = ("symbol", "side", "quantity", "order_type", "limit_price_minor", "time_in_force")
SESSION_ACCOUNT_FIELDS = ("site_origin", "account_fingerprint", "masked_account_label", "mode_evidence", "trading_permission")


def environment_for_site_mode(mode: str) -> str:
    return "provider_sandbox" if mode == "paper" else "provider_live"


def site_origin(value: Any, name: str) -> str:
    match = HTTPS_ORIGIN.fullmatch(value) if isinstance(value, str) and utf16_length(value) <= 270 else None
    host = match.group(1) if match else ""
    port = int(match.group(2)) if match and match.group(2) is not None else None
    top_label = host[host.rfind(".") + 1:]
    if not match or len(host) > 253 or not re.search(r"[a-z]", top_label) or (port is not None and (port > 65535 or port == 443)):
        fail(f"{name} must be a bare https origin.")
    return value


def masked_account_label(value: Any, name: str) -> str:
    label = text(value, name, 64)
    if not MASKED_LABEL_CHARACTERS.fullmatch(label):
        fail(f"{name} must use only letters, digits, spaces, masking bullets and . - _ ( ) # *.")
    if FIVE_DIGITS.search(label):
        fail(f"{name} must not embed a full account number.")
    return label


def equity_symbol(value: Any, name: str) -> str:
    if not isinstance(value, str) or not EQUITY_SYMBOL.fullmatch(value):
        fail(f"{name} must be an equity ticker such as SPY or BRK.B.")
    return value


# --- Call ----------------------------------------------------------------------


def validate_principal(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("user_ref", "agent_id", "browser_session_id", "session_generation"))
    return {
        "user_ref": opaque_ref(raw["user_ref"], f"{name} user"),
        "agent_id": ident(raw["agent_id"], f"{name} agent"),
        "browser_session_id": ident(raw["browser_session_id"], f"{name} browser session"),
        "session_generation": integer(raw["session_generation"], f"{name} session generation", 1, MAX_GENERATION),
    }


def validate_adapter(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("adapter_id", "adapter_version", "adapter_digest"))
    return {
        "adapter_id": ident(raw["adapter_id"], f"{name} id"),
        "adapter_version": version(raw["adapter_version"], f"{name} version"),
        "adapter_digest": digest(raw["adapter_digest"], f"{name} digest"),
    }


def validate_binding(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("binding_id", "binding_generation", "account_fingerprint", "site_mode", "execution_environment"))
    mode = choice(raw["site_mode"], SITE_MODES, f"{name} site mode")
    environment = choice(raw["execution_environment"], BROWSER_ENVIRONMENTS, f"{name} execution environment")
    if environment != environment_for_site_mode(mode):
        fail(f"{name} execution environment does not match its site mode.")
    return {
        "binding_id": ident(raw["binding_id"], f"{name} id"),
        "binding_generation": integer(raw["binding_generation"], f"{name} generation", 1, MAX_GENERATION),
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": mode,
        "execution_environment": environment,
    }


def price_agrees_with_type(order_type: str, price: int | None, name: str) -> None:
    if order_type == "limit" and price is None:
        fail(f"{name}: a limit order requires a positive minor-unit price.")
    if order_type == "market" and price is not None:
        fail(f"{name}: a market order cannot carry a limit price.")


def ticket_shape(raw: dict[str, Any], name: str) -> dict[str, Any]:
    order_type = choice(raw["order_type"], ORDER_TYPES, f"{name} order type")
    price = nullable(raw["limit_price_minor"], f"{name} limit price", positive_minor)
    price_agrees_with_type(order_type, price, name)
    return {
        "symbol": equity_symbol(raw["symbol"], f"{name} symbol"),
        "side": choice(raw["side"], ORDER_SIDES, f"{name} side"),
        "quantity": integer(raw["quantity"], f"{name} quantity", 1, MAX_TICKET_QUANTITY),
        "order_type": order_type,
        "limit_price_minor": price,
        "time_in_force": pinned(raw["time_in_force"], "day", f"{name} time in force"),
    }


def validate_ticket(value: Any, name: str) -> dict[str, Any]:
    return ticket_shape(closed(value, name, TICKET_FIELDS), name)


def ticket_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("ticket", "preview_digest"))
    return {
        "ticket": validate_ticket(raw["ticket"], f"{name} ticket"),
        "preview_digest": digest(raw["preview_digest"], f"{name} preview digest"),
    }


def no_params(value: Any, name: str) -> dict[str, Any]:
    closed(value, name, ())
    return {}


def _read_market_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("symbol",))
    return {"symbol": equity_symbol(raw["symbol"], f"{name} symbol")}


def _commit_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("preview_digest", "rendered_ticket_digest", "approval_id"))
    return {
        "preview_digest": digest(raw["preview_digest"], f"{name} preview digest"),
        "rendered_ticket_digest": digest(raw["rendered_ticket_digest"], f"{name} rendered ticket digest"),
        "approval_id": ident(raw["approval_id"], f"{name} approval id"),
    }


def _read_order_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("site_order_id",))
    return {"site_order_id": nullable(raw["site_order_id"], f"{name} site order id", ident)}


def _read_positions_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("symbol",))
    return {"symbol": nullable(raw["symbol"], f"{name} symbol", equity_symbol)}


def _cancel_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("site_order_id",))
    return {"site_order_id": ident(raw["site_order_id"], f"{name} site order id")}


def _end_control_params(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("reason",))
    return {"reason": choice(raw["reason"], END_CONTROL_REASONS, f"{name} reason")}


PARAM_VALIDATORS: dict[str, Callable[[Any, str], dict[str, Any]]] = {
    "verify_session": no_params,
    "read_market": _read_market_params,
    "read_account": no_params,
    "prepare_ticket": ticket_params,
    "verify_ticket": ticket_params,
    "commit_once": _commit_params,
    "read_order": _read_order_params,
    "read_positions": _read_positions_params,
    "cancel_order": _cancel_params,
    "end_control": _end_control_params,
}

CALL_FIELDS = ("schema_version", "call_id", "request_id", "operation", "principal", "adapter", "binding", "issued_at", "deadline", "params")
BINDING_OPTIONAL = ("verify_session", "end_control")


def check_deadline(operation: str, issued_at: str, deadline: str) -> None:
    window = epoch_ms(deadline) - epoch_ms(issued_at)
    if window <= 0:
        fail("Browser order deadline must follow issued_at.")
    limit = MAX_MUTATION_WINDOW_MS if EFFECTS[operation] == "mutate" else MAX_CALL_WINDOW_MS
    if window > limit:
        fail(f"Browser order deadline exceeds the {limit // 1000}s window for {operation}.")


def validate_call(value: Any) -> dict[str, Any]:
    raw = closed(value, "Browser order call", CALL_FIELDS)
    schema_tag(raw["schema_version"], CALL_SCHEMA, "Browser order call")
    operation = choice(raw["operation"], OPERATIONS, "Browser order operation")
    binding = nullable(raw["binding"], "Browser order binding", validate_binding)
    if binding is None and operation not in BINDING_OPTIONAL:
        fail(f"Browser order operation {operation} requires a binding.")
    issued_at = timestamp(raw["issued_at"], "Browser order issued_at")
    deadline = timestamp(raw["deadline"], "Browser order deadline")
    check_deadline(operation, issued_at, deadline)
    return {
        "schema_version": CALL_SCHEMA,
        "call_id": ident(raw["call_id"], "Browser order call id"),
        "request_id": ident(raw["request_id"], "Browser order request id"),
        "operation": operation,
        "principal": validate_principal(raw["principal"], "Browser order principal"),
        "adapter": validate_adapter(raw["adapter"], "Browser order adapter"),
        "binding": binding,
        "issued_at": issued_at,
        "deadline": deadline,
        "params": PARAM_VALIDATORS[operation](raw["params"], "Browser order params"),
    }


# --- Result data ---------------------------------------------------------------


def validate_mode_evidence(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("primary", "secondary"))
    return {
        "primary": choice(raw["primary"], PRIMARY_INDICATORS, f"{name} primary"),
        "secondary": choice(raw["secondary"], SECONDARY_INDICATORS, f"{name} secondary"),
    }


def validate_verify_session(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("session_state", *SESSION_ACCOUNT_FIELDS, "control_holder"))
    state = choice(raw["session_state"], SESSION_STATES, f"{name} session state")
    control = choice(raw["control_holder"], CONTROL_HOLDERS, f"{name} control holder")
    account = {
        "site_origin": nullable(raw["site_origin"], f"{name} site origin", site_origin),
        "account_fingerprint": nullable(raw["account_fingerprint"], f"{name} account fingerprint", digest),
        "masked_account_label": nullable(raw["masked_account_label"], f"{name} masked account label", masked_account_label),
        "mode_evidence": nullable(raw["mode_evidence"], f"{name} mode evidence", validate_mode_evidence),
        "trading_permission": nullable(raw["trading_permission"], f"{name} trading permission", lambda v, n: choice(v, TRADING_PERMISSIONS, n)),
    }
    present = sum(1 for entry in account.values() if entry is not None)
    if state == "verified" and present != len(SESSION_ACCOUNT_FIELDS):
        fail(f"{name}: a verified session must name its origin, account, mode evidence and trading permission.")
    if state != "verified" and present != 0:
        fail(f"{name}: an unverified session must not carry account data.")
    if state == "user_authenticating" and control != "user":
        fail(f"{name}: authentication leaves control with the user.")
    return {"session_state": state, **account, "control_holder": control}


def validate_market(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("symbol", "currency", "bid_minor", "ask_minor", "last_minor", "quote_time", "quote_class"))
    bid = nullable(raw["bid_minor"], f"{name} bid", positive_minor)
    ask = nullable(raw["ask_minor"], f"{name} ask", positive_minor)
    last = nullable(raw["last_minor"], f"{name} last", positive_minor)
    if bid is None and ask is None and last is None:
        fail(f"{name} carries no price.")
    if bid is not None and ask is not None and bid > ask:
        fail(f"{name} is a crossed quote.")
    return {
        "symbol": equity_symbol(raw["symbol"], f"{name} symbol"),
        "currency": pinned(raw["currency"], "USD", f"{name} currency"),
        "bid_minor": bid,
        "ask_minor": ask,
        "last_minor": last,
        "quote_time": nullable(raw["quote_time"], f"{name} quote time", timestamp),
        "quote_class": choice(raw["quote_class"], QUOTE_CLASSES, f"{name} quote class"),
    }


def validate_account(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("account_fingerprint", "site_mode", "currency", "cash_minor", "buying_power_minor"))
    return {
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": choice(raw["site_mode"], SITE_MODES, f"{name} site mode"),
        "currency": pinned(raw["currency"], "USD", f"{name} currency"),
        "cash_minor": nullable(raw["cash_minor"], f"{name} cash", signed_minor),
        "buying_power_minor": nullable(raw["buying_power_minor"], f"{name} buying power", minor_units),
    }


def validate_rendered_ticket(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("account_fingerprint", "site_mode", *TICKET_FIELDS))
    return {
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": choice(raw["site_mode"], SITE_MODES, f"{name} site mode"),
        **ticket_shape(raw, name),
    }


def validate_ticket_data(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("rendered_ticket", "rendered_ticket_digest", "estimated_cost_minor", "submit_control"))
    rendered = validate_rendered_ticket(raw["rendered_ticket"], f"{name} rendered ticket")
    claimed = digest(raw["rendered_ticket_digest"], f"{name} rendered ticket digest")
    if not digest_equals(claimed, digest_of(rendered)):
        fail(f"{name} rendered ticket digest does not match the rendered ticket.")
    return {
        "rendered_ticket": rendered,
        "rendered_ticket_digest": claimed,
        "estimated_cost_minor": nullable(raw["estimated_cost_minor"], f"{name} estimated cost", minor_units),
        "submit_control": choice(raw["submit_control"], SUBMIT_CONTROLS, f"{name} submit control"),
    }


def validate_commit(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("submission", "site_order_id", "rendered_ticket_digest"))
    submission = choice(raw["submission"], SUBMISSIONS, f"{name} submission")
    order_id = nullable(raw["site_order_id"], f"{name} site order id", ident)
    if submission == "confirmed" and order_id is None:
        fail(f"{name}: a confirmed submission must name its site order id.")
    return {
        "submission": submission,
        "site_order_id": order_id,
        "rendered_ticket_digest": digest(raw["rendered_ticket_digest"], f"{name} rendered ticket digest"),
    }


def check_fill_state(fills: dict[str, Any], name: str) -> None:
    status, quantity = fills["status"], fills["quantity"]
    filled, average = fills["filled_quantity"], fills["average_fill_price_minor"]
    if (filled > 0) != (average is not None):
        fail(f"{name}: an average fill price exists exactly when shares filled.")
    if status == "filled":
        consistent = filled == quantity
    elif status == "partially_filled":
        consistent = 0 < filled < quantity
    elif status in ("working", "rejected"):
        consistent = filled == 0
    else:  # cancelled or expired, possibly after a partial fill
        consistent = filled < quantity
    if not consistent:
        fail(f"{name}: status {status} disagrees with its filled quantity.")


def validate_site_order(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, (
        "site_order_id", "symbol", "side", "quantity", "order_type", "limit_price_minor",
        "status", "filled_quantity", "average_fill_price_minor", "updated_at",
    ))
    order_type = choice(raw["order_type"], ORDER_TYPES, f"{name} order type")
    price = nullable(raw["limit_price_minor"], f"{name} limit price", positive_minor)
    price_agrees_with_type(order_type, price, name)
    quantity = integer(raw["quantity"], f"{name} quantity", 1, MAX_TICKET_QUANTITY)
    fills = {
        "status": choice(raw["status"], SITE_ORDER_STATUSES, f"{name} status"),
        "quantity": quantity,
        "filled_quantity": integer(raw["filled_quantity"], f"{name} filled quantity", 0, quantity),
        "average_fill_price_minor": nullable(raw["average_fill_price_minor"], f"{name} average fill price", positive_minor),
    }
    check_fill_state(fills, name)
    return {
        "site_order_id": ident(raw["site_order_id"], f"{name} site order id"),
        "symbol": equity_symbol(raw["symbol"], f"{name} symbol"),
        "side": choice(raw["side"], ORDER_SIDES, f"{name} side"),
        "order_type": order_type,
        "limit_price_minor": price,
        **fills,
        "updated_at": nullable(raw["updated_at"], f"{name} updated_at", timestamp),
    }


def validate_order(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("account_fingerprint", "site_mode", "lookup", "order", "evidence_source"))
    lookup = choice(raw["lookup"], ORDER_LOOKUPS, f"{name} lookup")
    order = nullable(raw["order"], f"{name} order", validate_site_order)
    if (lookup == "found") != (order is not None):
        fail(f"{name}: an order is present exactly when the lookup found one.")
    return {
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": choice(raw["site_mode"], SITE_MODES, f"{name} site mode"),
        "lookup": lookup,
        "order": order,
        "evidence_source": choice(raw["evidence_source"], ORDER_EVIDENCE_SOURCES, f"{name} evidence source"),
    }


def validate_position(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("symbol", "quantity", "average_cost_minor"))
    quantity = integer(raw["quantity"], f"{name} quantity", -MAX_POSITION_QUANTITY, MAX_POSITION_QUANTITY)
    if quantity == 0:
        fail(f"{name} quantity must not be zero; a flat position is absent.")
    return {
        "symbol": equity_symbol(raw["symbol"], f"{name} symbol"),
        "quantity": quantity,
        "average_cost_minor": nullable(raw["average_cost_minor"], f"{name} average cost", positive_minor),
    }


def validate_positions(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("account_fingerprint", "site_mode", "positions", "unrepresented_positions", "evidence_source"))
    positions = bounded_list(raw["positions"], f"{name} positions", MAX_POSITIONS, validate_position)
    if len({entry["symbol"] for entry in positions}) != len(positions):
        fail(f"{name} positions must not repeat an entry.")
    return {
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": choice(raw["site_mode"], SITE_MODES, f"{name} site mode"),
        "positions": positions,
        "unrepresented_positions": integer(raw["unrepresented_positions"], f"{name} unrepresented positions", 0, MAX_POSITIONS),
        "evidence_source": pinned(raw["evidence_source"], "positions_view", f"{name} evidence source"),
    }


def validate_cancel(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("account_fingerprint", "site_mode", "cancel_state", "site_order_id"))
    return {
        "account_fingerprint": digest(raw["account_fingerprint"], f"{name} account fingerprint"),
        "site_mode": choice(raw["site_mode"], SITE_MODES, f"{name} site mode"),
        "cancel_state": choice(raw["cancel_state"], CANCEL_STATES, f"{name} cancel state"),
        "site_order_id": ident(raw["site_order_id"], f"{name} site order id"),
    }


def validate_end_control(value: Any, name: str) -> dict[str, Any]:
    raw = closed(value, name, ("control_holder",))
    return {"control_holder": choice(raw["control_holder"], RELEASED_HOLDERS, f"{name} control holder")}


DATA_VALIDATORS: dict[str, Callable[[Any, str], dict[str, Any]]] = {
    "verify_session": validate_verify_session,
    "read_market": validate_market,
    "read_account": validate_account,
    "prepare_ticket": validate_ticket_data,
    "verify_ticket": validate_ticket_data,
    "commit_once": validate_commit,
    "read_order": validate_order,
    "read_positions": validate_positions,
    "cancel_order": validate_cancel,
    "end_control": validate_end_control,
}

RESULT_FIELDS = ("schema_version", "call_id", "request_id", "operation", "principal", "adapter", "observed_at", "status", "refusal", "data")


def status_data(operation: str, status: str, refusal: str | None, data: Any) -> Any:
    if status == "ok":
        if refusal is not None:
            fail("An ok browser result cannot carry a refusal.")
        return DATA_VALIDATORS[operation](data, f"Browser order {operation} data")
    if data is not None:
        fail(f"Browser result status {status} cannot carry data.")
    if status == "refused":
        if refusal is None:
            fail("A refused browser result must name its refusal.")
        if refusal == "duplicate_commit" and operation != "commit_once":
            fail("Only commit_once can be refused as a duplicate commit.")
        return None
    if EFFECTS[operation] != "mutate":
        fail(f"Only an order mutation can be ambiguous; {operation} cannot.")
    if refusal is not None:
        fail("An ambiguous browser result cannot carry a refusal.")
    return None


def validate_result(value: Any) -> dict[str, Any]:
    raw = closed(value, "Browser order result", RESULT_FIELDS)
    schema_tag(raw["schema_version"], RESULT_SCHEMA, "Browser order result")
    operation = choice(raw["operation"], OPERATIONS, "Browser order result operation")
    status = choice(raw["status"], RESULT_STATUSES, "Browser order result status")
    refusal = nullable(raw["refusal"], "Browser order refusal", lambda v, n: choice(v, REFUSAL_CODES, n))
    data = status_data(operation, status, refusal, raw["data"])
    return {
        "schema_version": RESULT_SCHEMA,
        "call_id": ident(raw["call_id"], "Browser order result call id"),
        "request_id": ident(raw["request_id"], "Browser order result request id"),
        "operation": operation,
        "principal": validate_principal(raw["principal"], "Browser order result principal"),
        "adapter": validate_adapter(raw["adapter"], "Browser order result adapter"),
        "observed_at": timestamp(raw["observed_at"], "Browser order observed_at"),
        "status": status,
        "refusal": refusal,
        "data": data,
    }
