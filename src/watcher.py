#!/usr/bin/env python3
"""Self-contained remote Linux process-tree watcher for pi-ssh-target."""

import errno
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Set, TextIO

PROTOCOL_PREFIX = "@@PI_SSH_TARGET@@"
STATE_VERSION = 1


class WatcherInterrupt(Exception):
    """Signals an error that must end monitoring with an interrupt event."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ProcStat:
    """Contains fields from /proc/<pid>/stat needed for identity checks."""

    pid: int
    state: str
    start_ticks: int


@dataclass
class ProcessRecord:
    """Stores stable identity and lifecycle times for one discovered process."""

    pid: int
    start_ticks: int
    started_at: str
    ended_at: Optional[str] = None


class ProcReader:
    """Reads Linux /proc data while normalizing watcher-relevant failures."""

    def __init__(self, proc_root: Path = Path("/proc"), clock_ticks: Optional[int] = None) -> None:
        """Sets /proc root and clock tick rate, allowing deterministic tests."""
        self.proc_root = proc_root
        self.clock_ticks = clock_ticks or int(os.sysconf("SC_CLK_TCK"))

    def read_boot_id(self) -> str:
        """Reads current kernel boot identifier."""
        try:
            boot_id = (self.proc_root / "sys/kernel/random/boot_id").read_text(encoding="utf-8").strip()
        except OSError as error:
            raise self._error(error, "boot_id") from error
        if not boot_id:
            raise WatcherInterrupt("proc_parse_error", "boot_id is empty")
        return boot_id

    def read_btime(self) -> int:
        """Reads Unix boot time from /proc/stat."""
        try:
            stat_text = (self.proc_root / "stat").read_text(encoding="utf-8")
        except OSError as error:
            raise self._error(error, "system_stat") from error
        for line in stat_text.splitlines():
            fields = line.split()
            if len(fields) == 2 and fields[0] == "btime":
                try:
                    return int(fields[1])
                except ValueError as error:
                    raise WatcherInterrupt("proc_parse_error", "btime is invalid") from error
        raise WatcherInterrupt("proc_parse_error", "btime is missing")

    def read_process_stat(self, pid: int) -> Optional[ProcStat]:
        """Reads process stat, returning None only when its proc entry vanished."""
        try:
            text = (self.proc_root / str(pid) / "stat").read_text(encoding="utf-8")
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ESRCH):
                return None
            raise self._error(error, "process_stat") from error
        try:
            return parse_proc_stat(text)
        except ValueError as error:
            raise WatcherInterrupt("proc_parse_error", f"cannot parse stat for PID {pid}") from error

    def read_children(self, pid: int) -> List[int]:
        """Reads every thread children file for a still-known process."""
        task_dirs = glob.glob(str(self.proc_root / str(pid) / "task" / "*"))
        if not task_dirs:
            if self.read_process_stat(pid) is None:
                return []
            raise WatcherInterrupt("proc_children_unavailable", f"task directories missing for PID {pid}")

        children: Set[int] = set()
        for task_dir in task_dirs:
            try:
                content = (Path(task_dir) / "children").read_text(encoding="utf-8")
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ESRCH):
                    continue
                raise self._error(error, "process_children") from error
            for value in content.split():
                try:
                    child_pid = int(value)
                except ValueError as error:
                    raise WatcherInterrupt("proc_parse_error", f"invalid child PID for PID {pid}") from error
                if child_pid > 0:
                    children.add(child_pid)
        return sorted(children)

    @staticmethod
    def _error(error: OSError, operation: str) -> WatcherInterrupt:
        """Classifies non-disappearance operating-system failures."""
        if error.errno in (errno.EACCES, errno.EPERM):
            return WatcherInterrupt("proc_permission_denied", f"{operation}: {error.strerror or error}")
        return WatcherInterrupt("proc_read_error", f"{operation}: {error.strerror or error}")


def parse_proc_stat(text: str) -> ProcStat:
    """Parses a Linux stat line despite parentheses and spaces in process names."""
    left = text.find("(")
    right = text.rfind(")")
    if left <= 0 or right <= left:
        raise ValueError("missing process name")
    pid = int(text[:left].strip())
    fields = text[right + 1 :].split()
    if len(fields) <= 19:
        raise ValueError("missing start time")
    state = fields[0]
    if len(state) != 1:
        raise ValueError("invalid process state")
    return ProcStat(pid=pid, state=state, start_ticks=int(fields[19]))


def wall_started_at(btime: int, start_ticks: int, clock_ticks: int) -> str:
    """Converts boot-relative process ticks to an ISO-8601 UTC wall-clock time."""
    if clock_ticks <= 0:
        raise ValueError("clock_ticks must be positive")
    seconds = btime + start_ticks / clock_ticks
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now(clock: Callable[[], float]) -> str:
    """Returns current injected clock value as an ISO-8601 UTC timestamp."""
    return datetime.fromtimestamp(clock(), tz=timezone.utc).isoformat().replace("+00:00", "Z")


class Watcher:
    """Discovers and monitors one remote Linux process tree."""

    def __init__(
        self,
        config: Mapping[str, Any],
        *,
        proc_root: Path = Path("/proc"),
        state_root: Path = Path("/tmp"),
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], None] = time.sleep,
        output: TextIO = sys.stdout,
        clock_ticks: Optional[int] = None,
        popener: Callable[..., Any] = subprocess.Popen,
    ) -> None:
        """Builds watcher with injectable filesystem, time, and output dependencies."""
        self.config = validate_config(config)
        self.proc = ProcReader(proc_root, clock_ticks)
        self.state_root = state_root
        self.clock = clock
        self.sleeper = sleeper
        self.output = output
        self.popener = popener
        self.boot_id = ""
        self.btime = 0
        self.processes: Dict[int, ProcessRecord] = {}
        self.terminal: Optional[str] = None
        self.last_scanned_at: Optional[str] = None
        self.launched_process: Optional[Any] = None

    @property
    def state_path(self) -> Path:
        """Returns required per-user, per-session state-file location."""
        return (
            self.state_root
            / f"pi-ssh-target-{os.getuid()}"
            / self.config["session_id"]
            / f"{self.config['watch_id']}.json"
        )

    @property
    def state_dir(self) -> Path:
        """Returns parent directory that must remain private to this watch session."""
        return self.state_path.parent

    def prepare_system(self) -> None:
        """Reads stable system identity before a task can be launched."""
        self.boot_id = self.proc.read_boot_id()
        self.btime = self.proc.read_btime()

    def launch(self) -> None:
        """Starts one detached non-interactive process and emits no event itself."""
        try:
            self._ensure_state_dir()
        except WatcherInterrupt as error:
            raise WatcherInterrupt("launch_failed", error.message) from error
        stdout_path = Path(self.config.get("stdout_path") or self.state_dir / f"{self.config['watch_id']}.stdout.log")
        stderr_path = Path(self.config.get("stderr_path") or self.state_dir / f"{self.config['watch_id']}.stderr.log")
        stdout_file: Optional[TextIO] = None
        stderr_file: Optional[TextIO] = None
        try:
            stdout_file = self._open_log(stdout_path)
            stderr_file = self._open_log(stderr_path)
            environment = os.environ.copy()
            environment.update(self.config.get("env", {}))
            child = self.popener(
                [self.config["command"], *self.config["args"]],
                cwd=self.config.get("cwd"),
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=stdout_file,
                stderr=stderr_file,
                start_new_session=True,
                shell=False,
            )
        except OSError as error:
            raise WatcherInterrupt("launch_failed", f"cannot launch process: {error.strerror or error}") from error
        finally:
            if stdout_file is not None:
                stdout_file.close()
            if stderr_file is not None:
                stderr_file.close()
        pid = getattr(child, "pid", None)
        if not isinstance(pid, int) or pid <= 0:
            raise WatcherInterrupt("launch_failed", "launcher returned an invalid PID")
        self.launched_process = child
        self.config["root_pid"] = pid
        self.config["stdout_path"] = str(stdout_path)
        self.config["stderr_path"] = str(stderr_path)

    def initialize(self) -> None:
        """Loads an existing watch or records initial root identity and state."""
        if not self.boot_id:
            self.prepare_system()
        if self.config["resume"]:
            self._load_state()
            return

        root_stat = self.proc.read_process_stat(self.config["root_pid"])
        if root_stat is None:
            self.terminal = "finish"
        else:
            self._remember(root_stat)
        self.last_scanned_at = utc_now(self.clock)
        self._write_state()

    def scan(self) -> bool:
        """Checks known identities, recursively finds descendants, and persists results."""
        if self.launched_process is not None and hasattr(self.launched_process, "poll"):
            self.launched_process.poll()
        active: List[int] = []
        for record in list(self.processes.values()):
            if record.ended_at is not None:
                continue
            current = self.proc.read_process_stat(record.pid)
            if current is None or current.start_ticks != record.start_ticks:
                record.ended_at = utc_now(self.clock)
            else:
                active.append(record.pid)

        queue = list(active)
        inspected: Set[int] = set()
        while queue:
            pid = queue.pop(0)
            if pid in inspected:
                continue
            inspected.add(pid)
            record = self.processes.get(pid)
            if record is None or record.ended_at is not None:
                continue
            for child_pid in self.proc.read_children(pid):
                if child_pid not in self.processes:
                    child = self.proc.read_process_stat(child_pid)
                    if child is None:
                        continue
                    self._remember(child)
                    queue.append(child_pid)
                elif self.processes[child_pid].ended_at is None:
                    queue.append(child_pid)

        self.last_scanned_at = utc_now(self.clock)
        finished = all(record.ended_at is not None for record in self.processes.values())
        if finished:
            self.terminal = "finish"
        self._write_state()
        return finished

    def run(self, max_scans: Optional[int] = None) -> int:
        """Runs watcher lifecycle and emits launch, ready, and terminal events."""
        try:
            self.prepare_system()
            if "command" in self.config:
                self.launch()
                self.emit(
                    "launched",
                    stdout_path=self.config["stdout_path"],
                    stderr_path=self.config["stderr_path"],
                )
            self.initialize()
            ready_extra = {}
            if "command" in self.config:
                ready_extra = {
                    "stdout_path": self.config["stdout_path"],
                    "stderr_path": self.config["stderr_path"],
                }
            self.emit("ready", **ready_extra)
            if self.terminal == "finish":
                self.emit("finish")
                return 0
            scans = 0
            while max_scans is None or scans < max_scans:
                if self.scan():
                    self.emit("finish")
                    return 0
                scans += 1
                if max_scans is None or scans < max_scans:
                    self.sleeper(self.config["interval_seconds"])
            return 0
        except WatcherInterrupt as error:
            self.emit("interrupt", error_code=error.code, error=error.message)
            return 1
        except Exception as error:  # Defensive boundary for a remote one-shot script.
            self.emit("interrupt", error_code="internal_error", error=str(error))
            return 1

    def emit(self, event: str, **extra: Any) -> None:
        """Writes one fixed-prefix JSONL protocol event and flushes it immediately."""
        payload = {
            "event": event,
            "watch_id": self.config["watch_id"],
            "job_id": self.config["job_id"],
            "host": self.config["host"],
            "root_pid": self.config["root_pid"],
            "process_count": len(self.processes),
            "observed_at": utc_now(self.clock),
            "state_file": str(self.state_path),
        }
        payload.update(extra)
        self.output.write(f"{PROTOCOL_PREFIX}{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n")
        self.output.flush()

    def _remember(self, stat: ProcStat) -> None:
        """Adds a newly discovered process with stable identity and wall-clock start."""
        self.processes[stat.pid] = ProcessRecord(
            pid=stat.pid,
            start_ticks=stat.start_ticks,
            started_at=wall_started_at(self.btime, stat.start_ticks, self.proc.clock_ticks),
        )

    def _load_state(self) -> None:
        """Restores persisted identities and rejects missing, corrupt, or wrong-boot state."""
        try:
            raw_state = self.state_path.read_text(encoding="utf-8")
        except FileNotFoundError as error:
            raise WatcherInterrupt("state_missing", "state file is missing") from error
        except OSError as error:
            raise WatcherInterrupt("state_read_error", f"cannot read state file: {error.strerror or error}") from error
        try:
            state = json.loads(raw_state)
            if state["version"] != STATE_VERSION or state["boot_id"] != self.boot_id:
                if state["boot_id"] != self.boot_id:
                    raise WatcherInterrupt("boot_id_mismatch", "state boot_id differs from current server")
                raise ValueError("unsupported state version")
            records = state["processes"]
            if not isinstance(records, list):
                raise ValueError("processes is not a list")
            self.processes = {
                int(item["pid"]): ProcessRecord(
                    pid=int(item["pid"]),
                    start_ticks=int(item["start_ticks"]),
                    started_at=str(item["started_at"]),
                    ended_at=item.get("ended_at"),
                )
                for item in records
            }
            self.terminal = state.get("terminal")
            self.last_scanned_at = state.get("last_scanned_at")
        except WatcherInterrupt:
            raise
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise WatcherInterrupt("state_corrupt", "state file is invalid") from error

    def _ensure_state_dir(self) -> None:
        """Creates and restricts the per-session state directory."""
        try:
            self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self.state_dir, 0o700)
        except OSError as error:
            raise WatcherInterrupt("state_write_error", f"cannot create state directory: {error.strerror or error}") from error

    def _open_log(self, path: Path) -> TextIO:
        """Creates one append-only private log file before launching a task."""
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            os.fchmod(descriptor, 0o600)
            return os.fdopen(descriptor, "a", encoding="utf-8")
        except OSError as error:
            raise WatcherInterrupt("launch_failed", f"cannot open log file {path}: {error.strerror or error}") from error

    def _write_state(self) -> None:
        """Atomically replaces private JSON state file after every valid watcher update."""
        try:
            self._ensure_state_dir()
            persisted_config = {
                key: value
                for key, value in self.config.items()
                if key not in {"command", "args", "cwd", "env", "stdout_path", "stderr_path"}
            }
            state = {
                "version": STATE_VERSION,
                "config": persisted_config,
                "boot_id": self.boot_id,
                "processes": [asdict(self.processes[pid]) for pid in sorted(self.processes)],
                "last_scanned_at": self.last_scanned_at,
                "terminal": self.terminal,
            }
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{self.config['watch_id']}.", suffix=".tmp", dir=self.state_dir
            )
            try:
                os.fchmod(descriptor, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
                    json.dump(state, temporary, separators=(",", ":"), sort_keys=True)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_name, self.state_path)
                os.chmod(self.state_path, 0o600)
            except Exception:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                raise
        except OSError as error:
            raise WatcherInterrupt("state_write_error", f"cannot write state file: {error.strerror or error}") from error


def validate_config(config: Mapping[str, Any]) -> Dict[str, Any]:
    """Validates minimal standalone watcher configuration and applies safe defaults."""
    if not isinstance(config, Mapping):
        raise WatcherInterrupt("config_error", "configuration must be an object")
    result = dict(config)
    for key in ("watch_id", "session_id", "job_id", "host"):
        value = result.get(key)
        invalid_path_component = key in ("watch_id", "session_id") and isinstance(value, str) and (
            "/" in value or "\\" in value
        )
        if not isinstance(value, str) or not value or invalid_path_component:
            raise WatcherInterrupt("config_error", f"{key} must be a non-empty string")
    root_pid = result.get("root_pid", result.get("pid"))
    is_launch = "command" in result
    if is_launch:
        command = result.get("command")
        args = result.get("args")
        if not isinstance(command, str) or not command or len(command) > 1000:
            raise WatcherInterrupt("config_error", "command must be a non-empty string of at most 1000 characters")
        if not isinstance(args, list) or len(args) > 100 or any(
            not isinstance(argument, str) or len(argument) > 4000 for argument in args
        ):
            raise WatcherInterrupt("config_error", "args must contain at most 100 bounded strings")
        cwd = result.get("cwd")
        if cwd is not None and (not isinstance(cwd, str) or not cwd or len(cwd) > 1000):
            raise WatcherInterrupt("config_error", "cwd must be a non-empty bounded string")
        environment = result.get("env", {})
        if not isinstance(environment, Mapping) or len(environment) > 100:
            raise WatcherInterrupt("config_error", "env must be an object with at most 100 entries")
        for name, value in environment.items():
            if not isinstance(name, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is None:
                raise WatcherInterrupt("config_error", "env contains an invalid variable name")
            if not isinstance(value, str) or len(value) > 4000:
                raise WatcherInterrupt("config_error", "env values must be bounded strings")
        for key in ("stdout_path", "stderr_path"):
            path = result.get(key)
            if path is not None and (not isinstance(path, str) or not path or len(path) > 1000):
                raise WatcherInterrupt("config_error", f"{key} must be a non-empty bounded string")
        result["args"] = list(args)
        result["env"] = dict(environment)
        root_pid = 0
    if not isinstance(root_pid, int) or (root_pid <= 0 and not is_launch):
        raise WatcherInterrupt("config_error", "root_pid must be a positive integer")
    interval_seconds = result.get("interval_seconds", 5)
    if not isinstance(interval_seconds, (int, float)) or interval_seconds <= 0:
        raise WatcherInterrupt("config_error", "interval_seconds must be positive")
    result["root_pid"] = root_pid
    result["interval_seconds"] = float(interval_seconds)
    result["resume"] = bool(result.get("resume", False))
    return result


def main(config: Optional[Mapping[str, Any]] = None) -> int:
    """Runs script using WATCHER_CONFIG preamble when delivered through python3 stdin."""
    selected_config = config if config is not None else globals().get("WATCHER_CONFIG")
    try:
        return Watcher(selected_config).run()
    except WatcherInterrupt as error:
        fallback = selected_config if isinstance(selected_config, Mapping) else {}
        payload = {
            "event": "interrupt",
            "watch_id": fallback.get("watch_id"),
            "job_id": fallback.get("job_id"),
            "host": fallback.get("host"),
            "root_pid": fallback.get("root_pid", fallback.get("pid")),
            "process_count": 0,
            "observed_at": utc_now(time.time),
            "state_file": None,
            "error_code": error.code,
            "error": error.message,
        }
        sys.stdout.write(f"{PROTOCOL_PREFIX}{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n")
        sys.stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
