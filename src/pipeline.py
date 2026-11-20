"""
배합 설계 파이프라인 (LLM 오케스트레이터 없이 '정해진 순서'로 도구를 부르는 버전)

  baseline : 숙련자 규칙 배합표 (비교 기준)
  v1       : 공칭 성분으로 원가 최소화 (안전여유 0, 검증 없음)
  v2       : 이력 기반 성분 추정 + 안전여유 + 시뮬레이션 검증 루프
  v3       : v2 + 검수 메모 반영

평가 스크립트(evaluate.py)는 이 파일로 모든 버전을 같은 조건에서 돌린다.
LLM 에이전트(agent.py)는 같은 도구를 쓰지만, 순서와 안전여유를 LLM이 스스로 정한다.
"""
import time

import numpy as np
from scipy.stats import norm

from config import EXPERT_RECIPE, GRADES, MAX_ITERATIONS, SE_K, TARGET_FAIL_PROB
from tools import (estimate_composition, load_context, nominal_composition,
                   optimize_blend, parse_inspection_notes, simulate_heat,
                   suggest_margins, summarize_blend, to_constraints,
                   write_charge_sheet)
from tools.optimize_blend import _mean_vec

SUBSTITUTES = ["HS_B", "HS_A", "HMS_A"]      # 재고가 모자랄 때 숙련자가 대신 쓰는 고급 등급


def expert_blend(ctx, comp):
    """숙련자 규칙 배합: 배합표 비율대로 넣고, 재고가 모자라면 고급 스크랩으로 대체"""
    plan, scrap = ctx["plan"], ctx["scrap"]
    y = scrap["yield"].values
    inv = scrap["inventory_t"].values.astype(float)
    x = np.zeros((len(plan), len(GRADES)))
    for h, row in plan.reset_index(drop=True).iterrows():
        r = np.array(EXPERT_RECIPE[row["steel_grade"]], float) / 100
        x[h] = r * row["target_tap_weight_t"] / (r @ y)
    for i, g in enumerate(GRADES):
        need = x[:, i].sum()
        if need <= inv[i]:
            continue
        removed = x[:, i] * (1 - inv[i] / need)          # 모자란 만큼 빼고
        x[:, i] -= removed
        for s in SUBSTITUTES:                              # 출강량이 같도록 대체 등급으로 채움
            j = GRADES.index(s)
            room = inv[j] - x[:, j].sum()
            if s == g or room <= 0:
                continue
            add = removed * y[i] / y[j]
            k = min(1.0, room / add.sum())
            x[:, j] += add * k
            removed = removed * (1 - k)
            if removed.sum() < 1e-6:
                break
    return summarize_blend(ctx, x, _mean_vec(comp, "cu", None), _mean_vec(comp, "sn", None))


def initial_margins(ctx, comp, target=TARGET_FAIL_PROB):
    """
    첫 안전여유 = z × (숙련자 배합 기준으로 계산한 heat 성분 표준편차)
    → '추정된 편차에 비례'하는 여유. 이후 시뮬레이션 결과로 조정한다.
    """
    z = norm.ppf(1 - target / 2)
    eb = expert_blend(ctx, comp)
    y = ctx["scrap"]["yield"].values
    out = {}
    for s in ctx["specs"].index:
        rows = [h for h, st in enumerate(ctx["plan"]["steel_grade"]) if st == s]
        m = {}
        for e in ("cu", "sn"):
            sd = np.array([comp["grades"][g][f"{e}_sd"] for g in GRADES])
            se = np.array([comp["grades"][g][f"{e}_se"] for g in GRADES])
            sig = [np.sqrt(((eb["x"][h] * sd) ** 2).sum() + ((eb["x"][h] * se) ** 2).sum())
                   / (eb["x"][h] @ y) for h in rows]
            sig = np.sqrt(max(sig) ** 2 + comp["meas_sd"][e] ** 2) if sig else 0.0
            m[e] = round(float(z * sig), 5)
        out[s] = m
    return out


def run_version(date, version, use_llm=None, comp=None, verbose=False, se_k=SE_K):
    """
    한 날짜의 하루 계획(24 heat)에 대해 지정한 버전으로 배합을 만든다.
    반환: {"version", "ctx", "opt", "sim", "margins", "iterations", "log", "parsed", "seconds"}
    """
    t0 = time.perf_counter()
    ctx = load_context(date)                                    # 도구 1
    log = []
    parsed, nc = None, None
    if version == "v3":
        parsed = parse_inspection_notes(date, use_llm=use_llm)   # 도구 2
        nc = to_constraints(parsed)
        log.append(f"검수 메모 {len(parsed['notes'])}건 분석({parsed['method']}) → 제외 {nc['exclude']}, "
                   f"제한 {list(nc['cap_pct'])}")

    if version == "baseline":
        comp = comp or estimate_composition()
        opt = expert_blend(ctx, comp) | {"status": "ok"}
        return {"version": version, "ctx": ctx, "opt": opt, "sim": None, "margins": None,
                "iterations": 0, "log": ["숙련자 배합표 적용"], "parsed": None,
                "seconds": time.perf_counter() - t0}

    if version == "v1":
        comp = nominal_composition()
        margins = {s: {"cu": 0.0, "sn": 0.0} for s in ctx["specs"].index}
        opt = optimize_blend(ctx, comp, margins)                 # 도구 4
        return {"version": version, "ctx": ctx, "opt": opt, "sim": None, "margins": margins,
                "iterations": 1, "log": ["공칭 성분, 안전여유 0으로 최적화 1회"], "parsed": None,
                "seconds": time.perf_counter() - t0}

    # v2, v3
    comp = comp or estimate_composition()                       # 도구 3
    margins = initial_margins(ctx, comp)
    mult = nc["multiplier"] if nc else None
    sim, opt = None, None
    for it in range(1, MAX_ITERATIONS + 1):
        opt = optimize_blend(ctx, comp, margins, nc, se_k=se_k)  # 도구 4
        if opt["status"] != "ok":
            log.append(f"반복 {it}: 최적화 실패({opt['message']}) → 안전여유를 줄여 재시도")
            margins = {s: {e: v * 0.8 for e, v in m.items()} for s, m in margins.items()}
            continue
        sim = simulate_heat(ctx, opt["x"], comp, multiplier=mult, seed=it)   # 도구 5
        margins_next, status = suggest_margins(sim, ctx["specs"], margins)
        worst = {s: round(v["max_p_fail"] * 100, 1) for s, v in status.items()}
        log.append(f"반복 {it}: 원가 {opt['cost_per_t']:,.0f}원/t, 강종별 최대 이탈확률(%) {worst}")
        if all(v["pass"] for v in status.values()):
            break
        margins = margins_next
    if verbose:
        print("\n".join(log))
    return {"version": version, "ctx": ctx, "opt": opt, "sim": sim, "margins": margins,
            "iterations": it, "log": log, "parsed": parsed, "comp": comp,
            "seconds": time.perf_counter() - t0}


def run_full(date, use_llm=None):
    """v3 + 지시서 작성까지 (홈페이지 데모와 agent.py의 키 없는 모드에서 사용)"""
    comp = estimate_composition()
    r = run_version(date, "v3", use_llm=use_llm, comp=comp)
    base = expert_blend(r["ctx"], comp)
    sheet = write_charge_sheet(r["ctx"], r["opt"], r["sim"], base, r["parsed"], r["margins"],
                               r["iterations"], use_llm=use_llm)       # 도구 6
    sheet["log"] = r["log"]
    return sheet
