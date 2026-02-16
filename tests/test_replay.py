"""Replay test skeleton: ReplayFeed from JSONL -> StateClassifier + hedge gate."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.core.state.classifier import StateClassifier
from src.core.state.composite import CompositeState
from src.core.state.enums import ExecutionState
from src.strategy.hedge_gate import should_output_target


class ReplayFeed:
    """Minimal replay: read local JSONL events (ts, event_type, ...)."""

    def __init__(self, path: str):
        self.path = Path(path)
        self._events: list = []

    def load(self) -> None:
        if not self.path.exists():
            self._events = []
            return
        with open(self.path, encoding="utf-8") as f:
            self._events = [json.loads(line) for line in f if line.strip()]

    def __iter__(self):
        return iter(self._events)

    def __len__(self) -> int:
        return len(self._events)


@pytest.fixture
def replay_feed_path():
    return Path(__file__).resolve().parent / "fixtures" / "replay_events.jsonl"


class TestReplayFeed:
    def test_load_replay_events(self, replay_feed_path):
        feed = ReplayFeed(str(replay_feed_path))
        feed.load()
        assert len(feed) >= 5
        for ev in feed:
            assert "ts" in ev
            assert "event_type" in ev

    def test_replay_through_classifier_no_crash(self, replay_feed_path):
        """Run replay events through classifier + gate; assert no crash and final state exists."""
        feed = ReplayFeed(str(replay_feed_path))
        feed.load()
        pb = SimpleNamespace(stock_shares=0)
        md = SimpleNamespace(spread_pct=0.05, last_ts=None)
        g = SimpleNamespace(valid=True, delta=0.0, gamma=0.01, _legs=[1])
        om = SimpleNamespace(effective_e_state=lambda: ExecutionState.IDLE)
        config = {}
        last_cs = None
        for ev in feed:
            if ev.get("event_type") == "position":
                pb.stock_shares = ev.get("stock_shares", 0)
            if ev.get("event_type") == "greeks":
                g.valid = ev.get("valid", True)
                g.delta = ev.get("delta", 0.0)
                g.gamma = ev.get("gamma", 0.0)
            if ev.get("event_type") == "tick":
                md.last_ts = ev.get("ts")
                md.spread_pct = 0.05
            cs = StateClassifier.classify(pb, md, g, om, config=config)
            last_cs = cs
            _ = should_output_target(cs)
        assert last_cs is not None
        assert isinstance(last_cs, CompositeState)
