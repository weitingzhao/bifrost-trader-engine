"""read_config deep-merge of config.yaml with config.dev.yaml / config.prod.yaml."""

from pathlib import Path

from src.app.config import read_config


def test_merge_prod_overlay_wins_scalar(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "config.yaml").write_text(
        "postgres:\n  database: shared\n  host: h1\n",
        encoding="utf-8",
    )
    (cfg / "config.prod.yaml").write_text(
        "postgres:\n  database: prod_db\n",
        encoding="utf-8",
    )
    merged, path = read_config(str(cfg / "config.prod.yaml"))
    assert path == str((cfg / "config.prod.yaml").resolve())
    assert merged["postgres"]["database"] == "prod_db"
    assert merged["postgres"]["host"] == "h1"


def test_merge_nested_dict(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "config.yaml").write_text(
        "server:\n  port: 8765\n  extra: x\n",
        encoding="utf-8",
    )
    (cfg / "config.dev.yaml").write_text(
        "server:\n  port: 9000\n",
        encoding="utf-8",
    )
    merged, _ = read_config(str(cfg / "config.dev.yaml"))
    assert merged["server"]["port"] == 9000
    assert merged["server"]["extra"] == "x"


def test_no_merge_when_only_single_file_name(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "config.yaml").write_text("a: 1\n", encoding="utf-8")
    merged, _ = read_config(str(cfg / "config.yaml"))
    assert merged == {"a": 1}


def test_prod_without_base_uses_overlay_only(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "config.prod.yaml").write_text("k: v\n", encoding="utf-8")
    merged, _ = read_config(str(cfg / "config.prod.yaml"))
    assert merged == {"k": "v"}
