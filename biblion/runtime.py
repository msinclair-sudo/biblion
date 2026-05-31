"""
Process-level helpers for long-running pipeline phases.

ShutdownFlag implements a two-strikes Ctrl-C policy:
  - 1st SIGINT:  set .requested=True. Module loops should poll and exit
                 their next-batch boundary cleanly.
  - 2nd SIGINT:  emergency abort. Re-raises KeyboardInterrupt at whatever
                 Python frame the signal lands on. If the process is stuck
                 in a C extension that traps signals, the second Ctrl-C
                 still has no effect — for that case the caller has to send
                 SIGTERM/SIGKILL from outside (see biblion.__main__.start).
"""
import signal


class ShutdownFlag:
    """
    Cooperative shutdown signal with two-strikes Ctrl-C escalation.

    Usage:
        flag = ShutdownFlag.install(name='merge-writer')
        while not flag.requested:
            run_cycle()
    """

    def __init__(self, name: str = 'biblion'):
        self.name = name
        self.requested = False
        self._strikes = 0

    def _handler(self, sig, frame):
        self._strikes += 1
        if self._strikes >= 2:
            print(f"\n[{self.name}] Second Ctrl-C — raising KeyboardInterrupt.")
            # Restore default handler so a third Ctrl-C (or any later one)
            # terminates normally instead of being trapped again.
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            raise KeyboardInterrupt
        print(f"\n[{self.name}] Shutdown requested — finishing current batch "
              f"(Ctrl-C again to abort).")
        self.requested = True

    @classmethod
    def install(cls, name: str = 'biblion') -> 'ShutdownFlag':
        """Create a new flag and bind it to SIGINT."""
        flag = cls(name)
        signal.signal(signal.SIGINT, flag._handler)
        return flag
