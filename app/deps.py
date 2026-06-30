from typing import Optional
from fastapi import Cookie, Header, HTTPException
from auth.sessions import validate_session, session_device


def _token(
    litelayer_session: Optional[str],
    authorization: Optional[str],
    ll_device: Optional[str] = None,
) -> str:
    via_cookie = bool(litelayer_session)
    token = litelayer_session
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    if not validate_session(token):
        raise HTTPException(401, "Session expired or invalid")
    # Session↔device binding: a cookie session only works from the device it was
    # created on, so a stolen session cookie is useless without the device cookie.
    # Bearer tokens are an explicit API secret and aren't device-bound.
    if via_cookie:
        bound = session_device(token)
        if bound and bound != ll_device:
            raise HTTPException(401, "Session not valid for this device")
    return token


def require_auth(
    litelayer_session: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
    ll_device: Optional[str] = Cookie(default=None),
) -> str:
    token = _token(litelayer_session, authorization, ll_device)
    return validate_session(token)


def current_token(
    litelayer_session: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
    ll_device: Optional[str] = Cookie(default=None),
) -> str:
    """The validated session token — used to scope per-drive PIN unlock grants."""
    return _token(litelayer_session, authorization, ll_device)
