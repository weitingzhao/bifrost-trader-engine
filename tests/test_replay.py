"""Replay test skeleton: ReplayFeed from JSONL -> StateClassifier + hedge gate; FSM replay with assertions."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.core.state.classifier import StateClassifier
from src.core.state.composite import CompositeState
from src.core.state.enums import DeltaDeviationState, ExecutionState, OptionPositionState, TradingState
from src.core.state.snapshot import StateSnapshot, GreeksSnapshot
from src.fsm.events import TradingEvent
from src.fsm.trading_fsm import TradingFSM
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


@pytest.fixture
def replay_fsm_path():
    return Path(__file__).resolve().parent / "fixtures" / "replay_fsm.jsonl"


class TestReplayFSM:
    """Replay fixed event sequence; assert final state and TargetPosition/hedge gate outcomes."""

    def test_replay_fsm_final_state_and_target_emitted(self, replay_fsm_path):
        """Replay FSM fixture: drive TradingFSM with TICK; assert final state and NEED_HEDGE reached (target emitted)."""
        feed = ReplayFeed(str(replay_fsm_path))
        feed.load()
        assert len(feed) >= 5
        pb = SimpleNamespace(stock_shares=0)
        md = SimpleNamespace(spread_pct=0.05, last_ts=None)
        g = SimpleNamespace(valid=True, delta=0.0, gamma=0.02, _legs=[1])
        om = SimpleNamespace(effective_e_state=lambda: ExecutionState.IDLE)
        config = {"delta": {"epsilon_band": 10.0, "threshold_hedge_shares": 25.0}}
        fsm = TradingFSM(config=config, guard=None, on_transition=None)
        last_cs = None
        target_emitted = False
        spot = 99.05
        # Bootstrap TradingFSM: START -> SYNC, SYNCED -> IDLE/SAFE (use data_lag_ms=0 so replay ts don't trigger data_stale)
        cs0 = StateClassifier.classify(pb, md, g, om, config=config, data_lag_ms=0)
        snap0 = StateSnapshot.from_composite_state(
            cs0, spot=spot, greeks_snapshot=GreeksSnapshot(delta=g.delta, gamma=g.gamma, valid=g.valid), option_legs_count=1
        )
        fsm.apply_transition(TradingEvent.START, snap0)
        fsm.apply_transition(TradingEvent.SYNCED, snap0)
        for ev in feed:
            if ev.get("event_type") == "position":
                pb.stock_shares = ev.get("stock_shares", 0)
                g.delta = ev.get("net_delta", g.delta)
            if ev.get("event_type") == "greeks":
                g.valid = ev.get("valid", True)
                g.delta = ev.get("delta", 0.0)
                g.gamma = ev.get("gamma", 0.02)
            if ev.get("event_type") == "tick":
                md.last_ts = ev.get("ts")
                md.spread_pct = 0.05
                spot = ev.get("mid", spot)
            cs = StateClassifier.classify(pb, md, g, om, config=config, data_lag_ms=0)
            last_cs = cs
            snapshot = StateSnapshot.from_composite_state(
                cs, spot=spot, greeks_snapshot=GreeksSnapshot(delta=g.delta, gamma=g.gamma, valid=g.valid), option_legs_count=1
            )
            fsm.apply_transition(TradingEvent.TICK, snapshot)
            if fsm.state == TradingState.NEED_HEDGE:
                target_emitted = True
        assert last_cs is not None
        assert isinstance(last_cs, CompositeState)
        assert last_cs.O in (OptionPositionState.LONG_GAMMA, OptionPositionState.SHORT_GAMMA, OptionPositionState.NONE)
        assert last_cs.D in (DeltaDeviationState.IN_BAND, DeltaDeviationState.MINOR, DeltaDeviationState.HEDGE_NEEDED)
        assert target_emitted is True, "Expected TradingFSM to reach NEED_HEDGE at least once (net_delta=30 in replay)"

    def test_replay_fsm_final_net_delta_in_band(self, replay_fsm_path):
        """After replay, final net_delta is 0 (position hedged)."""
        feed = ReplayFeed(str(replay_fsm_path))
        feed.load()
        pb = SimpleNamespace(stock_shares=0)
        md = SimpleNamespace(spread_pct=0.05, last_ts=None)
        g = SimpleNamespace(valid=True, delta=0.0, gamma=0.02, _legs=[1])
        om = SimpleNamespace(effective_e_state=lambda: ExecutionState.IDLE)
        config = {}
        last_cs = None
        for ev in feed:
            if ev.get("event_type") == "position":
                pb.stock_shares = ev.get("stock_shares", 0)
                g.delta = ev.get("net_delta", g.delta)
            if ev.get("event_type") == "greeks":
                g.delta = ev.get("delta", 0.0)
            if ev.get("event_type") == "tick":
                md.last_ts = ev.get("ts")
            cs = StateClassifier.classify(pb, md, g, om, config=config)
            last_cs = cs
        assert last_cs is not None
        assert last_cs.net_delta == 0.0
        assert last_cs.stock_pos == -30
