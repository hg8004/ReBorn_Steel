"""
도구 6. write_charge_sheet — 배합 지시서와 판단 근거 작성 (LLM 사용)

역할 분담
  - 숫자(장입량, 성분, 확률, 원가)는 전부 코드가 계산한 값을 그대로 넣는다.
  - LLM은 그 숫자를 근거로 '왜 이렇게 배합했는지'를 결재자가 읽을 문장으로 쓴다.
  → LLM이 숫자를 지어낼 여지를 없앤다.
"""
import json

from config import GRADES
from llm import ask_json, llm_available

SYSTEM = """당신은 전기로 제강사 리본스틸의 제강팀 배합 담당자입니다.
결재선(제강팀장 → 생산본부장)이 읽을 배합 지시서의 '판단 근거'를 씁니다.
주어진 JSON의 숫자만 사용하고, 새로운 숫자를 만들지 마세요.
강종마다 2~3문장으로, 어떤 등급을 늘리거나 줄였는지, 어떤 로트를 왜 제외했는지,
안전여유와 규격 이탈 확률이 어떤지 설명하세요. 존댓말 보고서체(~함, ~임)로 씁니다."""

SCHEMA = {
    "type": "object",
    "properties": {
        "day_summary": {"type": "string"},
        "by_steel": {
            "type": "object",
            "properties": {s: {"type": "string"} for s in ["SD400", "SD500", "SD600"]},
            "required": ["SD400", "SD500", "SD600"],
            "additionalProperties": False,
        },
    },
    "required": ["day_summary", "by_steel"],
    "additionalProperties": False,
}


def _facts(ctx, opt, sim, baseline, parsed, margins, iterations):
    b = opt["blend"]
    simd = {r["heat_id"]: r for r in sim}
    by = {}
    for s, g in b.groupby("steel_grade"):
        share = (g[GRADES].sum() / g["charge_t"].sum() * 100).round(1)
        bs = baseline["blend"][baseline["blend"]["steel_grade"] == s]
        bshare = (bs[GRADES].sum() / bs["charge_t"].sum() * 100).round(1)
        by[s] = {
            "share_pct": share.to_dict(), "expert_share_pct": bshare.to_dict(),
            "pred_cu_pct": round(float(g["pred_cu_pct"].mean()), 3),
            "cu_max_pct": float(g["cu_max_pct"].iloc[0]),
            "pred_sn_pct": round(float(g["pred_sn_pct"].mean()), 4),
            "sn_max_pct": float(g["sn_max_pct"].iloc[0]),
            "margin_cu_pct": margins[s]["cu"], "margin_sn_pct": margins[s]["sn"],
            "max_p_fail_pct": round(100 * max(simd[h]["p_fail"] for h in g["heat_id"]), 1),
            "cost_per_t": round(float(g["cost_krw"].sum() / g["tap_t"].sum())),
            "expert_cost_per_t": round(float(bs["cost_krw"].sum() / bs["tap_t"].sum())),
        }
    return {
        "date": ctx["date"],
        "cost_per_t": round(opt["cost_per_t"]),
        "expert_cost_per_t": round(baseline["cost_per_t"]),
        "saving_per_t": round(baseline["cost_per_t"] - opt["cost_per_t"]),
        "iterations": iterations,
        "risky_lots": [f for f in (parsed or {}).get("flags", []) if f["risk"] != "none"],
        "inventory_short": [g for g, r in ctx["scrap"].iterrows() if r["inventory_t"] < 250],
        "by_steel": by,
    }


def _template(f):
    """LLM이 없을 때 쓰는 고정 문장 템플릿"""
    lots = ", ".join(f"{x['lot_id']}({x['reason']})" for x in f["risky_lots"]) or "없음"
    day = (f"{f['date']} 배합 원가 톤당 {f['cost_per_t']:,}원으로 숙련자 배합 대비 톤당 "
           f"{f['saving_per_t']:,}원 절감. 최적화-시뮬레이션 {f['iterations']}회 반복. 위험 로트: {lots}.")
    by = {}
    for s, v in f["by_steel"].items():
        up = [g for g in GRADES if v["share_pct"][g] - v["expert_share_pct"][g] >= 5]
        down = [g for g in GRADES if v["expert_share_pct"][g] - v["share_pct"][g] >= 5]
        by[s] = (f"숙련자 배합 대비 {', '.join(up) or '-'} 비중을 늘리고 {', '.join(down) or '-'} 비중을 줄임. "
                 f"예상 Cu {v['pred_cu_pct']}%(상한 {v['cu_max_pct']}%, 안전여유 {v['margin_cu_pct']:.3f}%p), "
                 f"최악 heat 이탈 확률 {v['max_p_fail_pct']}%.")
    return {"day_summary": day, "by_steel": by}


def write_charge_sheet(ctx, opt, sim, baseline, parsed, margins, iterations, use_llm=None):
    """
    반환: {"date", "summary": {...}, "rationale": {...}, "heats": [heat별 지시서]}
    """
    facts = _facts(ctx, opt, sim, baseline, parsed, margins, iterations)
    if use_llm is None:
        use_llm = llm_available()
    if use_llm:
        rationale = ask_json(SYSTEM, json.dumps(facts, ensure_ascii=False, indent=1), SCHEMA,
                             cache_key=f"sheet_{ctx['date']}")
        rationale["method"] = "llm"
    else:
        rationale = _template(facts) | {"method": "template"}

    simd = {r["heat_id"]: r for r in sim}
    names = ctx["scrap"]["name_kr"].to_dict()
    heats = []
    for _, r in opt["blend"].iterrows():
        s = simd[r["heat_id"]]
        heats.append({
            "heat_id": r["heat_id"], "steel_grade": r["steel_grade"],
            "target_tap_t": float(r["target_tap_t"]),
            "charges": [{"grade_id": g, "name_kr": names[g], "t": round(float(r[g]), 1),
                         "pct": round(float(r[g] / r["charge_t"] * 100), 1)}
                        for g in GRADES if r[g] > 0.05],
            "charge_t": round(float(r["charge_t"]), 1),
            "volume_m3": round(float(r["volume_m3"]), 1),
            "pred_cu_pct": round(float(r["pred_cu_pct"]), 3), "cu_max_pct": float(r["cu_max_pct"]),
            "pred_sn_pct": round(float(r["pred_sn_pct"]), 4), "sn_max_pct": float(r["sn_max_pct"]),
            "p_fail_pct": round(100 * s["p_fail"], 1),
            "cost_per_t": round(float(r["cost_per_t"])),
            "rationale": rationale["by_steel"][r["steel_grade"]],
        })
    return {"date": ctx["date"], "summary": facts, "rationale": rationale, "heats": heats}


def render_text(sheet, max_heats=None):
    """터미널 출력용 지시서 텍스트"""
    f = sheet["summary"]
    lines = [f"■ 배합 지시서 {sheet['date']}  (리본스틸 제강팀, 가상 데이터)",
             f"  톤당 배합 원가 {f['cost_per_t']:,}원 / 숙련자 배합 {f['expert_cost_per_t']:,}원 "
             f"→ 절감 {f['saving_per_t']:,}원/t",
             f"  {sheet['rationale']['day_summary']}", ""]
    for h in sheet["heats"][:max_heats]:
        ch = "  ".join(f"{c['name_kr']} {c['t']}t({c['pct']}%)" for c in h["charges"])
        lines += [f"[{h['heat_id']}] {h['steel_grade']}  목표 출강 {h['target_tap_t']}t  장입 {h['charge_t']}t "
                  f"/ {h['volume_m3']}m3",
                  f"   {ch}",
                  f"   예상 Cu {h['pred_cu_pct']}% (상한 {h['cu_max_pct']}) · Sn {h['pred_sn_pct']}% "
                  f"(상한 {h['sn_max_pct']}) · 이탈확률 {h['p_fail_pct']}% · {h['cost_per_t']:,}원/t",
                  f"   근거: {h['rationale']}", ""]
    return "\n".join(lines)
