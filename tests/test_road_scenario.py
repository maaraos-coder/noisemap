import math
import pytest
from noise_app.road_scenario import lden, validate_traffic, DEFAULT_TRAFFIC


def test_lden_equal_periods_penalties():
    # An equal level in the three periods gives Lden above Leq
    assert lden(50,50,50)==pytest.approx(56.395243,abs=1e-5)


def test_lden_equal_adjusted_levels():
    # 60 dB day, 55 dB evening (+5), 50 dB night (+10)
    assert lden(60,55,50)==pytest.approx(60.0,abs=1e-9)


def test_lden_rejects_nonfinite_values():
    with pytest.raises(ValueError):
        lden(float('nan'),50,40)


def test_traffic_validation():
    validate_traffic(DEFAULT_TRAFFIC)
    dirty={k:dict(v) for k,v in DEFAULT_TRAFFIC.items()}
    dirty['night']['light']=-1
    with pytest.raises(ValueError):
        validate_traffic(dirty)
