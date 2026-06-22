from typing import Optional
from fastapi import Cookie, Header, HTTPException
from auth.sessions import validate_session


def require_auth(
    litelayer_session: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
) -> str:
    token = litelayer_session
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(401, "Not authenticated")
    username = validate_session(token)
    if not username:
        raise HTTPException(401, "Session expired or invalid")
    return username
