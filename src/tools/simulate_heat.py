"""
도구 5. simulate_heat — 몬테카를로 모의 조업 1,000회로 heat별 규격 이탈 확률 계산

한 번의 모의 조업에서
  1) 등급별 성분을 '추정 평균 ± 추정 편차' 분포에서 뽑는다.
     (평균 추정치 자체의 오차(표준오차)도 같이 흔든다)
  2) 실수율 변동과 분석 측정 노이즈를 더한다.
  3) 용강 Cu% = Σ c_i x_i / 출강량  →  상한을 넘으면 '이탈'
1,000번 중 이탈한 비율이 이탈 확률이다.

평가 스크립트도 이 함수를 쓰되, 분포만 ground_truth로 바꿔서 넣는다.
"""
import numpy as np
from scipy.stats import norm

from config import GRADES, N_SIM, TARGET_FAIL_PROB


def _params(comp, elem, multiplier):
    mu = np.array([comp["grades"][g][f"{elem}_mean"] for g in GRADES])
    sd = np.array([comp["grades"][g][f"{elem}_sd"] for g in GRADES])
    se = np.array([comp["grades"][g].get(f"{elem}_se", 0.0) for g in GRADES])
    for (g, e), m in (multiplier or {}).items():
        if e == elem:
            j = GRADES.index(g)
            mu[j] *= m; sd[j] *= m; se[j] *= m
    return mu, sd, se


def simulate_heat(ctx, x, comp, multiplier=None, n=N_SIM, seed=0, meas_sd=None):
    """
    x          : 배합 행렬 (heat 수 × 8)
    comp       : 성분 분포 (estimate_composition 결과 또는 ground_truth를 같은 형식으로 바꾼 것)
    multiplier : 로트 이상치 배수 {(grade, element): 배수}
    반환: heat별 결과 리스트 [{heat_id, steel_grade, p_fail, p_fail_cu, p_fail_sn,
                               cu_mean, cu_p95, cu_sd, sn_mean, sn_p95, sn_sd}]
    """
    rng = np.random.default_rng(seed)
    plan, scrap, specs = ctx["plan"], ctx["scrap"], ctx["specs"]
    y = scrap["yield"].values
    meas = meas_sd or comp.get("meas_sd", {"cu": 0.0, "sn": 0.0})
    out = []
    for h, row in plan.reset_index(drop=True).iterrows():
        xh = x[h]
        tap = (y @ xh) * rng.normal(1, 0.006, n)
        vals = {}
        for e in ("cu", "sn"):
            mu, sd, se = _params(comp, e, multiplier)
            mu_draw = mu + rng.normal(0, 1, (n, len(GRADES))) * se          # 추정 오차
            c = np.maximum(mu_draw + rng.normal(0, 1, (n, len(GRADES))) * sd, 0.3 * mu)
            vals[e] = (c @ xh) / tap + rng.normal(0, meas[e], n)
        lim = specs.loc[row["steel_grade"]]
        f_cu = vals["cu"] > lim["cu_max_pct"]
        f_sn = vals["sn"] > lim["sn_max_pct"]
        out.append({
            "heat_id": row["heat_id"], "steel_grade": row["steel_grade"],
            "p_fail": float((f_cu | f_sn).mean()),
            "p_fail_cu": float(f_cu.mean()), "p_fail_sn": float(f_sn.mean()),
            "cu_mean": float(vals["cu"].mean()), "cu_p95": float(np.percentile(vals["cu"], 95)),
            "cu_sd": float(vals["cu"].std()),
            "sn_mean": float(vals["sn"].mean()), "sn_p95": float(np.percentile(vals["sn"], 95)),
            "sn_sd": float(vals["sn"].std()),
        })
    return out


def suggest_margins(sim, specs, margins, target=TARGET_FAIL_PROB):
    """
    시뮬레이션 결과를 보고 강종별 안전여유를 얼마로 키우면 좋을지 제안한다.
      필요한 여유 ≈ z × (heat 성분의 표준편차)    (z: 목표 이탈확률에 해당하는 정규분포 값)
    목표를 넘긴 강종만 키우고, 통과한 강종은 그대로 둔다.
    """
    z = norm.ppf(1 - target)              # 목표 이탈확률(2%)에 해당하는 z ≈ 2.05
    new = {s: dict(m) for s, m in margins.items()}
    status = {}
    for s in margins:
        rows = [r for r in sim if r["steel_grade"] == s]
        if not rows:
            continue
        worst = max(r["p_fail"] for r in rows)
        status[s] = {"max_p_fail": worst, "pass": worst <= target}
        if worst <= target:
            continue
        lim = specs.loc[s]
        for e in ("cu", "sn"):
            limit = lim[f"{e}_max_pct"]
            # 상한까지 남은 거리가 z×σ보다 부족한 만큼을 더한다
            short = max(z * r[f"{e}_sd"] - (limit - r[f"{e}_mean"]) for r in rows)
            if max(r[f"p_fail_{e}"] for r in rows) > target / 4:
                # 부족분 + 작은 추가 여유(3%)  → 한 번에 너무 크게 올리지 않도록
                new[s][e] = round(float(margins[s][e] + max(short, 0) + 0.03 * margins[s][e] + 1e-4), 5)
    return new, status


def summarize_sim(sim, target=TARGET_FAIL_PROB):
    """LLM용 요약: 강종별 최악 heat의 이탈 확률"""
    by = {}
    for r in sim:
        s = by.setdefault(r["steel_grade"], {"max_p_fail": 0, "worst_heat": None,
                                             "max_p_fail_cu": 0, "max_p_fail_sn": 0})
        if r["p_fail"] >= s["max_p_fail"]:
            s["max_p_fail"], s["worst_heat"] = r["p_fail"], r["heat_id"]
        s["max_p_fail_cu"] = max(s["max_p_fail_cu"], r["p_fail_cu"])
        s["max_p_fail_sn"] = max(s["max_p_fail_sn"], r["p_fail_sn"])
    return {"target_p_fail": target,
            "all_pass": all(v["max_p_fail"] <= target for v in by.values()),
            "mean_p_fail": round(float(np.mean([r["p_fail"] for r in sim])), 4),
            "by_steel": by}
