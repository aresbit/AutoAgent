"""Launch-token -> HttpOnly cookie exchange."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response

from ..deps import TOKEN_COOKIE
from ..schemas import AuthResponse

router = APIRouter()


@router.post("/api/auth/session", response_model=AuthResponse)
def exchange_session(request: Request, response: Response) -> AuthResponse:
    config = request.app.state.config
    response.set_cookie(
        key=TOKEN_COOKIE,
        value=config.api_token,
        httponly=True,
        samesite="strict",
        path="/",
        secure=False,
    )
    return AuthResponse(ok=True, apiVersion="1")
