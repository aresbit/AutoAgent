"""M2: argv is the single source of flags; permission sources never mix."""

from __future__ import annotations

from pathlib import Path

from autoagent_backend.adapters.engine.argv import (
    FULL_ACCESS,
    PERMISSION_MODE_FLAG,
    REQUIRED_FLAGS,
    EngineCommand,
    PermissionKind,
    PermissionPolicy,
    build_argv,
    permission_args,
    valid_engine_ref,
)


def _command(**overrides: object) -> EngineCommand:
    values: dict[str, object] = {
        "bun_path": Path("/usr/local/bin/bun"),
        "cli_path": Path("/opt/opencc/dist/cli.js"),
        "cwd": Path("/work"),
    }
    values.update(overrides)
    return EngineCommand(**values)  # type: ignore[arg-type]


def test_required_matebot_flags_are_present() -> None:
    argv = build_argv(_command())
    for flag in REQUIRED_FLAGS:
        assert flag in argv
    assert argv.count("--matebot") == 1


def test_full_access_never_adds_permission_mode() -> None:
    argv = build_argv(_command())
    assert "--dangerously-skip-permissions" in argv
    assert PERMISSION_MODE_FLAG not in argv


def test_prompted_policy_never_adds_bypass_flag() -> None:
    policy = PermissionPolicy(PermissionKind.PROMPTED, "default")
    args = permission_args(policy)
    assert args == (PERMISSION_MODE_FLAG, "default")
    assert "--dangerously-skip-permissions" not in args

    argv = build_argv(_command(permission=policy))
    assert PERMISSION_MODE_FLAG in argv
    assert "--dangerously-skip-permissions" not in argv


def test_optional_values_are_individual_argv_elements() -> None:
    argv = build_argv(
        _command(
            model="claude-sonnet-4-6",
            append_system_prompt="be careful; do not concatenate",
            resume="11111111-1111-4111-8111-111111111111",
            add_dirs=("/tmp/one", "/tmp/two words"),
        )
    )
    assert argv[argv.index("--model") + 1] == "claude-sonnet-4-6"
    prompt_index = argv.index("--append-system-prompt")
    assert argv[prompt_index + 1] == "be careful; do not concatenate"
    assert argv[argv.index("--resume") + 1].startswith("11111111")
    assert "/tmp/two words" in argv


def test_no_shell_string_is_produced() -> None:
    argv = build_argv(_command(append_system_prompt="a && rm -rf /"))
    assert isinstance(argv, list)
    assert all(isinstance(item, str) for item in argv)
    assert "a && rm -rf /" in argv


def test_full_access_constant_is_version_one_policy() -> None:
    assert permission_args(FULL_ACCESS) == ("--dangerously-skip-permissions",)


def test_engine_ref_validation() -> None:
    assert valid_engine_ref("not-a-uuid") is None
    value = "11111111-1111-4111-8111-111111111111"
    assert valid_engine_ref(value) == value
