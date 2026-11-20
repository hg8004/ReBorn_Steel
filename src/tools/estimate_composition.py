"""
도구 3. estimate_composition — 과거 조업 이력으로 등급별 '실제' Cu·Sn의 평균과 편차 추정
         (회귀 분석)

원리
  heat마다  (용강 Cu%) × (출강량) = Σ (등급 i의 Cu%) × (등급 i 장입량)  이 성립한다.
  등급별 Cu%(c_i)를 미지수로 두면 500개 heat에 대한 연립방정식이 되고,
  이를 최소제곱법으로 푼다. (음수가 나오지 않도록 비음수 최소제곱 NNLS 사용)

  1) 평균: NNLS로 c_i 추정
  2) 이상치 제거: 잔차가 너무 큰 heat(이상 로트가 섞였을 가능성)를 빼고 다시 추정
  3) 편차: 잔차의 크기로부터 추정.
     등급 성분의 변동계수(CV = 표준편차/평균)가 등급끼리 비슷하다고 가정하면
       잔차 분산 ≈ CV² × Σ(c_i x_i)² + (측정노이즈)² × 출강량²
     이 식을 잔차² 에 맞춰 CV와 측정노이즈를 구한다.  → 등급별 표준편차 = CV × 평균
"""
import numpy as np
from scipy.optimize import nnls

from config import GRADES
from tools.common import heat_history, scrap_table


def _fit_element(X, tap, meas, trim_sigma=3.5, rounds=4):
    b = meas * tap
    keep = np.ones(len(b), bool)
    for _ in range(rounds):
        mu, _ = nnls(X[keep], b[keep])
        r = b - X @ mu
        # 중앙값 기반의 강건한 표준편차 (이상치에 덜 흔들림)
        s = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
        new_keep = np.abs(r) <= trim_sigma * s
        if (new_keep == keep).all():
            break
        keep = new_keep
    mu, _ = nnls(X[keep], b[keep])
    r = (b - X @ mu)[keep]

    # 편차 추정: 잔차² = CV² × Σ(c_i x_i)² + σm² × tap²
    A = np.column_stack([((X[keep] * mu) ** 2).sum(axis=1), tap[keep] ** 2])
    coef, _ = nnls(A, r ** 2)
    cv = float(np.sqrt(coef[0]))
    sigma_meas = float(np.sqrt(coef[1]))

    # 평균 추정치 자체의 불확실성(표준오차)
    s2 = (r ** 2).sum() / max(keep.sum() - X.shape[1], 1)
    cov = s2 * np.linalg.pinv(X[keep].T @ X[keep])
    se = np.sqrt(np.clip(np.diag(cov), 0, None))
    return mu, cv, sigma_meas, se, ~keep


def estimate_composition(history=None):
    """
    반환: {
      "grades": {grade_id: {cu_mean, cu_sd, cu_se, sn_mean, sn_sd, sn_se,
                            nominal_cu, nominal_sn}},
      "cv": {"cu":..., "sn":...}, "meas_sd": {...},
      "n_heats": 사용한 heat 수, "outlier_heats": 이상치로 뺀 heat 목록
    }
    """
    h = heat_history() if history is None else history
    X = h[[f"charge_{g}_t" for g in GRADES]].values
    tap = h["tap_weight_t"].values
    scrap = scrap_table()

    cu = _fit_element(X, tap, h["cu_pct"].values)
    sn = _fit_element(X, tap, h["sn_pct"].values)

    out = {}
    for j, g in enumerate(GRADES):
        out[g] = {
            "cu_mean": float(cu[0][j]), "cu_sd": float(cu[1] * cu[0][j]), "cu_se": float(cu[3][j]),
            "sn_mean": float(sn[0][j]), "sn_sd": float(sn[1] * sn[0][j]), "sn_se": float(sn[3][j]),
            "nominal_cu": float(scrap.loc[g, "nominal_cu_pct"]),
            "nominal_sn": float(scrap.loc[g, "nominal_sn_pct"]),
        }
    outlier = h.loc[cu[4] | sn[4], ["heat_id", "date"]]
    return {
        "method": "history",
        "grades": out,
        "cv": {"cu": cu[1], "sn": sn[1]},
        "meas_sd": {"cu": cu[2], "sn": sn[2]},
        "n_heats": int(len(h)),
        "outlier_heats": outlier["heat_id"].tolist(),
        "outlier_dates": sorted(outlier["date"].unique().tolist()),
    }


def nominal_composition(cv=0.0):
    """v1용: 카탈로그 공칭값을 그대로 쓰는 '추정' (편차 정보 없음)"""
    scrap = scrap_table()
    out = {}
    for g in GRADES:
        c, s = float(scrap.loc[g, "nominal_cu_pct"]), float(scrap.loc[g, "nominal_sn_pct"])
        out[g] = {"cu_mean": c, "cu_sd": cv * c, "cu_se": 0.0,
                  "sn_mean": s, "sn_sd": cv * s, "sn_se": 0.0,
                  "nominal_cu": c, "nominal_sn": s}
    return {"method": "nominal", "grades": out, "cv": {"cu": cv, "sn": cv},
            "meas_sd": {"cu": 0.0, "sn": 0.0}, "n_heats": 0,
            "outlier_heats": [], "outlier_dates": []}
