"""Unit tests for standalone remote Python watcher."""

import errno
import importlib.util
import io
import json
import os
import stat as stat_module
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[2] / "src" / "watcher.py"
SPEC = importlib.util.spec_from_file_location("pi_ssh_target_watcher", MODULE_PATH)
watcher = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(watcher)


class IncrementingClock:
    """Provides distinct but deterministic timestamps for persistence assertions."""

    def __init__(self) -> None:
        """Starts at a fixed Unix time."""
        self.value = 1_700_000_000

    def __call__(self) -> float:
        """Returns and advances timestamp by one second."""
        current = self.value
        self.value += 1
        return current


class WatcherTestCase(unittest.TestCase):
    """Exercises /proc discovery, identity, persistence, and JSONL protocol."""

    def setUp(self) -> None:
        """Creates isolated fake Linux /proc and remote /tmp trees."""
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.proc = self.root / "proc"
        self.state_root = self.root / "tmp"
        (self.proc / "sys/kernel/random").mkdir(parents=True)
        (self.proc / "sys/kernel/random/boot_id").write_text("boot-one\n", encoding="utf-8")
        (self.proc / "stat").write_text("cpu 1 2 3\nbtime 1000\n", encoding="utf-8")
        self.clock = IncrementingClock()

    def tearDown(self) -> None:
        """Removes fake filesystem after every test."""
        self.temporary.cleanup()

    def config(self, **overrides: object) -> dict[str, object]:
        """Returns valid watcher configuration with optional overrides."""
        result: dict[str, object] = {
            "watch_id": "watch-1",
            "session_id": "session-1",
            "job_id": "job-1",
            "host": "remote.example",
            "root_pid": 100,
            "interval_seconds": 0.01,
        }
        result.update(overrides)
        return result

    def write_process(
        self, pid: int, *, start_ticks: int, state: str = "S", threads: dict[int, list[int]] | None = None
    ) -> None:
        """Writes a minimal process stat and all requested thread children files."""
        process = self.proc / str(pid)
        process.mkdir(parents=True, exist_ok=True)
        fields = [state, *("0" for _ in range(18)), str(start_ticks)]
        (process / "stat").write_text(f"{pid} (name with ) space) {' '.join(fields)}\n", encoding="utf-8")
        for tid, children in (threads or {pid: []}).items():
            task = process / "task" / str(tid)
            task.mkdir(parents=True, exist_ok=True)
            (task / "children").write_text(" ".join(map(str, children)), encoding="utf-8")

    def make_watcher(
        self,
        config: dict[str, object],
        output: io.StringIO | None = None,
        popener: object = watcher.subprocess.Popen,
    ) -> watcher.Watcher:
        """Builds watcher against fake filesystem and deterministic clock."""
        return watcher.Watcher(
            config,
            proc_root=self.proc,
            state_root=self.state_root,
            clock=self.clock,
            sleeper=lambda _: None,
            output=output or io.StringIO(),
            clock_ticks=100,
            popener=popener,
        )

    def protocol_events(self, output: io.StringIO) -> list[dict[str, object]]:
        """Parses only fixed-prefix watcher protocol lines."""
        return [
            json.loads(line.removeprefix(watcher.PROTOCOL_PREFIX))
            for line in output.getvalue().splitlines()
            if line.startswith(watcher.PROTOCOL_PREFIX)
        ]

    def test_parses_stat_boot_btime_and_wall_start_time(self) -> None:
        """Parses stat names with parentheses plus boot-relative wall-clock start."""
        parsed = watcher.parse_proc_stat("42 (worker ) name) Z " + "0 " * 18 + "250\n")
        self.assertEqual((parsed.pid, parsed.state, parsed.start_ticks), (42, "Z", 250))
        reader = watcher.ProcReader(self.proc, clock_ticks=100)
        self.assertEqual(reader.read_boot_id(), "boot-one")
        self.assertEqual(reader.read_btime(), 1000)
        self.assertEqual(watcher.wall_started_at(1000, 250, 100), "1970-01-01T00:16:42.500000Z")

    def test_recursively_discovers_children_from_all_threads(self) -> None:
        """Finds separate thread children and recursively discovered grandchildren."""
        self.write_process(100, start_ticks=10, threads={100: [101], 102: [102]})
        self.write_process(101, start_ticks=11, threads={101: [103]})
        self.write_process(102, start_ticks=12)
        self.write_process(103, start_ticks=13)
        instance = self.make_watcher(self.config())
        instance.initialize()
        self.assertFalse(instance.scan())
        self.assertEqual(set(instance.processes), {100, 101, 102, 103})

    def test_child_outlives_root_and_pid_reuse_is_ended(self) -> None:
        """Keeps discovered child after root disappears and does not accept reused PID."""
        self.write_process(100, start_ticks=10, threads={100: [101]})
        self.write_process(101, start_ticks=11)
        instance = self.make_watcher(self.config())
        instance.initialize()
        instance.scan()
        for path in sorted((self.proc / "100").rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            else:
                path.rmdir()
        (self.proc / "100").rmdir()
        self.assertFalse(instance.scan())
        self.assertIsNotNone(instance.processes[100].ended_at)
        self.assertIsNone(instance.processes[101].ended_at)
        self.write_process(101, start_ticks=999)
        self.assertTrue(instance.scan())
        self.assertEqual(instance.processes[101].start_ticks, 11)
        self.assertIsNotNone(instance.processes[101].ended_at)

    def test_zombie_and_scan_race_do_not_interrupt(self) -> None:
        """Treats zombie as alive and child disappearing between reads as normal race."""
        self.write_process(100, start_ticks=10, state="Z", threads={100: [101]})
        instance = self.make_watcher(self.config())
        instance.initialize()
        self.assertFalse(instance.scan())
        self.assertIsNone(instance.processes[100].ended_at)
        self.assertNotIn(101, instance.processes)

    def test_proc_parse_permission_and_state_write_errors_become_interrupts(self) -> None:
        """Classifies parse, permission, and durable-state failures as interruptions."""
        permission_output = io.StringIO()
        with patch.object(Path, "read_text", side_effect=PermissionError(errno.EACCES, "denied")):
            result = self.make_watcher(self.config(), permission_output).run(max_scans=1)
        permission_event = self.protocol_events(permission_output)[-1]
        self.assertEqual(result, 1)
        self.assertEqual(permission_event["event"], "interrupt")
        self.assertEqual(permission_event["error_code"], "proc_permission_denied")

        bad_proc = self.proc / "100"
        bad_proc.mkdir()
        (bad_proc / "stat").write_text("broken stat", encoding="utf-8")
        parse_output = io.StringIO()
        self.assertEqual(self.make_watcher(self.config(), parse_output).run(max_scans=1), 1)
        self.assertEqual(self.protocol_events(parse_output)[-1]["error_code"], "proc_parse_error")

        (bad_proc / "stat").unlink()
        self.write_process(100, start_ticks=10)
        write_output = io.StringIO()
        with patch.object(watcher.tempfile, "mkstemp", side_effect=OSError(errno.EACCES, "denied")):
            self.assertEqual(self.make_watcher(self.config(), write_output).run(max_scans=1), 1)
        self.assertEqual(self.protocol_events(write_output)[-1]["error_code"], "state_write_error")

    def test_state_permissions_atomic_replace_and_scan_time_updates(self) -> None:
        """Persists private state via replace and refreshes timestamp after each scan."""
        self.write_process(100, start_ticks=10)
        instance = self.make_watcher(self.config())
        with patch("os.replace", wraps=os.replace) as replace:
            instance.initialize()
            first = json.loads(instance.state_path.read_text(encoding="utf-8"))["last_scanned_at"]
            instance.scan()
        second = json.loads(instance.state_path.read_text(encoding="utf-8"))["last_scanned_at"]
        self.assertNotEqual(first, second)
        self.assertGreaterEqual(replace.call_count, 2)
        self.assertEqual(stat_module.S_IMODE(instance.state_dir.stat().st_mode), 0o700)
        self.assertEqual(stat_module.S_IMODE(instance.state_path.stat().st_mode), 0o600)
        self.assertEqual(list(instance.state_dir.glob("*.tmp")), [])

    def test_resume_validates_state_and_keeps_discovered_descendants(self) -> None:
        """Restores all known descendants and interrupts for missing or wrong-boot state."""
        self.write_process(100, start_ticks=10, threads={100: [101]})
        self.write_process(101, start_ticks=11)
        original = self.make_watcher(self.config())
        original.initialize()
        original.scan()
        resumed = self.make_watcher(self.config(resume=True))
        resumed.initialize()
        self.assertEqual(set(resumed.processes), {100, 101})

        missing_output = io.StringIO()
        missing = self.make_watcher(self.config(watch_id="missing", resume=True), missing_output)
        self.assertEqual(missing.run(max_scans=1), 1)
        self.assertEqual(self.protocol_events(missing_output)[-1]["error_code"], "state_missing")

        corrupt = self.make_watcher(self.config(watch_id="corrupt"))
        corrupt.initialize()
        corrupt.state_path.write_text("not JSON", encoding="utf-8")
        corrupt_output = io.StringIO()
        corrupt_resume = self.make_watcher(self.config(watch_id="corrupt", resume=True), corrupt_output)
        self.assertEqual(corrupt_resume.run(max_scans=1), 1)
        self.assertEqual(self.protocol_events(corrupt_output)[-1]["error_code"], "state_corrupt")

        (self.proc / "sys/kernel/random/boot_id").write_text("boot-two\n", encoding="utf-8")
        mismatch_output = io.StringIO()
        mismatch = self.make_watcher(self.config(resume=True), mismatch_output)
        self.assertEqual(mismatch.run(max_scans=1), 1)
        self.assertEqual(self.protocol_events(mismatch_output)[-1]["error_code"], "boot_id_mismatch")

    def test_structured_launch_uses_argv_and_private_default_logs(self) -> None:
        """Launches with shell disabled and emits private default log paths before ready."""
        self.write_process(321, start_ticks=20)
        calls: list[tuple[list[str], dict[str, object]]] = []

        class FakeChild:
            pid = 321

        def fake_popen(argv: list[str], **kwargs: object) -> FakeChild:
            calls.append((argv, kwargs))
            return FakeChild()

        output = io.StringIO()
        instance = self.make_watcher(
            self.config(root_pid=0, command="python3", args=["train.py", "a; b"], env={"GPU": "0"}),
            output,
            fake_popen,
        )
        self.assertEqual(instance.run(max_scans=1), 0)
        events = self.protocol_events(output)
        self.assertEqual([event["event"] for event in events], ["launched", "ready"])
        self.assertEqual(calls[0][0], ["python3", "train.py", "a; b"])
        self.assertIs(calls[0][1]["shell"], False)
        self.assertIs(calls[0][1]["start_new_session"], True)
        self.assertEqual(calls[0][1]["env"]["GPU"], "0")
        stdout_path = Path(events[0]["stdout_path"])
        stderr_path = Path(events[0]["stderr_path"])
        self.assertEqual(stat_module.S_IMODE(stdout_path.stat().st_mode), 0o600)
        self.assertEqual(stat_module.S_IMODE(stderr_path.stat().st_mode), 0o600)
        self.assertEqual(stat_module.S_IMODE(instance.state_dir.stat().st_mode), 0o700)
        persisted_config = json.loads(instance.state_path.read_text(encoding="utf-8"))["config"]
        for launch_only_key in ("command", "args", "cwd", "env", "stdout_path", "stderr_path"):
            self.assertNotIn(launch_only_key, persisted_config)

    def test_launch_failure_emits_interrupt_without_launched(self) -> None:
        """Reports launch_failed before any PID exists or lifecycle can become active."""
        def missing_command(_argv: list[str], **_kwargs: object) -> object:
            raise FileNotFoundError(errno.ENOENT, "missing")

        output = io.StringIO()
        instance = self.make_watcher(
            self.config(root_pid=0, command="missing", args=[]),
            output,
            missing_command,
        )
        self.assertEqual(instance.run(max_scans=1), 1)
        events = self.protocol_events(output)
        self.assertEqual([event["event"] for event in events], ["interrupt"])
        self.assertEqual(events[0]["error_code"], "launch_failed")
        self.assertEqual(events[0]["root_pid"], 0)

    def test_custom_log_paths_are_returned(self) -> None:
        """Uses caller-provided log paths while keeping private file modes."""
        self.write_process(322, start_ticks=21)

        class FakeChild:
            pid = 322

        stdout_path = self.root / "logs" / "custom.out"
        stderr_path = self.root / "logs" / "custom.err"
        output = io.StringIO()
        instance = self.make_watcher(
            self.config(
                root_pid=0,
                command="worker",
                args=[],
                stdout_path=str(stdout_path),
                stderr_path=str(stderr_path),
            ),
            output,
            lambda _argv, **_kwargs: FakeChild(),
        )
        self.assertEqual(instance.run(max_scans=1), 0)
        launched = self.protocol_events(output)[0]
        self.assertEqual((launched["stdout_path"], launched["stderr_path"]), (str(stdout_path), str(stderr_path)))
        self.assertEqual(stat_module.S_IMODE(stdout_path.stat().st_mode), 0o600)
        self.assertEqual(stat_module.S_IMODE(stderr_path.stat().st_mode), 0o600)

    def test_ready_finish_and_initial_missing_pid_protocol(self) -> None:
        """Emits prefixed ready then immediate finish after valid missing-root registration."""
        output = io.StringIO()
        instance = self.make_watcher(self.config(root_pid=999), output)
        self.assertEqual(instance.run(), 0)
        events = self.protocol_events(output)
        self.assertEqual([event["event"] for event in events], ["ready", "finish"])
        self.assertTrue(instance.state_path.exists())
        self.assertEqual(json.loads(instance.state_path.read_text(encoding="utf-8"))["terminal"], "finish")


if __name__ == "__main__":
    unittest.main()
