"""
사내 홈페이지용 회사 데이터 내보내기  (실행: python src/export_intranet.py)

docs/data/company.js 를 만든다 (사내포털 = docs/ 폴더 전체, GitHub Pages로 게시).
  - 스크랩 등급 카탈로그, 강종 규격, 생산 계획
  - 60일 시세·재고 (날짜 × 등급)
  - 검수 메모 전체
  - 과거 조업 이력으로 추정한 등급별 성분 (도구 3 estimate_composition 결과)
  - 배합 작업실(브라우저 계산)이 쓰는 설정값: 설비 제약, 목표 이탈확률, 숙련자 배합표, 검수 메모 키워드

★ 회사가 실제로 가진 정보(CSV)와 그것으로 계산한 값만 쓴다. ground_truth.json은 읽지 않는다.
  사내 홈페이지는 '회사 직원이 보는 화면'이므로 숨은 정답이 들어가면 안 된다.
배합 지시서(에이전트 실행 결과)는 evaluate.py가 만드는 docs/data/results.js를 같이 쓴다.
"""
import json

from config import (EXPERT_RECIPE, GRADES, MAX_CHARGE_VOLUME_M3, MAX_ITERATIONS, N_SIM,
                    TARGET_FAIL_PROB, WEB_DIR)
from pipeline import SUBSTITUTES
from tools import estimate_composition
from tools.common import _read, production_plan, scrap_table, specs_table
from tools.parse_inspection_notes import CU_WORDS, SN_WORDS


def build():
    scrap = scrap_table().reset_index()
    market = _read("market_inventory.csv")
    notes = _read("inspection_notes.csv")
    hist = _read("heat_history.csv")

    mk = {}
    for r in market.itertuples():
        mk.setdefault(r.date, {})[r.grade_id] = [int(r.price_krw_per_t), int(r.inventory_t)]

    comp = estimate_composition()
    return {
        "scrap": scrap.to_dict(orient="records"),
        "specs": specs_table().reset_index().to_dict(orient="records"),
        "plan": production_plan().to_dict(orient="records"),
        "market": mk,
        "notes": notes.to_dict(orient="records"),
        "history_period": [hist["date"].min(), hist["date"].max()],
        # 과거 조업 이력 원본 (AI 배합 설계에서 Claude가 기록을 직접 분석할 때 쓴다)
        # 한 줄 = [heat_id, 날짜, 강종, 등급별 장입량 t × 8, 출강량 t, Cu %, Sn %, 전력 kWh, 합격 여부]
        "heats": {"cols": ["heat_id", "date", "steel"] + ["charge_" + g for g in GRADES]
                          + ["tap_t", "cu_pct", "sn_pct", "power_kwh", "pass"],
                  "rows": [[r["heat_id"], r["date"], r["steel_grade"]]
                           + [round(float(r["charge_%s_t" % g]), 2) for g in GRADES]
                           + [round(float(r["tap_weight_t"]), 2), float(r["cu_pct"]), float(r["sn_pct"]),
                              int(r["power_kwh"]), r["pass_fail"] == "PASS"]
                           for _, r in hist.iterrows()]},
        "estimate": {"grades": comp["grades"], "meas_sd": comp["meas_sd"], "cv": comp["cv"],
                     "n_heats": comp["n_heats"], "outlier_dates": comp["outlier_dates"]},
        "config": {"grades": GRADES, "max_charge_volume_m3": MAX_CHARGE_VOLUME_M3,
                   "target_fail_prob": TARGET_FAIL_PROB, "max_iterations": MAX_ITERATIONS, "n_sim": N_SIM,
                   "expert_recipe": EXPERT_RECIPE, "substitutes": SUBSTITUTES,
                   "cu_words": CU_WORDS, "sn_words": SN_WORDS},
    }


def export_intranet():
    out = WEB_DIR / "data"
    out.mkdir(parents=True, exist_ok=True)
    js = "window.REBORN_COMPANY = " + json.dumps(build(), ensure_ascii=False, default=float) + ";\n"
    (out / "company.js").write_text(js, encoding="utf-8")
    return out / "company.js"


if __name__ == "__main__":
    print("저장:", export_intranet())
