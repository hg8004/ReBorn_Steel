"""
도구들이 같이 쓰는 데이터 읽기 함수.

★ 여기서는 ground_truth.json을 절대 읽지 않는다.
  에이전트가 볼 수 있는 것은 회사가 실제로 가진 정보(CSV)뿐이다.
"""
import sys
from functools import lru_cache
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import DATA_DIR, GRADES  # noqa: E402


@lru_cache(maxsize=None)
def _read(name):
    return pd.read_csv(DATA_DIR / name, encoding="utf-8-sig")


def scrap_table():
    """스크랩 등급 공칭값 (GRADES 순서로 정렬)"""
    return _read("scrap_grades.csv").set_index("grade_id").loc[GRADES]


def specs_table():
    return _read("steel_specs.csv").set_index("steel_grade")


def heat_history():
    return _read("heat_history.csv")


def market(date):
    """해당 날짜의 시세·재고 (GRADES 순서)"""
    m = _read("market_inventory.csv")
    day = m[m["date"] == date].set_index("grade_id")
    if day.empty:
        raise ValueError(f"{date}의 시세·재고 데이터가 없습니다.")
    return day.loc[GRADES]


def notes(date):
    n = _read("inspection_notes.csv")
    return n[n["date"] == date].reset_index(drop=True)


def production_plan():
    return _read("production_plan.csv")


def available_dates():
    """배합을 짤 수 있는 날짜 = 과거 이력 이후의 날짜 (회사 데이터만으로 계산)"""
    m = _read("market_inventory.csv")
    last_hist = heat_history()["date"].max()
    return sorted(d for d in m["date"].unique() if d > last_hist)
