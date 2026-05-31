"""
Spawn real worker subprocesses for integration tests.

The goal here is to exercise the actual `python -m biblion.merge.*`
entry points — including signal handling, supervisor logic, and the
process boundary between writer / pending_resolver / producers.

Each spawned process gets its own log file under tmp_path so failures
can be inspected. The teardown sends SIGTERM, waits 5 seconds for clean
exit, then SIGKILL if still running.

Usage in a test:

    def test_writer_drains_cache(worker_runner, tmp_db_path, redis_url, cache):
        writer = worker_runner.spawn_writer(tmp_db_path, redis_url)
        cache.push_paper(PaperRecord(source='t', doi='10.1/x', title='X'))
        worker_runner.wait_for(
            lambda: cache.lengths()['staged_papers'] == 0,
            timeout=10,
        )
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import pytest


@dataclass
class SpawnedWorker:
    name:    str
    proc:    subprocess.Popen
    log:     Path
    log_fh:  Optional[object] = None
    started: float = field(default_factory=time.time)

    def is_alive(self) -> bool:
        return self.proc.poll() is None

    def read_log(self) -> str:
        try:
            return self.log.read_text()
        except FileNotFoundError:
            return ''

    def close_log(self) -> None:
        if self.log_fh is not None:
            try:
                self.log_fh.close()
            except Exception:
                pass
            self.log_fh = None


class WorkerRunner:
    """
    Manages the lifecycle of spawned worker processes within a single
    test. Tracks every process so teardown can stop them all.
    """

    def __init__(self, tmp_path: Path):
        self.tmp_path = tmp_path
        self.workers: list[SpawnedWorker] = []

    # -------------------------------------------------------- spawning

    def _spawn(self, name: str, module: str,
               db_path: Path, redis_url: str,
               extra_args: Optional[list[str]] = None) -> SpawnedWorker:
        log_path = self.tmp_path / f'{name}.log'
        cmd = ['python', '-u', '-m', module,
               '--db', str(db_path),
               '--redis-url', redis_url]
        if extra_args:
            cmd.extend(extra_args)
        log = open(log_path, 'wb')
        # New process group so SIGTERM/SIGKILL reach everyone in tear-down.
        env = {**os.environ, 'PYTHONUNBUFFERED': '1'}
        # Point the claims DB to the sibling of the test's tmp main DB.
        env['BIBLION_CLAIMS_DB'] = str(
            db_path.with_name(db_path.stem + '_claims.db')
        )
        proc = subprocess.Popen(
            cmd, stdout=log, stderr=subprocess.STDOUT,
            env=env, preexec_fn=os.setsid,
        )
        worker = SpawnedWorker(name=name, proc=proc, log=log_path, log_fh=log)
        self.workers.append(worker)
        # Give it a half-second to either start or die immediately.
        time.sleep(0.5)
        if not worker.is_alive():
            worker.close_log()
            raise RuntimeError(
                f"Worker {name} died immediately (exit {proc.returncode}); "
                f"log:\n{worker.read_log()}"
            )
        return worker

    def spawn_writer(self, db_path: Path, redis_url: str,
                     batch_size: int = 100,
                     idle_sleep: float = 0.1) -> SpawnedWorker:
        return self._spawn(
            'merge_writer', 'biblion.merge.writer',
            db_path, redis_url,
            extra_args=['--batch-size', str(batch_size),
                        '--idle-sleep', str(idle_sleep)],
        )

    def spawn_pending_resolver(self, db_path: Path, redis_url: str,
                               batch_size: int = 100,
                               idle_sleep: float = 0.1) -> SpawnedWorker:
        return self._spawn(
            'pending_resolver', 'biblion.merge.pending_resolver',
            db_path, redis_url,
            extra_args=['--batch-size', str(batch_size),
                        '--idle-sleep', str(idle_sleep)],
        )

    def spawn_resolver(self, db_path: Path, redis_url: str) -> SpawnedWorker:
        return self._spawn(
            'resolver', 'biblion.merge.resolver',
            db_path, redis_url,
        )

    # -------------------------------------------------------- waiting

    def wait_for(self, predicate: Callable[[], bool],
                 timeout: float = 10.0,
                 interval: float = 0.1,
                 msg: str = 'condition') -> None:
        """Poll predicate() until True or timeout. Raises on timeout."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(interval)
        # Build a useful failure message including worker logs.
        log_dump = '\n\n'.join(
            f'--- {w.name} log ---\n{w.read_log()}'
            for w in self.workers
        )
        pytest.fail(
            f"wait_for({msg}) timed out after {timeout}s.\n{log_dump}"
        )

    # -------------------------------------------------------- teardown

    def stop_all(self) -> None:
        """SIGTERM every worker, then SIGKILL any survivors. Close logs."""
        for w in self.workers:
            if w.is_alive():
                try:
                    os.killpg(w.proc.pid, signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass
        for w in self.workers:
            try:
                w.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(w.proc.pid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
                w.proc.wait()
            w.close_log()

    def stop(self, worker: SpawnedWorker, sig: int = signal.SIGTERM,
             timeout: float = 5.0) -> None:
        """Stop one specific worker (used in crash-recovery tests)."""
        if worker.is_alive():
            try:
                os.killpg(worker.proc.pid, sig)
            except (ProcessLookupError, OSError):
                pass
        try:
            worker.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(worker.proc.pid, signal.SIGKILL)
            worker.proc.wait()
        worker.close_log()


@pytest.fixture
def worker_runner(tmp_path: Path):
    """Provides a WorkerRunner; tears down all spawned processes after the test."""
    runner = WorkerRunner(tmp_path)
    yield runner
    runner.stop_all()
