"""
도구 4. optimize_blend — 원가 최소 배합 계산 (선형계획법, scipy의 HiGHS 솔버)

하루 생산 계획의 모든 heat를 '한 번에' 푼다. 재고는 하루 전체가 나눠 쓰기 때문이다.

  결정 변수  x[h, i] : heat h에 넣는 등급 i의 장입량 (톤)
  최소화     Σ p_i · x[h, i]                         (배합 원가)
  제약
    (출강량)  Σ_i y_i · x[h, i]  =  W_h
    (성분)    Σ_i c_i · x[h, i] <= (상한 - 안전여유) · W_h     ... Cu, Sn 각각
    (용적)    Σ_i x[h, i] / d_i <= 버킷 용적 × 장입 횟수
    (재고)    Σ_h x[h, i] <= 재고_i
    (검수메모) 위험 로트 등급은 x = 0 (제외) 또는 장입 비율 상한
"""
import numpy as np
import pandas as pd
from scipy.optimize import linprog

from config import GRADES, MAX_CHARGE_VOLUME_M3


def _mean_vec(comp, elem, multiplier, se_k=0.0):
    """
    최적화에 쓸 등급별 평균 성분.
    se_k > 0 이면 '평균 + se_k × 표준오차'를 쓴다 (추정이 틀렸을 경우를 대비한 보수적 평균).
    """
    mu = np.array([comp["grades"][g][f"{elem}_mean"] + se_k * comp["grades"][g].get(f"{elem}_se", 0.0)
                   for g in GRADES])
    for (g, e), m in (multiplier or {}).items():
        if e == elem:
            mu[GRADES.index(g)] *= m
    return mu


def optimize_blend(ctx, comp, margins, note_constraints=None, se_k=0.0):
    """
    ctx     : load_context 결과
    comp    : estimate_composition 결과 (평균 성분을 씀)
    margins : 강종별 안전여유 {"SD400": {"cu": 0.03, "sn": 0.003}, ...}  (단위: %)
    note_constraints : parse_inspection_notes.to_constraints 결과 (없으면 None)
    se_k    : 보수적 평균 계수 (0이면 추정 평균 그대로)

    반환: {"status", "message", "blend": DataFrame, "total_cost_krw", "cost_per_t"}
    """
    nc = note_constraints or {"exclude": [], "cap_pct": {}, "multiplier": {}}
    plan, scrap, specs = ctx["plan"], ctx["scrap"], ctx["specs"]
    H, G = len(plan), len(GRADES)
    p = scrap["price_krw_per_t"].values.astype(float)
    y = scrap["yield"].values
    d = scrap["bulk_density_t_per_m3"].values
    inv = scrap["inventory_t"].values.astype(float)
    mu_cu = _mean_vec(comp, "cu", nc["multiplier"], se_k)
    mu_sn = _mean_vec(comp, "sn", nc["multiplier"], se_k)

    idx = lambda h, i: h * G + i      # noqa: E731  (2차원 변수를 1줄로 펼친 위치)
    n = H * G
    c = np.tile(p, H)

    A_eq = np.zeros((H, n)); b_eq = np.zeros(H)
    A_ub, b_ub = [], []
    for h, row in plan.reset_index(drop=True).iterrows():
        W = row["target_tap_weight_t"]
        lim = specs.loc[row["steel_grade"]]
        m = margins[row["steel_grade"]]
        A_eq[h, h * G:(h + 1) * G] = y; b_eq[h] = W
        r = np.zeros(n); r[h * G:(h + 1) * G] = mu_cu
        A_ub.append(r); b_ub.append((lim["cu_max_pct"] - m["cu"]) * W)
        r = np.zeros(n); r[h * G:(h + 1) * G] = mu_sn
        A_ub.append(r); b_ub.append((lim["sn_max_pct"] - m["sn"]) * W)
        r = np.zeros(n); r[h * G:(h + 1) * G] = 1 / d
        A_ub.append(r); b_ub.append(MAX_CHARGE_VOLUME_M3)
        for g, cap in nc["cap_pct"].items():           # x_hi <= cap × (heat 총장입량)
            r = np.zeros(n); r[h * G:(h + 1) * G] = -cap; r[idx(h, GRADES.index(g))] += 1
            A_ub.append(r); b_ub.append(0.0)
    for i in range(G):                                  # 하루 재고
        r = np.zeros(n); r[i::G] = 1
        A_ub.append(r); b_ub.append(inv[i])

    bounds = [(0, 0) if GRADES[i] in nc["exclude"] else (0, None)
              for _ in range(H) for i in range(G)]
    res = linprog(c, A_ub=np.array(A_ub), b_ub=np.array(b_ub), A_eq=A_eq, b_eq=b_eq,
                  bounds=bounds, method="highs")
    if res.status != 0:
        return {"status": "infeasible", "message": f"해를 찾지 못함: {res.message}",
                "blend": None}

    x = res.x.reshape(H, G)
    x[x < 1e-6] = 0
    # 지시서의 '예상 성분'은 보수적 평균이 아니라 추정 평균 그대로 보여준다
    return {"status": "ok", "message": "최적해",
            **summarize_blend(ctx, x, _mean_vec(comp, "cu", nc["multiplier"]),
                              _mean_vec(comp, "sn", nc["multiplier"]))}


def summarize_blend(ctx, x, mu_cu, mu_sn):
    """배합 행렬 x(H×8)를 표로 정리 (최적화 결과와 숙련자 배합 모두 이 함수로 정리)"""
    plan, scrap, specs = ctx["plan"], ctx["scrap"], ctx["specs"]
    p = scrap["price_krw_per_t"].values
    y = scrap["yield"].values
    d = scrap["bulk_density_t_per_m3"].values
    df = pd.DataFrame(x, columns=GRADES)
    df.insert(0, "heat_id", plan["heat_id"].values)
    df.insert(1, "steel_grade", plan["steel_grade"].values)
    df["target_tap_t"] = plan["target_tap_weight_t"].values
    df["charge_t"] = x.sum(axis=1)
    df["tap_t"] = x @ y
    df["volume_m3"] = x @ (1 / d)
    df["pred_cu_pct"] = (x @ mu_cu) / df["tap_t"]
    df["pred_sn_pct"] = (x @ mu_sn) / df["tap_t"]
    df["cu_max_pct"] = specs.loc[df["steel_grade"], "cu_max_pct"].values
    df["sn_max_pct"] = specs.loc[df["steel_grade"], "sn_max_pct"].values
    df["cost_krw"] = x @ p
    df["cost_per_t"] = df["cost_krw"] / df["tap_t"]
    total = float(df["cost_krw"].sum())
    return {"blend": df, "x": x, "total_cost_krw": total,
            "cost_per_t": total / float(df["tap_t"].sum())}


def summarize_for_llm(result):
    """LLM에게 보여줄 요약: 강종별 평균 배합 비율과 원가"""
    if result["status"] != "ok":
        return {"status": result["status"], "message": result["message"]}
    b = result["blend"]
    groups = {}
    for s, g in b.groupby("steel_grade"):
        share = (g[GRADES].sum() / g["charge_t"].sum() * 100).round(1)
        groups[s] = {
            "heats": int(len(g)),
            "avg_share_pct": {k: float(v) for k, v in share.items() if v > 0},
            "pred_cu_pct": round(float(g["pred_cu_pct"].mean()), 4),
            "pred_sn_pct": round(float(g["pred_sn_pct"].mean()), 5),
            "cu_max_pct": float(g["cu_max_pct"].iloc[0]),
            "sn_max_pct": float(g["sn_max_pct"].iloc[0]),
            "max_volume_m3": round(float(g["volume_m3"].max()), 1),
        }
    return {"status": "ok", "cost_per_t_krw": round(result["cost_per_t"]),
            "total_cost_krw": round(result["total_cost_krw"]), "by_steel": groups}
