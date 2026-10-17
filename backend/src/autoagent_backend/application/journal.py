"""Per-turn event journal and subscriber.

The journal exists so a ``TurnRunner`` can drain the engine independently of the
SSE subscriber. It is bounded; it is not a replay log.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

from ..domain.events import DomainEvent, is_terminal

MAX_EVENTS = 10_000
MAX_CHARS = 2 * 1024 * 1024


class TurnJournal:
    """Thread-safe, bounded sequence of domain events for one turn."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._events: list[DomainEvent] = []
        self._chars = 0
        self._ended = False
        self._full = False

    def append(self, event: DomainEvent) -> None:
        with self._condition:
            if self._ended:
                return
            terminal = is_terminal(event)
            size = _event_size(event)
            if not terminal and (
                self._full or len(self._events) >= MAX_EVENTS or self._chars + size > MAX_CHARS
            ):
                self._full = True
            else:
                self._events.append(event)
                self._chars += size
            if terminal:
                self._ended = True
            self._condition.notify_all()

    def end(self) -> None:
        with self._condition:
            self._ended = True
            self._condition.notify_all()

    @property
    def ended(self) -> bool:
        with self._condition:
            return self._ended

    @property
    def length(self) -> int:
        with self._condition:
            return len(self._events)

    def events_from(self, index: int) -> tuple[DomainEvent, ...]:
        with self._condition:
            return tuple(self._events[index:])

    def wait_next(
        self, index: int, timeout: float
    ) -> tuple[DomainEvent | None, int, bool]:
        """Wait for the event at ``index``.

        Post: returns ``(event, next_index, ended)``. ``event`` is ``None`` on
              timeout or when the journal has ended at this index.
        """

        with self._condition:
            if index < len(self._events):
                return self._events[index], index + 1, self._ended
            if self._ended:
                return None, index, True
            self._condition.wait(timeout)
            if index < len(self._events):
                return self._events[index], index + 1, self._ended
            return None, index, self._ended

    def __iter__(self) -> Iterator[DomainEvent]:
        index = 0
        while True:
            event, index, ended = self.wait_next(index, 1.0)
            if event is None:
                if ended:
                    return
                continue
            yield event
            if is_terminal(event):
                return


class TurnSubscription:
    """A read cursor over one turn journal."""

    def __init__(self, journal: TurnJournal, *, start_index: int = 0) -> None:
        self._journal = journal
        self._index = start_index

    @property
    def journal(self) -> TurnJournal:
        return self._journal

    @property
    def index(self) -> int:
        return self._index

    def next_event(self, timeout: float) -> tuple[DomainEvent | None, bool]:
        event, self._index, ended = self._journal.wait_next(self._index, timeout)
        return event, ended


def _event_size(event: DomainEvent) -> int:
    return len(repr(event))
