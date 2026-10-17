"""Opaque identifier newtypes used across the application core.

The concrete string representation is deliberately not part of any external
contract. ``EngineSessionRef`` in particular must never be serialized to a DTO
or an SSE payload.
"""

from typing import NewType

SessionId = NewType("SessionId", str)
TurnId = NewType("TurnId", str)
MessageId = NewType("MessageId", str)
CallRef = NewType("CallRef", str)
EngineSessionRef = NewType("EngineSessionRef", str)
