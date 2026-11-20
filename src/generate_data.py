"""
합성 데이터 생성기  (실행: python src/generate_data.py)

'숨은 정답' 방식으로 데이터를 만든다.
  1) 등급별 '실제' Cu·Sn 분포를 정하고 ground_truth.json에 숨긴다 (공칭값과 일부러 다르게).
  2) 숙련자 규칙 배합표에 무작위 변동을 줘서 과거 500 heat의 배합을 만든다.
  3) 실제 분포에서 성분을 뽑아 heat 성분을 계산하고, 분석 측정 노이즈를 더한다.
  4) 일부 로트(날짜×등급)에 이상치를 심고, 그 로트에 맞는 검수 메모를 남긴다.
  5) 시세·재고는 60일 동안 완만하게 움직이고, 재고 부족 기간을 몇 번 넣는다.

모든 수치는 수업 과제를 위한 가상 설정이다.
"""
import json
from datetime import date, timedelta

import numpy as np
import pandas as pd

from config import (DATA_DIR, GRADES, GROUND_TRUTH_PATH, EXPERT_RECIPE,
                    RANDOM_SEED)

rng = np.random.default_rng(RANDOM_SEED)

# ----------------------------------------------------------------
# 1. 스크랩 등급 공칭값 (회사가 알고 있는 '카탈로그' 값) [기본값]
# ----------------------------------------------------------------
SCRAP = pd.DataFrame([
    # grade_id, 한글명, 단가, 실수율, 부피밀도, 공칭Cu, 공칭Sn
    ("HS_A",  "생철A",    430000, 0.96, 1.30, 0.04, 0.005),
    ("HS_B",  "생철B",    415000, 0.95, 1.20, 0.06, 0.006),
    ("HMS_A", "중량A",    395000, 0.93, 0.90, 0.15, 0.012),
    ("HMS_B", "중량B",    380000, 0.91, 0.80, 0.22, 0.015),
    ("LS_A",  "경량A",    355000, 0.88, 0.55, 0.30, 0.020),
    ("LS_B",  "경량B",    335000, 0.85, 0.45, 0.40, 0.028),
    ("SHR",   "슈레디드", 400000, 0.92, 1.10, 0.20, 0.015),
    ("TRN",   "선반설",   320000, 0.84, 0.90, 0.12, 0.010),
], columns=["grade_id", "name_kr", "price_krw_per_t", "yield",
            "bulk_density_t_per_m3", "nominal_cu_pct", "nominal_sn_pct"])

SPECS = pd.DataFrame([
    ("SD400", 0.40, 0.040),
    ("SD500", 0.35, 0.035),
    ("SD600", 0.30, 0.030),
], columns=["steel_grade", "cu_max_pct", "sn_max_pct"])

# ----------------------------------------------------------------
# 2. 숨은 정답: 등급별 '실제' 성분 분포 (평균, 표준편차)
#    공칭값보다 대체로 조금 높다 → 공칭값만 믿으면 규격을 넘기게 된다.
# ----------------------------------------------------------------
TRUE_DIST = {
    #          cu_mean cu_sd  sn_mean sn_sd
    "HS_A":  (0.045, 0.010, 0.0055, 0.0015),
    "HS_B":  (0.070, 0.015, 0.0070, 0.0020),
    "HMS_A": (0.170, 0.040, 0.0130, 0.0030),
    "HMS_B": (0.250, 0.060, 0.0170, 0.0040),
    "LS_A":  (0.340, 0.080, 0.0230, 0.0060),
    "LS_B":  (0.450, 0.100, 0.0320, 0.0080),
    "SHR":   (0.230, 0.050, 0.0165, 0.0040),
    "TRN":   (0.130, 0.030, 0.0110, 0.0030),
}
MEAS_NOISE = {"cu": 0.005, "sn": 0.0008}   # 분석기 측정 노이즈 (표준편차, %)

# ----------------------------------------------------------------
# 3. 기간 설정
#    - 시세·재고·검수메모: 60일 (2026-09-01 ~ 2026-10-30)
#    - 과거 조업 이력: 앞쪽 약 21일 (500 heat)
#    - 나머지 39일은 '평가용 날짜'로, 에이전트가 배합을 짜는 날이다.
# ----------------------------------------------------------------
START = date(2026, 9, 1)
N_DAYS = 60
DATES = [START + timedelta(days=d) for d in range(N_DAYS)]
N_HISTORY = 500
HEATS_PER_DAY = 24

# ----------------------------------------------------------------
# 4. 이상 로트 (숨은 정답). 로트 ID = "등급-날짜"
#    note: 그 로트를 검수할 때 남긴 메모. 에이전트는 이 메모만 볼 수 있다.
# ----------------------------------------------------------------
ANOMALIES = [
    # 과거 이력 기간 (추정 도구가 이상치를 걸러내야 함)
    ("2026-09-05", "LS_A",  "cu", 2.0, "모터·전선 혼입 다수, Cu 주의"),
    ("2026-09-14", "HMS_B", "sn", 2.2, "주석도금 캔 다량 혼입 의심. Sn 높을 듯"),
    # 평가 기간
    ("2026-09-25", "LS_A",  "cu", 2.0, "모터·전선 혼입 다수, Cu 주의"),
    ("2026-10-02", "TRN",   "cu", 2.6, "황동 절삭칩 섞여 들어옴. 구리 성분 높을 가능성"),
    ("2026-10-08", "LS_B",  "sn", 2.0, "주석도금 강판(캔) 혼입 확인, Sn 주의 요망"),
    ("2026-10-15", "HMS_B", "cu", 1.9, "폐모터 고정자 다수 발견, 구리코일 미분리"),
    ("2026-10-21", "LS_A",  "cu", 2.0, "가전 폐기물 혼입, 전선 뭉치 많음"),
    ("2026-10-27", "SHR",   "cu", 2.0, "슈레더 비철 선별기 고장 기간 입고분. Cu 혼입 우려"),
]

# 일반 메모 (성분 영향 없음)
NORMAL_NOTES = ["특이사항 없음", "특이사항 없음", "특이사항 없음",
                "유분 많음", "수분 많음, 예열 권장", "부피 큼, 장입 횟수 주의",
                "이물질(콘크리트 조각) 소량", "녹 심함", "규격 대비 두께 얇음"]

# 헷갈리게 만드는 메모 (위험 단어가 있지만 실제로는 문제없음)
#   → 단순 키워드 검색은 속고, LLM은 문맥으로 걸러낼 수 있는지 보는 용도
DECOY_NOTES = [
    ("2026-09-29", "LS_A",  "전선 피복 소량 발견, 선별 후 전량 제거 완료"),
    ("2026-10-11", "HMS_B", "작년 모터 혼입 건 협력사. 이번 입고분은 정밀 선별 완료, 이상 없음"),
    ("2026-10-24", "TRN",   "황동칩 혼입 여부 자체 분석 결과 Cu 정상 범위"),
]

# 재고 부족 기간 (등급, 시작일, 종료일, 재고 상한 t)
SHORTAGES = [
    ("HS_A", "2026-09-28", "2026-09-30", 150),
    ("TRN",  "2026-10-10", "2026-10-12", 40),
    ("HS_B", "2026-10-18", "2026-10-19", 200),
    ("LS_A", "2026-10-25", "2026-10-26", 120),
]
BASE_INVENTORY = {"HS_A": 900, "HS_B": 900, "HMS_A": 1100, "HMS_B": 900,
                  "LS_A": 700, "LS_B": 500, "SHR": 700, "TRN": 350}


def lot_id(grade, d):
    """로트 ID: 날짜별로 등급마다 1개 로트가 쓰인다고 가정"""
    return f"{grade}-{d.replace('-', '')}"


def make_market():
    """60일 시세·재고. 시세는 완만한 랜덤워크, 재고는 기준값 주변에서 변동."""
    rows = []
    price = SCRAP.set_index("grade_id")["price_krw_per_t"].astype(float).to_dict()
    common = 0.0  # 시장 전체 흐름 (모든 등급이 같이 움직이는 부분)
    for d in DATES:
        ds = d.isoformat()
        common = 0.9 * common + rng.normal(0, 0.004)
        for g in GRADES:
            # 기준가 대비 ±몇 % 수준으로 움직이도록
            base = SCRAP.set_index("grade_id").loc[g, "price_krw_per_t"]
            price[g] = price[g] * (1 + common * 0.3 + rng.normal(0, 0.003))
            price[g] = 0.98 * price[g] + 0.02 * base        # 기준가로 서서히 복귀
            inv = BASE_INVENTORY[g] * rng.uniform(0.8, 1.2)
            for sg, s, e, cap in SHORTAGES:
                if sg == g and s <= ds <= e:
                    inv = cap
            rows.append((ds, g, int(round(price[g], -2)), int(round(inv))))
    return pd.DataFrame(rows, columns=["date", "grade_id", "price_krw_per_t", "inventory_t"])


def expert_ratio_with_noise(steel):
    """숙련자 배합표 + 무작위 변동. 사내 규칙을 다시 만족하도록 보정."""
    r = np.array(EXPERT_RECIPE[steel], float)
    # 재고·시세에 따라 담당자가 배합을 꽤 바꾼다고 가정 (등급별 비율에 ±50% 수준의 변동)
    r = r * rng.lognormal(0, 0.50, size=len(r))
    r = r / r.sum()
    # 규칙1: 경량(LS_A+LS_B) 합계 20% 이하
    ls = r[4] + r[5]
    if ls > 0.20:
        r[4:6] *= 0.20 / ls
        r = r / r.sum()
    # 규칙2: SD600은 생철(HS_A+HS_B) 40% 이상
    if steel == "SD600" and r[0] + r[1] < 0.40:
        need = 0.40 - (r[0] + r[1])
        r[0:2] *= (r[0] + r[1] + need) / (r[0] + r[1])
        others = 1 - r[0] - r[1]
        r[2:] *= others / r[2:].sum()
    return r / r.sum()


def anomaly_factor(ds, grade, elem):
    for ad, ag, ae, mult, _ in ANOMALIES:
        if ad == ds and ag == grade and ae == elem:
            return mult
    return 1.0


def sample_composition(ds, n=1):
    """해당 날짜 로트에서 등급별 Cu, Sn을 n번 샘플링 (heat 1회분씩)."""
    cu = np.zeros((n, len(GRADES)))
    sn = np.zeros((n, len(GRADES)))
    for j, g in enumerate(GRADES):
        cm, cs, sm, ss = TRUE_DIST[g]
        cu[:, j] = np.maximum(rng.normal(cm, cs, n), 0.3 * cm) * anomaly_factor(ds, g, "cu")
        sn[:, j] = np.maximum(rng.normal(sm, ss, n), 0.3 * sm) * anomaly_factor(ds, g, "sn")
    return cu, sn


def make_history(market):
    """과거 500 heat 조업 이력"""
    specs = SPECS.set_index("steel_grade")
    y = SCRAP["yield"].values
    rows = []
    mix = ["SD400"] * 12 + ["SD500"] * 8 + ["SD600"] * 4
    for k in range(N_HISTORY):
        d = DATES[k // HEATS_PER_DAY].isoformat()
        steel = mix[k % HEATS_PER_DAY]
        W = rng.normal(100, 1.5)
        r = expert_ratio_with_noise(steel)
        charge = r * W / (r * y).sum()                 # 목표 출강량이 나오도록 총 장입량 결정
        cu_i, sn_i = sample_composition(d)
        tap = (y * charge).sum() * rng.normal(1, 0.006)  # 실수율에도 약간의 변동
        cu = (cu_i[0] * charge).sum() / tap + rng.normal(0, MEAS_NOISE["cu"])
        sn = (sn_i[0] * charge).sum() / tap + rng.normal(0, MEAS_NOISE["sn"])
        light = charge[4] + charge[5]
        power = 390 * charge.sum() + 4.0 * light * 10 + rng.normal(0, 800)
        ok = cu <= specs.loc[steel, "cu_max_pct"] and sn <= specs.loc[steel, "sn_max_pct"]
        rows.append([f"H{k + 1:04d}", d, steel, *np.round(charge, 2), round(tap, 2),
                     round(cu, 4), round(sn, 5), int(round(power)), "PASS" if ok else "FAIL"])
    cols = (["heat_id", "date", "steel_grade"] + [f"charge_{g}_t" for g in GRADES]
            + ["tap_weight_t", "cu_pct", "sn_pct", "power_kwh", "pass_fail"])
    return pd.DataFrame(rows, columns=cols)


def make_notes():
    """검수 메모: 하루 1~2건 일반 메모 + 이상 로트 메모 + 헷갈리는 메모"""
    rows = []
    special = {(a[0], a[1]) for a in ANOMALIES} | {(d[0], d[1]) for d in DECOY_NOTES}
    for d in DATES:
        ds = d.isoformat()
        n = rng.choice([1, 1, 2])
        for g in rng.choice(GRADES, size=n, replace=False):
            if (ds, g) in special:
                continue
            rows.append((ds, g, lot_id(g, ds), rng.choice(NORMAL_NOTES)))
    for ds, g, _, _, text in ANOMALIES:
        rows.append((ds, g, lot_id(g, ds), text))
    for ds, g, text in DECOY_NOTES:
        rows.append((ds, g, lot_id(g, ds), text))
    df = pd.DataFrame(rows, columns=["date", "grade_id", "lot_id", "note_text"])
    return df.sort_values(["date", "grade_id"]).reset_index(drop=True)


def make_plan():
    """당일 생산 계획 24 heat (SD400 12, SD500 8, SD600 4)"""
    mix = ["SD400"] * 12 + ["SD500"] * 8 + ["SD600"] * 4
    order = rng.permutation(mix)
    rows = [(f"P{k + 1:02d}", s, float(rng.choice([98, 100, 100, 102])))
            for k, s in enumerate(order)]
    return pd.DataFrame(rows, columns=["heat_id", "steel_grade", "target_tap_weight_t"])


def main():
    DATA_DIR.mkdir(exist_ok=True)
    market = make_market()
    history = make_history(market)
    notes = make_notes()
    plan = make_plan()

    SCRAP.to_csv(DATA_DIR / "scrap_grades.csv", index=False, encoding="utf-8-sig")
    SPECS.to_csv(DATA_DIR / "steel_specs.csv", index=False, encoding="utf-8-sig")
    history.to_csv(DATA_DIR / "heat_history.csv", index=False, encoding="utf-8-sig")
    market.to_csv(DATA_DIR / "market_inventory.csv", index=False, encoding="utf-8-sig")
    notes.to_csv(DATA_DIR / "inspection_notes.csv", index=False, encoding="utf-8-sig")
    plan.to_csv(DATA_DIR / "production_plan.csv", index=False, encoding="utf-8-sig")

    history_end = history["date"].max()
    gt = {
        "_warning": "에이전트와 도구에는 노출하지 않는다. 생성기·평가 스크립트 전용.",
        "seed": RANDOM_SEED,
        "grades": {g: {"cu_mean": v[0], "cu_sd": v[1], "sn_mean": v[2], "sn_sd": v[3]}
                   for g, v in TRUE_DIST.items()},
        "measurement_noise_sd": MEAS_NOISE,
        "anomalous_lots": [{"date": a[0], "grade_id": a[1], "lot_id": lot_id(a[1], a[0]),
                            "element": a[2], "multiplier": a[3], "note_text": a[4]}
                           for a in ANOMALIES],
        "decoy_notes": [{"date": d[0], "grade_id": d[1], "note_text": d[2]} for d in DECOY_NOTES],
        "history_period": [history["date"].min(), history_end],
        "eval_dates": [d.isoformat() for d in DATES if d.isoformat() > history_end],
    }
    GROUND_TRUTH_PATH.write_text(json.dumps(gt, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"scrap_grades.csv      {len(SCRAP)}행")
    print(f"steel_specs.csv       {len(SPECS)}행")
    print(f"heat_history.csv      {len(history)}행  ({history['date'].min()} ~ {history_end}), "
          f"FAIL {int((history['pass_fail'] == 'FAIL').sum())}건")
    print(f"market_inventory.csv  {len(market)}행")
    print(f"inspection_notes.csv  {len(notes)}행")
    print(f"production_plan.csv   {len(plan)}행")
    print(f"ground_truth.json     평가용 날짜 {len(gt['eval_dates'])}일")


if __name__ == "__main__":
    main()
