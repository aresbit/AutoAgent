"""Single domain-error -> HTTP response mapper.

Every error body is ``{"ok": false, "code": "...", "error": "..."}``. No
traceback, argv, SQL or filesystem path is ever included.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .adapters.files.safe_file_service import FileServiceError
from .domain.errors import DomainError

LOG = logging.getLogger("autoagent.api.errors")

_STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    500: "INTERNAL_ERROR",
    503: "UNAVAILABLE",
}


def error_response(
    status_code: int,
    code: str,
    message: str,
    *,
    details: dict[str, object] | None = None,
) -> JSONResponse:
    content: dict[str, object] = {"ok": False, "code": code, "error": message}
    if details:
        content["details"] = details
    return JSONResponse(status_code=status_code, content=content)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(
        request: Request, exc: DomainError
    ) -> JSONResponse:
        del request
        return error_response(
            exc.status_code,
            exc.code,
            exc.message,
            details=getattr(exc, "details", None),
        )

    @app.exception_handler(FileServiceError)
    async def handle_file_error(
        request: Request, exc: FileServiceError
    ) -> JSONResponse:
        del request
        return error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        del request
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", ()))
        message = str(first.get("msg", "invalid request"))
        detail = f"{location}: {message}" if location else message
        return error_response(422, "VALIDATION_ERROR", detail)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(
        request: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        del request
        code = _STATUS_CODES.get(exc.status_code, "HTTP_ERROR")
        detail = exc.detail if isinstance(exc.detail, str) else code
        return error_response(exc.status_code, code, detail)

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        LOG.error(
            "unhandled error on %s %s: %s",
            request.method,
            request.url.path,
            type(exc).__name__,
            exc_info=exc,
        )
        return error_response(500, "INTERNAL_ERROR", "internal server error")
