"""Background jobs with progress reporting for long dataset operations.

A job runs in a worker thread. The operation reports progress through the
``Progress`` interface (``set_total`` / ``step``), and the UI polls
``/api/jobs/{id}`` to show a progress bar, the current file and an ETA.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from typing import Any, Callable

from .datasets import DatasetError
from .progress import JobCancelled, Progress


class Job(Progress):
    def __init__(self, kind: str, title: str, datasets: list[str]):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.title = title
        self.datasets = datasets
        self.total = 0
        self.done = 0
        self.current = ""
        self.status = "running"  # running | done | error | cancelled
        self.result: Any = None
        self.error: str | None = None
        self.started = time.time()
        self.finished: float | None = None
        self._cancel = threading.Event()
        self._lock = threading.Lock()

    # Progress interface ---------------------------------------------------
    def set_total(self, total: int) -> None:
        with self._lock:
            self.total = total

    def step(self, current: str = "", n: int = 1) -> None:
        if self._cancel.is_set():
            raise JobCancelled()
        with self._lock:
            self.done += n
            if current:
                self.current = current

    def note(self, current: str) -> None:
        if self._cancel.is_set():
            raise JobCancelled()
        with self._lock:
            self.current = current

    # ---------------------------------------------------------------------
    def cancel(self) -> None:
        self._cancel.set()

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "title": self.title,
                "datasets": self.datasets,
                "total": self.total,
                "done": self.done,
                "current": self.current,
                "status": self.status,
                "result": self.result,
                "error": self.error,
                "started": self.started,
                "finished": self.finished,
                "elapsed": (self.finished or time.time()) - self.started,
                "cancel_requested": self._cancel.is_set(),
            }


class JobManager:
    KEEP_FINISHED = 50

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def start(
        self, kind: str, title: str, datasets: list[str], fn: Callable[[Job], Any]
    ) -> Job:
        with self._lock:
            busy = [
                j for j in self._jobs.values()
                if j.status == "running" and set(j.datasets) & set(datasets)
            ]
            if busy:
                raise DatasetError(
                    f"'{busy[0].title}' 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", 409
                )
            job = Job(kind, title, datasets)
            self._jobs[job.id] = job
            self._prune()

        def run() -> None:
            try:
                result = fn(job)
                job.result = result
                job.status = "done"
            except JobCancelled:
                job.status = "cancelled"
            except DatasetError as e:
                job.error, job.status = str(e), "error"
            except Exception as e:  # noqa: BLE001 - surface any failure to the UI
                traceback.print_exc()
                job.error, job.status = f"{type(e).__name__}: {e}", "error"
            finally:
                job.finished = time.time()

        threading.Thread(target=run, name=f"job-{job.id}", daemon=True).start()
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self, active_only: bool = False) -> list[Job]:
        jobs = sorted(self._jobs.values(), key=lambda j: j.started)
        return [j for j in jobs if j.status == "running"] if active_only else jobs

    def _prune(self) -> None:
        finished = [j for j in self._jobs.values() if j.status != "running"]
        finished.sort(key=lambda j: j.finished or 0)
        for j in finished[: max(0, len(finished) - self.KEEP_FINISHED)]:
            self._jobs.pop(j.id, None)


jobs = JobManager()
