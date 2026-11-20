"""
평가 스크립트  (실행: python src/evaluate.py)

baseline(숙련자 규칙), v1, v2, v3을 '같은 생산 계획'으로 평가 기간 39일 동안 돌리고
지표를 표·그래프·홈페이지용 데이터로 저장한다.

★ 이 파일은 ground_truth.json을 읽는다. 단, 에이전트가 배합을 '다 만든 뒤'
  그 배합을 채점할 때만 쓴다. 배합을 만드는 과정(pipeline, tools)에는 넘겨주지 않는다.

지표
  - 톤당 배합 원가 (원/톤 출강)
  - 규격 이탈률 (%): ground_truth 분포로 돌린 시뮬레이션에서 heat별 이탈 확률의 평균
  - 배합 설계 시간 (초): 코드 실행 시간. 사람이 손으로 짜는 시간은 측정하지 않았다.
  - 등급별 성분 추정 오차: 추정 평균과 ground_truth 평균의 차이
  - 검수 메모 판정 정확도: 이상 로트를 맞게 잡았는지, 정상 로트를 잘못 잡았는지
"""
import argparse
import json
import sys
import time

import numpy as np
import pandas as pd

from config import GRADES, GROUND_TRUTH_PATH, OUTPUT_DIR, TARGET_FAIL_PROB, WEB_DIR
from export_intranet import export_intranet
from llm import llm_available
from pipeline import expert_blend, run_version
from tools import estimate_composition, simulate_heat, write_charge_sheet
from tools.common import available_dates

VERSIONS = ["baseline", "v1", "v2", "v3"]
LABELS = {"baseline": "숙련자 규칙", "v1": "v1 공칭성분", "v2": "v2 추정+검증", "v3": "v3 +검수메모"}
# 시리즈 색: 참고 팔레트 1~4번 슬롯을 순서대로 고정 (모든 그래프에서 같은 버전 = 같은 색)
COLORS = {"baseline": "#2a78d6", "v1": "#eb6834", "v2": "#1baf7a", "v3": "#eda100"}


def load_ground_truth():
    gt = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
    comp = {"grades": {g: {"cu_mean": v["cu_mean"], "cu_sd": v["cu_sd"], "cu_se": 0.0,
                           "sn_mean": v["sn_mean"], "sn_sd": v["sn_sd"], "sn_se": 0.0}
                       for g, v in gt["grades"].items()},
            "meas_sd": gt["measurement_noise_sd"]}
    return gt, comp


def true_multiplier(gt, date):
    return {(a["grade_id"], a["element"]): a["multiplier"]
            for a in gt["anomalous_lots"] if a["date"] == date}


def score(r, gt, gt_comp, date):
    """만들어진 배합을 '숨은 정답' 분포로 채점"""
    sim = simulate_heat(r["ctx"], r["opt"]["x"], gt_comp, multiplier=true_multiplier(gt, date),
                        n=2000, seed=777, meas_sd=gt_comp["meas_sd"])
    p = np.array([s["p_fail"] for s in sim])
    return {"cost_per_t": r["opt"]["cost_per_t"], "fail_rate": float(p.mean()),
            "exp_fail_heats": float(p.sum()), "max_p_fail": float(p.max()),
            "heats_over_target": int((p > TARGET_FAIL_PROB).sum()),
            "iterations": r["iterations"], "seconds": r["seconds"]}


def note_accuracy(results_v3, gt):
    """검수 메모 판정을 정답 이상 로트와 비교"""
    bad = {a["lot_id"] for a in gt["anomalous_lots"]}
    tp = fp = fn = tn = 0
    rows = []
    for r in results_v3:
        for f in r["parsed"]["flags"]:
            flagged = f["risk"] != "none"
            truth = f["lot_id"] in bad
            tp += flagged and truth; fp += flagged and not truth
            fn += (not flagged) and truth; tn += (not flagged) and (not truth)
            if flagged or truth:
                rows.append({"date": r["ctx"]["date"], "lot_id": f["lot_id"],
                             "risk": f["risk"], "is_anomaly": truth, "reason": f["reason"]})
    return {"method": results_v3[0]["parsed"]["method"], "true_pos": tp, "false_pos": fp,
            "false_neg": fn, "true_neg": tn, "detail": rows}


def estimation_error(comp, gt):
    rows = []
    for g in GRADES:
        t, e = gt["grades"][g], comp["grades"][g]
        rows.append({"grade_id": g,
                     "true_cu": t["cu_mean"], "est_cu": e["cu_mean"], "nominal_cu": e["nominal_cu"],
                     "true_sn": t["sn_mean"], "est_sn": e["sn_mean"], "nominal_sn": e["nominal_sn"],
                     "est_cu_sd": e["cu_sd"], "true_cu_sd": t["cu_sd"]})
    df = pd.DataFrame(rows)
    return df, {
        "mae_cu_est": float((df.est_cu - df.true_cu).abs().mean()),
        "mae_cu_nominal": float((df.nominal_cu - df.true_cu).abs().mean()),
        "mae_sn_est": float((df.est_sn - df.true_sn).abs().mean()),
        "mae_sn_nominal": float((df.nominal_sn - df.true_sn).abs().mean()),
    }


# ----------------------------------------------------------------
# 그래프 (발표자료용 PNG)
# ----------------------------------------------------------------
def make_figures(summary, by_day, est_df, fig_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    for name in ["Malgun Gothic", "AppleGothic", "NanumGothic"]:
        if any(name == f.name for f in font_manager.fontManager.ttflist):
            plt.rcParams["font.family"] = name
            break
    plt.rcParams.update({"axes.unicode_minus": False, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.edgecolor": "#c3c2b7",
                         "axes.labelcolor": "#52514e", "xtick.color": "#52514e",
                         "ytick.color": "#52514e", "figure.facecolor": "#fcfcfb",
                         "axes.facecolor": "#fcfcfb", "axes.grid": True, "axes.grid.axis": "y",
                         "grid.color": "#e1e0d9", "grid.linewidth": 0.8, "axes.axisbelow": True})
    fig_dir.mkdir(parents=True, exist_ok=True)
    s = summary.set_index("version")
    xs = np.arange(len(VERSIONS))

    # 1) 톤당 배합 원가
    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    vals = [s.loc[v, "cost_per_t"] for v in VERSIONS]
    ax.bar(xs, vals, width=0.6, color=[COLORS[v] for v in VERSIONS])
    for x, v in zip(xs, vals):
        ax.text(x, v + 600, f"{v:,.0f}", ha="center", va="bottom", fontsize=9, color="#0b0b0b")
    ax.set_xticks(xs, [LABELS[v] for v in VERSIONS])
    ax.set_ylim(min(vals) - 15000, max(vals) + 6000)
    ax.set_ylabel("원/톤 출강")
    ax.set_title("톤당 배합 원가 (평가 기간 39일 평균)", loc="left", fontsize=11)
    fig.tight_layout(); fig.savefig(fig_dir / "cost_per_t.png", dpi=160); plt.close(fig)

    # 2) 규격 이탈률: 전체 날짜 vs 이상 로트가 있는 날
    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    w = 0.38
    allv = [s.loc[v, "fail_rate"] * 100 for v in VERSIONS]
    anov = [s.loc[v, "fail_rate_anomaly_days"] * 100 for v in VERSIONS]
    ax.bar(xs - w / 2 - 0.01, allv, width=w, color=[COLORS[v] for v in VERSIONS])
    ax.bar(xs + w / 2 + 0.01, anov, width=w, color=[COLORS[v] for v in VERSIONS],
           hatch="///", edgecolor="#fcfcfb", linewidth=0)
    for x, a, b in zip(xs, allv, anov):
        ax.text(x - w / 2, a + 0.4, f"{a:.1f}", ha="center", fontsize=8.5)
        ax.text(x + w / 2, b + 0.4, f"{b:.1f}", ha="center", fontsize=8.5)
    ax.axhline(TARGET_FAIL_PROB * 100, color="#52514e", lw=1, ls="--")
    ax.text(-0.45, TARGET_FAIL_PROB * 100 + 0.6, "목표 2%", ha="left",
            fontsize=8.5, color="#52514e")
    ax.set_xticks(xs, [LABELS[v] for v in VERSIONS])
    ax.set_ylabel("heat당 이탈 확률 (%)")
    ax.set_title("규격 이탈률 (민무늬: 전체 39일 / 빗금: 이상 로트가 있는 6일)", loc="left", fontsize=11)
    fig.tight_layout(); fig.savefig(fig_dir / "fail_rate.png", dpi=160); plt.close(fig)

    # 3) 성분 추정: 공칭값 vs 추정값 vs 정답 (Cu)
    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    gx = np.arange(len(GRADES))
    ax.scatter(gx - 0.15, est_df.nominal_cu, s=36, color="#898781", label="공칭값", zorder=3)
    ax.scatter(gx + 0.15, est_df.est_cu, s=36, color=COLORS["v2"], label="이력 기반 추정", zorder=3)
    ax.scatter(gx, est_df.true_cu, s=90, marker="_", color="#0b0b0b", linewidths=2,
               label="숨은 정답", zorder=4)
    ax.set_xticks(gx, GRADES)
    ax.set_ylabel("Cu (%)")
    ax.legend(frameon=False, fontsize=8.5, loc="upper left")
    ax.set_title("등급별 Cu 함량: 공칭값·추정값·숨은 정답", loc="left", fontsize=11)
    fig.tight_layout(); fig.savefig(fig_dir / "composition_estimate.png", dpi=160); plt.close(fig)

    # 4) 날짜별 이탈률 추이 (v1 제외: 축 범위가 너무 달라서 따로 표에만 표시)
    fig, ax = plt.subplots(figsize=(8, 3.4))
    for v in ["baseline", "v2", "v3"]:
        d = by_day[by_day.version == v]
        ax.plot(pd.to_datetime(d.date), d.fail_rate * 100, color=COLORS[v], lw=2, label=LABELS[v])
    for a in by_day[by_day.anomaly_day].date.unique():
        ax.axvline(pd.to_datetime(a), color="#e1e0d9", lw=6, zorder=0)
    ax.axhline(TARGET_FAIL_PROB * 100, color="#52514e", lw=1, ls="--")
    ax.set_ylabel("heat당 이탈 확률 (%)")
    ax.legend(frameon=False, fontsize=8.5, ncol=3, loc="upper left")
    ax.set_title("날짜별 규격 이탈률 (회색 띠: 이상 로트가 있는 날)", loc="left", fontsize=11)
    fig.autofmt_xdate()
    fig.tight_layout(); fig.savefig(fig_dir / "fail_rate_by_day.png", dpi=160); plt.close(fig)


# ----------------------------------------------------------------
# 홈페이지용 데이터
# ----------------------------------------------------------------
def export_web(payload):
    out = WEB_DIR / "data"
    out.mkdir(parents=True, exist_ok=True)
    js = "window.REBORN_DATA = " + json.dumps(payload, ensure_ascii=False, default=float) + ";\n"
    (out / "results.js").write_text(js, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="LLM 없이 규칙 기반으로만 평가")
    args = ap.parse_args()
    use_llm = llm_available() and not args.no_llm
    print(f"LLM 사용: {use_llm}")

    gt, gt_comp = load_ground_truth()
    anomaly_dates = {a["date"] for a in gt["anomalous_lots"]}
    decoy_dates = {d["date"] for d in gt["decoy_notes"]}
    dates = available_dates()

    t0 = time.perf_counter()
    comp = estimate_composition()
    est_seconds = time.perf_counter() - t0

    rows, v3_results, sheets = [], [], {}
    for date in dates:
        base = None
        for v in VERSIONS:
            r = run_version(date, v, use_llm=use_llm, comp=comp if v != "v1" else None)
            sc = score(r, gt, gt_comp, date)
            rows.append({"date": date, "version": v, **sc,
                         "anomaly_day": date in anomaly_dates, "decoy_day": date in decoy_dates})
            if v == "baseline":
                base = r["opt"]
            if v == "v3":
                v3_results.append(r)
                # 홈페이지 데모용 배합 지시서
                sheet = write_charge_sheet(r["ctx"], r["opt"], r["sim"], base, r["parsed"],
                                           r["margins"], r["iterations"], use_llm=use_llm)
                sheet["log"] = r["log"]
                sheet["notes"] = r["parsed"]["notes"]
                sheet["flags"] = r["parsed"]["flags"]
                sheet["gt_fail_rate_pct"] = round(sc["fail_rate"] * 100, 2)
                sheets[date] = sheet
        print(f"{date} 완료", flush=True)

    by_day = pd.DataFrame(rows)
    agg = []
    for v in VERSIONS:
        d = by_day[by_day.version == v]
        agg.append({
            "version": v, "label": LABELS[v],
            "cost_per_t": d.cost_per_t.mean(),
            "fail_rate": d.fail_rate.mean(),
            "fail_rate_anomaly_days": d[d.anomaly_day].fail_rate.mean(),
            "fail_rate_normal_days": d[~d.anomaly_day].fail_rate.mean(),
            "fail_rate_decoy_days": d[d.decoy_day].fail_rate.mean(),
            "exp_fail_heats_per_day": d.exp_fail_heats.mean(),
            "heats_over_target_per_day": d.heats_over_target.mean(),
            "iterations": d.iterations.mean(),
            "seconds_per_day": d.seconds.mean(),
        })
    summary = pd.DataFrame(agg)
    b = summary.set_index("version").loc["baseline", "cost_per_t"]
    summary["saving_per_t_vs_baseline"] = b - summary["cost_per_t"]
    annual_t = 800_000      # 연 생산 80만 톤 (가상 설정)
    summary["annual_saving_krw_100m"] = summary["saving_per_t_vs_baseline"] * annual_t / 1e8

    est_df, est_err = estimation_error(comp, gt)
    notes_acc = note_accuracy(v3_results, gt)

    OUTPUT_DIR.mkdir(exist_ok=True)
    by_day.to_csv(OUTPUT_DIR / "eval_by_day.csv", index=False, encoding="utf-8-sig")
    summary.to_csv(OUTPUT_DIR / "eval_summary.csv", index=False, encoding="utf-8-sig")
    est_df.to_csv(OUTPUT_DIR / "composition_estimate.csv", index=False, encoding="utf-8-sig")
    meta = {"use_llm": use_llm, "n_days": len(dates), "eval_period": [dates[0], dates[-1]],
            "anomaly_dates": sorted(anomaly_dates & set(dates)),
            "decoy_dates": sorted(decoy_dates & set(dates)),
            "estimation_error": est_err, "estimate_seconds": est_seconds,
            "note_accuracy": {k: v for k, v in notes_acc.items() if k != "detail"},
            "target_fail_prob": TARGET_FAIL_PROB}
    (OUTPUT_DIR / "eval_meta.json").write_text(
        json.dumps(meta | {"note_detail": notes_acc["detail"]}, ensure_ascii=False, indent=2,
                   default=float), encoding="utf-8")
    make_figures(summary, by_day, est_df, OUTPUT_DIR / "figures")

    export_web({
        "meta": meta,
        "summary": summary.to_dict(orient="records"),
        "by_day": by_day.to_dict(orient="records"),
        "estimate": est_df.to_dict(orient="records"),
        "note_detail": notes_acc["detail"],
        "sheets": sheets,
    })
    export_intranet()          # 사내 홈페이지용 회사 데이터 (CSV만 사용)

    pd.set_option("display.width", 200)
    print("\n=== 평가 요약 (평가 기간", dates[0], "~", dates[-1], ") ===")
    show = summary[["label", "cost_per_t", "saving_per_t_vs_baseline", "fail_rate",
                    "fail_rate_anomaly_days", "fail_rate_decoy_days", "heats_over_target_per_day",
                    "iterations", "seconds_per_day"]].copy()
    for c in ["fail_rate", "fail_rate_anomaly_days", "fail_rate_decoy_days"]:
        show[c] = (show[c] * 100).round(2)
    print(show.round(2).to_string(index=False))
    print("\n성분 추정 오차(MAE, Cu %p): 공칭값", round(est_err["mae_cu_nominal"], 4),
          "→ 추정값", round(est_err["mae_cu_est"], 4))
    print("검수 메모 판정:", meta["note_accuracy"])
    print(f"\n저장: {OUTPUT_DIR}  /  홈페이지 데이터: {WEB_DIR / 'data' / 'results.js'}")


if __name__ == "__main__":
    sys.exit(main())
