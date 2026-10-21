"""Progress reporting interface shared by dataset operations and background jobs."""


class JobCancelled(Exception):
    pass


class Progress:
    """No-op progress sink; operations call these so they also run without a job."""

    def set_total(self, total: int) -> None:
        pass

    def step(self, current: str = "", n: int = 1) -> None:
        pass

    def note(self, current: str) -> None:
        pass


NO_PROGRESS = Progress()
